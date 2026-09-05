/**
 * SQLite access layer, wrapping node:sqlite's synchronous DatabaseSync.
 *
 * Why synchronous is fine here: this is a single-user local tool whose write
 * path is "one flush batch every 1.5 seconds". The batches run inside one
 * transaction and take microseconds; an async driver would buy nothing and cost
 * us the ability to make ingest atomic without a queue.
 *
 * Three rules run through every function in this file:
 *
 * 1. **Every value is a bound parameter.** Nothing is interpolated into SQL -
 *    not a filter value, not a LIMIT, not an ORDER BY. Sort keys are identifiers
 *    and cannot be bound, so they are looked up in an allowlist and the *stored
 *    constant* is what reaches the query string.
 *
 * 2. **Captures arrive from a web page and are treated as hostile input.** Every
 *    row is validated field by field. A bad row is rejected with a reason and
 *    the rest of the batch still lands, because one malformed capture must not
 *    cost us a flush of good ones.
 *
 * 3. **`ts_server` is the server's clock, always.** `ts_client` is stored
 *    verbatim because it is evidence about the page, but nothing orders,
 *    filters or expires on it. A page can set its clock to anything.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  BodyEncoding,
  CaptureDirection,
  CaptureKind,
  CaptureStats,
  CaptureTransport,
  CollectorIdentity,
  FrameReport,
  HostStat,
  IngestBatch,
  IngestResult,
  ParsePreview,
  RawCapture,
  ShapeStat,
} from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import { topLevelKeys } from '../../shared/shape.ts';
import { migrate, type MigrationReport } from './migrate.ts';
import {
  addNormalizeResults,
  emptyNormalizeResult,
  writeNormalized as writeNormalizedRows,
  type NormalizeResult,
} from './normalize.ts';

/**
 * Bumping this makes every stored capture eligible for re-parsing, which is how
 * an adapter improvement reaches traffic captured weeks ago.
 */
export const PARSER_VERSION = 1;

export interface FeedBetFilter {
  sportsbookId?: string;
  bettorKey?: string;
  type?: string;
  status?: string;
  sport?: string;
  minStake?: number;
  since?: number;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: string;
}

export interface StoredFeedBetLeg {
  idx: number;
  eventKey: string | null;
  sourceEventId: string | null;
  sport: string | null;
  league: string | null;
  eventName: string | null;
  marketName: string | null;
  selectionKey: string | null;
  selectionName: string | null;
  line: number | null;
  oddsAtBet: number | null;
  currentOdds: number | null;
  status: string;
}

export interface StoredFeedBet {
  betKey: string;
  sportsbookId: string;
  sourceBetId: string | null;
  ts: number;
  bettorKey: string;
  bettorLabel: string | null;
  stake: number | null;
  currency: string | null;
  totalOdds: number | null;
  potentialWin: number | null;
  type: string;
  legCount: number;
  status: string;
  firstSeen: number;
  lastSeen: number;
  legs: StoredFeedBetLeg[];
}

export interface FeedBetPage {
  bets: StoredFeedBet[];
  total: number;
  limit: number;
  offset: number;
}

export interface StakeDistribution {
  samples: number;
  currency: string;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/* ------------------------------------------------------------------ *
 * Allowed enum values. These are checked, not trusted.
 * ------------------------------------------------------------------ */

const TRANSPORTS = new Set<CaptureTransport>(['fetch', 'xhr', 'websocket', 'sse', 'dom', 'manual']);
const DIRECTIONS = new Set<CaptureDirection>(['inbound', 'outbound']);
const BODY_ENCODINGS = new Set<BodyEncoding>(['utf8', 'base64']);
const CAPTURE_KINDS = new Set<CaptureKind>([
  'unknown',
  'bets_feed',
  'user_bets',
  'event_list',
  'event_detail',
  'market_list',
  'odds_update',
  'betslip',
  'sport_tree',
  'translation',
  'config',
  'auth',
  'telemetry',
  'asset',
]);

/** Kinds that are traffic we captured but that carry no sportsbook data. */
const NON_DATA_KINDS: readonly CaptureKind[] = ['asset', 'telemetry', 'unknown'];

/**
 * Sort keys the caller may ask for, mapped to the column they mean. The map is
 * the only thing that ever reaches the SQL string, so an unknown key degrades
 * to the default instead of becoming an injection point.
 */
const SORT_COLUMNS: Readonly<Record<string, string>> = {
  ts: 'ts_server',
  ts_server: 'ts_server',
  ts_client: 'ts_client',
  seq: 'seq',
  bytes: 'body_bytes',
  body_bytes: 'body_bytes',
  confidence: 'confidence',
  host: 'url_host',
  kind: 'kind',
};

/** Upper bounds on untrusted strings. Generous, but not unbounded. */
const LIMITS = {
  id: 200,
  url: 8192,
  origin: 2048,
  shortText: 512,
  headersJson: 64_000,
  reasons: 40,
  reasonText: 500,
} as const;

/* ------------------------------------------------------------------ *
 * Small coercion helpers for SQLite's loose output values
 * ------------------------------------------------------------------ */

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
}

function asTextOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/** Integer coercion for COUNT(*) and id columns. */
function asInt(v: unknown): number {
  return Math.trunc(asNumber(v, 0));
}

/** Bounds a caller-supplied limit so a query can never ask for everything. */
function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function asBool(v: unknown): boolean {
  return asNumber(v, 0) !== 0;
}

/** SQLite has no boolean type; store 0/1 explicitly rather than relying on coercion. */
function boolInt(v: unknown): number {
  return v === true ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Escapes a user string for use as a LIKE pattern. Without this, a search for
 * "100%" would silently match everything.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export interface CaptureFilter {
  limit?: number;
  offset?: number;
  kind?: string;
  host?: string;
  transport?: string;
  direction?: string;
  session?: string;
  shape?: string;
  /** Server-clock lower bound, epoch ms, inclusive. */
  since?: number;
  /** Server-clock upper bound, epoch ms, inclusive. */
  until?: number;
  /** Free-text search across url and body. */
  q?: string;
  sort?: string;
  dir?: string;
}

export interface CaptureListPage {
  captures: RawCapture[];
  /** Total matching the filter, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
}

/** One capture the server refused, with the reason a human needs. */
export interface RejectedCapture {
  /** Null when the row did not even carry a usable id. */
  captureId: string | null;
  /** Position in the submitted batch, so the collector can find it. */
  index: number;
  reason: string;
}

/**
 * Richer than the wire-level `IngestResult` (which types `rejected` as a plain
 * count): the reasons are what make a rejection actionable, so they are kept
 * here and flattened into `errors` on the way out.
 */
export interface InsertCapturesResult {
  ok: boolean;
  /** The rows actually stored, with `tsServer` stamped. Safe to broadcast. */
  accepted: RawCapture[];
  duplicates: number;
  rejected: RejectedCapture[];
  errors: string[];
}

export function toIngestResult(result: InsertCapturesResult): IngestResult {
  const out: IngestResult = {
    ok: result.ok,
    accepted: result.accepted.length,
    duplicates: result.duplicates,
    rejected: result.rejected.length,
  };
  const errors = [
    ...result.errors,
    ...result.rejected.map((r) => `capture ${r.captureId ?? `#${r.index}`}: ${r.reason}`),
  ];
  if (errors.length > 0) out.errors = errors;
  return out;
}

export interface FrameOriginStat {
  origin: string;
  /** How many distinct collector sessions reported this origin. */
  sessions: number;
  /** How many frame observations mentioned it. */
  observations: number;
  firstSeen: number;
  lastSeen: number;
  /** True if every observation was same-origin with the top frame. */
  alwaysSameOrigin: boolean;
  /** Shallowest depth it was seen at; 0 is the top frame. */
  minDepth: number;
  /** One example `src`, verbatim. */
  exampleSrc: string;
}

export interface SessionStat {
  sessionId: string;
  collectorKind: string;
  version: string;
  pageOrigin: string;
  frameOrigin: string;
  isTopFrame: boolean;
  firstSeen: number;
  lastSeen: number;
  captures: number;
  dropped: number;
}

export interface OpenDbOptions {
  busyTimeoutMs?: number;
  /** Hard per-capture body cap; a bigger body is rejected, never truncated. */
  maxBodyBytes?: number;
}

/* ------------------------------------------------------------------ *
 * Capture validation
 * ------------------------------------------------------------------ */

interface ValidationContext {
  identity: CollectorIdentity;
  maxBodyBytes: number;
  nowMs: number;
}

type ValidationOutcome = { ok: true; capture: RawCapture } | { ok: false; reason: string; captureId: string | null };

function reject(reason: string, captureId: string | null = null): ValidationOutcome {
  return { ok: false, reason, captureId };
}

/**
 * Validates one submitted capture.
 *
 * The split between "reject" and "coerce" is deliberate: anything that decides
 * *identity* or *routing* (ids, url, transport, direction, size) is rejected
 * when wrong, because storing a row under a fabricated key is worse than losing
 * it. Anything descriptive (headers, status, duration) degrades to null, which
 * is the honest representation of "the collector did not tell us".
 */
export function validateCapture(input: unknown, ctx: ValidationContext): ValidationOutcome {
  if (!isRecord(input)) return reject('not a JSON object');

  const captureId = typeof input['captureId'] === 'string' ? input['captureId'] : null;
  if (!captureId) return reject('captureId is missing or not a string');
  if (captureId.length > LIMITS.id) return reject(`captureId is longer than ${LIMITS.id} characters`, captureId);

  const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : null;
  if (!sessionId) return reject('sessionId is missing or not a string', captureId);
  if (sessionId.length > LIMITS.id) return reject(`sessionId is longer than ${LIMITS.id} characters`, captureId);
  if (sessionId !== ctx.identity.sessionId) {
    // The batch carries exactly one identity, and that identity is the only
    // collector_sessions row we upsert. Accepting a foreign sessionId would
    // either violate the foreign key or force us to invent a session row whose
    // origin and user agent we do not know.
    return reject(
      `sessionId "${sessionId}" does not match the batch identity "${ctx.identity.sessionId}"`,
      captureId,
    );
  }

  const seqRaw = input['seq'];
  if (typeof seqRaw !== 'number' || !Number.isFinite(seqRaw)) {
    return reject('seq is missing or not a finite number', captureId);
  }
  const seq = Math.trunc(seqRaw);

  const tsClientRaw = input['tsClient'];
  if (typeof tsClientRaw !== 'number' || !Number.isFinite(tsClientRaw) || tsClientRaw < 0) {
    return reject('tsClient is missing or not a finite non-negative number', captureId);
  }

  const transport = input['transport'];
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport as CaptureTransport)) {
    return reject(`transport "${String(transport)}" is not one of ${[...TRANSPORTS].join(', ')}`, captureId);
  }

  const direction = input['direction'];
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction as CaptureDirection)) {
    return reject(`direction "${String(direction)}" is not one of ${[...DIRECTIONS].join(', ')}`, captureId);
  }

  const url = typeof input['url'] === 'string' ? input['url'] : null;
  if (url === null) return reject('url is missing or not a string', captureId);
  if (url.length > LIMITS.url) return reject(`url is longer than ${LIMITS.url} characters`, captureId);

  const bodyRaw = input['body'];
  if (bodyRaw !== null && bodyRaw !== undefined && typeof bodyRaw !== 'string') {
    return reject('body must be a string or null', captureId);
  }
  const body = typeof bodyRaw === 'string' ? bodyRaw : null;
  if (body !== null) {
    const bytes = utf8Bytes(body);
    if (bytes > ctx.maxBodyBytes) {
      return reject(`body is ${bytes} bytes, over the server cap of ${ctx.maxBodyBytes}`, captureId);
    }
  }

  const reqBodyRaw = input['reqBody'];
  if (reqBodyRaw !== null && reqBodyRaw !== undefined && typeof reqBodyRaw !== 'string') {
    return reject('reqBody must be a string or null', captureId);
  }
  const reqBody = typeof reqBodyRaw === 'string' ? reqBodyRaw : null;
  if (reqBody !== null && utf8Bytes(reqBody) > ctx.maxBodyBytes) {
    return reject(`reqBody is over the server cap of ${ctx.maxBodyBytes} bytes`, captureId);
  }

  const bodyEncodingRaw = input['bodyEncoding'];
  const bodyEncoding: BodyEncoding =
    typeof bodyEncodingRaw === 'string' && BODY_ENCODINGS.has(bodyEncodingRaw as BodyEncoding)
      ? (bodyEncodingRaw as BodyEncoding)
      : 'utf8';

  // urlHost/urlPath are derived when absent rather than invented: parsing the
  // url the collector already sent is the same information, not a new claim.
  let urlHost = clipString(input['urlHost'], LIMITS.origin);
  let urlPath = clipString(input['urlPath'], LIMITS.url);
  if (urlHost === null || urlPath === null) {
    try {
      const parsed = new URL(url);
      urlHost = urlHost ?? parsed.host;
      urlPath = urlPath ?? parsed.pathname;
    } catch {
      // A relative or opaque url (blob:, data:) has no host we can honestly
      // report. Empty string means "unknown", and the raw url is still stored.
      urlHost = urlHost ?? '';
      urlPath = urlPath ?? '';
    }
  }

  const cls = isRecord(input['classification']) ? input['classification'] : {};
  const kindRaw = cls['kind'];
  const kind: CaptureKind =
    typeof kindRaw === 'string' && CAPTURE_KINDS.has(kindRaw as CaptureKind) ? (kindRaw as CaptureKind) : 'unknown';
  const confidenceRaw = cls['confidence'];
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0;
  const reasons = Array.isArray(cls['reasons'])
    ? cls['reasons']
        .filter((r): r is string => typeof r === 'string')
        .slice(0, LIMITS.reasons)
        .map((r) => r.slice(0, LIMITS.reasonText))
    : [];

  const capture: RawCapture = {
    captureId,
    sessionId,
    seq,
    tsClient: Math.trunc(tsClientRaw),
    tsServer: ctx.nowMs,
    transport: transport as CaptureTransport,
    direction: direction as CaptureDirection,
    frameUrl: clipString(input['frameUrl'], LIMITS.url) ?? '',
    frameOrigin: clipString(input['frameOrigin'], LIMITS.origin) ?? '',
    isTopFrame: input['isTopFrame'] === true,
    pageOrigin: clipString(input['pageOrigin'], LIMITS.origin) ?? '',
    url,
    urlHost,
    urlPath,
    body,
    bodyEncoding,
    bodyBytes:
      typeof input['bodyBytes'] === 'number' && Number.isFinite(input['bodyBytes'])
        ? Math.max(0, Math.trunc(input['bodyBytes']))
        : body === null
          ? 0
          : utf8Bytes(body),
    truncated: input['truncated'] === true,
    redacted: input['redacted'] === true,
    classification: {
      kind,
      confidence,
      adapterId: clipString(cls['adapterId'], LIMITS.shortText) ?? 'unknown',
      reasons,
      shapeFingerprint: clipString(cls['shapeFingerprint'], LIMITS.shortText) ?? '',
    },
  };

  const urlQuery = clipString(input['urlQuery'], LIMITS.url);
  if (urlQuery !== null) capture.urlQuery = urlQuery;
  const method = clipString(input['method'], 32);
  if (method !== null) capture.method = method;
  const contentType = clipString(input['contentType'], LIMITS.shortText);
  if (contentType !== null) capture.contentType = contentType;
  const error = clipString(input['error'], LIMITS.reasonText);
  if (error !== null) capture.error = error;
  const status = asNumberOrNull(input['status']);
  if (status !== null) capture.status = Math.trunc(status);
  const durationMs = asNumberOrNull(input['durationMs']);
  if (durationMs !== null) capture.durationMs = Math.trunc(durationMs);
  if (isRecord(input['reqHeaders'])) capture.reqHeaders = stringHeaders(input['reqHeaders']);
  if (isRecord(input['resHeaders'])) capture.resHeaders = stringHeaders(input['resHeaders']);
  if (reqBody !== null) capture.reqBody = reqBody;

  return { ok: true, capture };
}

function clipString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

function stringHeaders(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n++ >= 100) break;
    out[k.slice(0, 200)] = (typeof v === 'string' ? v : String(v)).slice(0, 2000);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The database wrapper
 * ------------------------------------------------------------------ */

const CAPTURE_COLUMNS = [
  'capture_id',
  'session_id',
  'seq',
  'ts_client',
  'ts_server',
  'transport',
  'direction',
  'frame_url',
  'frame_origin',
  'is_top_frame',
  'page_origin',
  'method',
  'url',
  'url_host',
  'url_path',
  'url_query',
  'status',
  'duration_ms',
  'req_headers',
  'req_body',
  'res_headers',
  'content_type',
  'body',
  'body_encoding',
  'body_bytes',
  'truncated',
  'redacted',
  'error',
  'kind',
  'confidence',
  'adapter_id',
  'reasons',
  'shape_fp',
] as const;

const INSERT_CAPTURE_SQL = `INSERT OR IGNORE INTO raw_captures (${CAPTURE_COLUMNS.join(', ')}) VALUES (${CAPTURE_COLUMNS.map(() => '?').join(', ')})`;

const SELECT_CAPTURE_COLUMNS = `capture_id, session_id, seq, ts_client, ts_server, transport, direction,
  frame_url, frame_origin, is_top_frame, page_origin, method, url, url_host, url_path, url_query,
  status, duration_ms, req_headers, req_body, res_headers, content_type, body, body_encoding,
  body_bytes, truncated, redacted, error, kind, confidence, adapter_id, reasons, shape_fp`;

function rowToCapture(row: Record<string, unknown>): RawCapture {
  const capture: RawCapture = {
    captureId: asText(row['capture_id']),
    sessionId: asText(row['session_id']),
    seq: asNumber(row['seq']),
    tsClient: asNumber(row['ts_client']),
    tsServer: asNumber(row['ts_server']),
    transport: asText(row['transport']) as CaptureTransport,
    direction: asText(row['direction']) as CaptureDirection,
    frameUrl: asText(row['frame_url']),
    frameOrigin: asText(row['frame_origin']),
    isTopFrame: asBool(row['is_top_frame']),
    pageOrigin: asText(row['page_origin']),
    url: asText(row['url']),
    urlHost: asText(row['url_host']),
    urlPath: asText(row['url_path']),
    body: asTextOrNull(row['body']),
    bodyEncoding: (asText(row['body_encoding']) || 'utf8') as BodyEncoding,
    bodyBytes: asNumber(row['body_bytes']),
    truncated: asBool(row['truncated']),
    redacted: asBool(row['redacted']),
    classification: {
      kind: (asText(row['kind']) || 'unknown') as CaptureKind,
      confidence: asNumber(row['confidence']),
      adapterId: asTextOrNull(row['adapter_id']) ?? 'unknown',
      reasons: parseJsonArrayOfStrings(row['reasons']),
      shapeFingerprint: asText(row['shape_fp']),
    },
  };
  const method = asTextOrNull(row['method']);
  if (method !== null) capture.method = method;
  const urlQuery = asTextOrNull(row['url_query']);
  if (urlQuery !== null) capture.urlQuery = urlQuery;
  const status = asNumberOrNull(row['status']);
  if (status !== null) capture.status = status;
  const durationMs = asNumberOrNull(row['duration_ms']);
  if (durationMs !== null) capture.durationMs = durationMs;
  const contentType = asTextOrNull(row['content_type']);
  if (contentType !== null) capture.contentType = contentType;
  const error = asTextOrNull(row['error']);
  if (error !== null) capture.error = error;
  const reqHeaders = parseJsonRecord(row['req_headers']);
  if (reqHeaders) capture.reqHeaders = reqHeaders;
  const resHeaders = parseJsonRecord(row['res_headers']);
  if (resHeaders) capture.resHeaders = resHeaders;
  const reqBody = asTextOrNull(row['req_body']);
  if (reqBody !== null) capture.reqBody = reqBody;
  return capture;
}

function parseJsonArrayOfStrings(v: unknown): string[] {
  if (typeof v !== 'string' || v === '') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(v: unknown): Record<string, string> | null {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (!isRecord(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, value] of Object.entries(parsed)) out[k] = typeof value === 'string' ? value : String(value);
    return out;
  } catch {
    return null;
  }
}

interface WhereClause {
  sql: string;
  params: Array<string | number>;
}

/**
 * Builds the WHERE fragment for a capture filter. Every value is a `?`; the
 * only literals in the returned SQL are column names this module wrote.
 */
function buildWhere(filter: CaptureFilter): WhereClause {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const add = (sql: string, ...values: Array<string | number>): void => {
    clauses.push(sql);
    params.push(...values);
  };

  if (filter.kind) add('kind = ?', filter.kind);
  if (filter.host) add('url_host = ?', filter.host);
  if (filter.transport) add('transport = ?', filter.transport);
  if (filter.direction) add('direction = ?', filter.direction);
  if (filter.session) add('session_id = ?', filter.session);
  if (filter.shape) add('shape_fp = ?', filter.shape);
  if (typeof filter.since === 'number' && Number.isFinite(filter.since)) {
    add('ts_server >= ?', Math.trunc(filter.since));
  }
  if (typeof filter.until === 'number' && Number.isFinite(filter.until)) {
    add('ts_server <= ?', Math.trunc(filter.until));
  }
  if (filter.q) {
    // Body search is a full scan by design. There is no full-text index at
    // Milestone 1 and adding one would mean deciding how to tokenise payloads
    // we have not seen yet.
    const pattern = likePattern(filter.q);
    add("(url LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')", pattern, pattern);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function resolveSort(filter: CaptureFilter): { column: string; direction: 'ASC' | 'DESC' } {
  const column = SORT_COLUMNS[filter.sort ?? ''] ?? 'ts_server';
  const direction = (filter.dir ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return { column, direction };
}

export class ScoutDb {
  readonly path: string;
  readonly migration: MigrationReport;
  private readonly db: DatabaseSync;
  private readonly maxBodyBytes: number;
  private closed = false;

  constructor(path: string, opts: OpenDbOptions = {}) {
    this.path = path;
    this.maxBodyBytes = opts.maxBodyBytes ?? 2_000_000;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migration = migrate(this.db, { busyTimeoutMs: opts.busyTimeoutMs ?? 5000 });
  }

  get schemaVersion(): number {
    return this.migration.schemaVersion;
  }

  /**
   * The raw handle, for read-only query modules that deliberately do not depend
   * on this class - see db/analysis-queries.ts - plus tests and one-off
   * inspection. Nothing outside this file writes through it.
   */
  get handle(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Checkpoint so a WAL file left behind does not hold recent captures
      // outside the main database file.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Not fatal: a non-WAL journal simply has nothing to checkpoint.
    }
    this.db.close();
  }

  /* ---------------- meta ---------------- */

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? asTextOrNull(row['value']) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /* ---------------- ingest ---------------- */

  /**
   * Stores a flush batch.
   *
   * Idempotent by construction: `INSERT OR IGNORE` on the primary key means a
   * replayed batch (the collector retries after a timeout it never saw the
   * answer to) counts as duplicates, not as errors and not as new rows. The
   * whole batch runs in one transaction so a crash mid-batch leaves nothing
   * half-written.
   */
  insertCaptures(batch: IngestBatch, nowMs: number): InsertCapturesResult {
    const errors: string[] = [];
    const rejected: RejectedCapture[] = [];
    const accepted: RawCapture[] = [];
    let duplicates = 0;

    const identity = batch.identity;
    const captures = Array.isArray(batch.captures) ? batch.captures : [];

    // Validate outside the transaction: validation cannot fail the write, and
    // keeping the transaction short matters when a live feed is flushing.
    const validated: RawCapture[] = [];
    for (let i = 0; i < captures.length; i++) {
      const outcome = validateCapture(captures[i], { identity, maxBodyBytes: this.maxBodyBytes, nowMs });
      if (outcome.ok) validated.push(outcome.capture);
      else rejected.push({ captureId: outcome.captureId, index: i, reason: outcome.reason });
    }

    const dropped = typeof batch.dropped === 'number' && Number.isFinite(batch.dropped) ? Math.max(0, Math.trunc(batch.dropped)) : 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsertSession(identity, nowMs, dropped);

      const insert = this.db.prepare(INSERT_CAPTURE_SQL);
      for (const capture of validated) {
        const result = insert.run(
          capture.captureId,
          capture.sessionId,
          capture.seq,
          capture.tsClient,
          nowMs,
          capture.transport,
          capture.direction,
          capture.frameUrl,
          capture.frameOrigin,
          boolInt(capture.isTopFrame),
          capture.pageOrigin,
          capture.method ?? null,
          capture.url,
          capture.urlHost,
          capture.urlPath,
          capture.urlQuery ?? null,
          capture.status ?? null,
          capture.durationMs ?? null,
          capture.reqHeaders ? JSON.stringify(capture.reqHeaders).slice(0, LIMITS.headersJson) : null,
          capture.reqBody ?? null,
          capture.resHeaders ? JSON.stringify(capture.resHeaders).slice(0, LIMITS.headersJson) : null,
          capture.contentType ?? null,
          capture.body,
          capture.bodyEncoding,
          capture.bodyBytes,
          boolInt(capture.truncated),
          boolInt(capture.redacted),
          capture.error ?? null,
          capture.classification.kind,
          capture.classification.confidence,
          capture.classification.adapterId,
          JSON.stringify(capture.classification.reasons),
          capture.classification.shapeFingerprint,
        );
        if (Number(result.changes) > 0) accepted.push(capture);
        else duplicates += 1;
      }

      if (accepted.length > 0) {
        this.db
          .prepare('UPDATE collector_sessions SET captures = captures + ?, last_seen = ? WHERE session_id = ?')
          .run(accepted.length, nowMs, identity.sessionId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A rollback failure means the transaction was already closed; the
        // original error below is the one worth reporting.
      }
      errors.push(err instanceof Error ? err.message : String(err));
      return { ok: false, accepted: [], duplicates: 0, rejected, errors };
    }

    return { ok: rejected.length === 0, accepted, duplicates, rejected, errors };
  }

  private upsertSession(identity: CollectorIdentity, nowMs: number, dropped: number): void {
    this.db
      .prepare(
        `INSERT INTO collector_sessions
           (session_id, collector_kind, version, page_origin, frame_origin, is_top_frame, user_agent, first_seen, last_seen, captures, dropped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           collector_kind = excluded.collector_kind,
           version = excluded.version,
           page_origin = excluded.page_origin,
           frame_origin = excluded.frame_origin,
           is_top_frame = excluded.is_top_frame,
           user_agent = excluded.user_agent,
           -- IngestBatch.dropped is read as "dropped since the last flush", so
           -- it accumulates. If a collector ever sends a running total instead,
           -- this over-counts - which is visible and fixable, where silently
           -- taking the max would hide real drops.
           dropped = collector_sessions.dropped + excluded.dropped`,
      )
      .run(
        identity.sessionId,
        clipString(identity.kind, 32) ?? 'unknown',
        clipString(identity.version, 64) ?? '',
        clipString(identity.pageOrigin, LIMITS.origin) ?? '',
        clipString(identity.frameOrigin, LIMITS.origin) ?? '',
        boolInt(identity.isTopFrame),
        clipString(identity.userAgent, 1024),
        nowMs,
        nowMs,
        dropped,
      );
  }

  /* ---------------- frames ---------------- */

  /**
   * Records an iframe-origin report.
   *
   * `ts` is the server clock, not the page's: this table is the host-discovery
   * record and it has to be orderable against the captures around it.
   * Re-reporting the same frame within a session is a no-op, so a collector
   * that walks the frame tree on every mutation cannot grow the table without
   * bound.
   */
  insertFrames(report: FrameReport, nowMs: number): { inserted: number; skipped: number } {
    const frames = Array.isArray(report.frames) ? report.frames : [];
    const sessionId = clipString(report.sessionId, LIMITS.id) ?? '';
    const topOrigin = clipString(report.topOrigin, LIMITS.origin) ?? '';
    let inserted = 0;
    let skipped = 0;

    const stmt = this.db.prepare(
      `INSERT INTO observed_frames (session_id, ts, top_origin, frame_origin, frame_src, depth, same_origin)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM observed_frames
         WHERE session_id = ? AND frame_origin = ? AND frame_src = ? AND depth = ?
       )`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const frame of frames) {
        if (!isRecord(frame)) {
          skipped += 1;
          continue;
        }
        const origin = clipString(frame['origin'], LIMITS.origin);
        const src = clipString(frame['src'], LIMITS.url);
        if (origin === null && src === null) {
          skipped += 1;
          continue;
        }
        const depth = Math.max(0, Math.trunc(asNumber(frame['depth'], 0)));
        const originValue = origin ?? '';
        const srcValue = src ?? '';
        const result = stmt.run(
          sessionId,
          nowMs,
          topOrigin,
          originValue,
          srcValue,
          depth,
          boolInt(frame['sameOrigin']),
          sessionId,
          originValue,
          srcValue,
          depth,
        );
        if (Number(result.changes) > 0) inserted += 1;
        else skipped += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already closed */
      }
      throw err;
    }
    return { inserted, skipped };
  }

  /** Distinct iframe origins the collector has reported, most recent first. */
  listFrameOrigins(): FrameOriginStat[] {
    const rows = this.db
      .prepare(
        `SELECT frame_origin AS origin,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(*) AS observations,
                MIN(ts) AS first_seen,
                MAX(ts) AS last_seen,
                MIN(same_origin) AS all_same_origin,
                MIN(depth) AS min_depth,
                MAX(frame_src) AS example_src
         FROM observed_frames
         GROUP BY frame_origin
         ORDER BY last_seen DESC, observations DESC`,
      )
      .all();
    return rows.map((row) => ({
      origin: asText(row['origin']),
      sessions: asNumber(row['sessions']),
      observations: asNumber(row['observations']),
      firstSeen: asNumber(row['first_seen']),
      lastSeen: asNumber(row['last_seen']),
      alwaysSameOrigin: asBool(row['all_same_origin']),
      minDepth: asNumber(row['min_depth']),
      exampleSrc: asText(row['example_src']),
    }));
  }

  /**
   * Reconstructs the reports as they were submitted, newest first. Grouping is
   * by (session, ts) because that pair is exactly one frame walk.
   */
  listFrameReports(limit = 50): FrameReport[] {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 500);
    const groups = this.db
      .prepare(
        `SELECT session_id, ts, top_origin
         FROM observed_frames
         GROUP BY session_id, ts, top_origin
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(safeLimit);

    const frameStmt = this.db.prepare(
      `SELECT frame_src, frame_origin, depth, same_origin
       FROM observed_frames
       WHERE session_id = ? AND ts = ?
       ORDER BY depth ASC, id ASC`,
    );

    return groups.map((group) => {
      const sessionId = asText(group['session_id']);
      const ts = asNumber(group['ts']);
      const frames = frameStmt.all(sessionId, ts).map((row) => ({
        src: asText(row['frame_src']),
        origin: asText(row['frame_origin']),
        depth: asNumber(row['depth']),
        sameOrigin: asBool(row['same_origin']),
      }));
      return { sessionId, ts, topOrigin: asText(group['top_origin']), frames };
    });
  }

  /* ---------------- reads ---------------- */

  listCaptures(filter: CaptureFilter = {}): CaptureListPage {
    const where = buildWhere(filter);
    const sort = resolveSort(filter);
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 100)), 1000);
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM raw_captures ${where.sql}`).get(...where.params);
    const total = asNumber(totalRow?.['n']);

    // `sort.column` and the direction come from SORT_COLUMNS, never from the
    // request string, so this template contains only values this file wrote.
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_CAPTURE_COLUMNS} FROM raw_captures ${where.sql}
         ORDER BY ${sort.column} ${sort.direction}, capture_id ${sort.direction}
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset);

    return { captures: rows.map(rowToCapture), total, limit, offset };
  }

  getCapture(captureId: string): RawCapture | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_CAPTURE_COLUMNS} FROM raw_captures WHERE capture_id = ?`)
      .get(captureId);
    return row ? rowToCapture(row) : null;
  }

  /**
   * Streams every capture matching a filter, oldest-relevant page at a time.
   *
   * Keyset pagination rather than LIMIT/OFFSET: OFFSET makes the exporter
   * quadratic (SQLite re-walks and discards every skipped row), which turns a
   * 200k-row export into minutes of CPU. The cursor is (ts_server, capture_id)
   * descending, which is unique because capture_id is the primary key.
   *
   * Yielding page by page also means the HTTP response can apply backpressure:
   * we never hold more than `pageSize` rows in memory.
   */
  *streamCaptures(filter: CaptureFilter = {}, pageSize = 200): Generator<RawCapture> {
    const where = buildWhere(filter);
    const size = Math.min(Math.max(1, Math.trunc(pageSize)), 1000);
    let cursorTs: number | null = null;
    let cursorId: string | null = null;
    let emitted = 0;
    const hardLimit =
      typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
        ? Math.trunc(filter.limit)
        : Number.POSITIVE_INFINITY;

    const firstPage = this.db.prepare(
      `SELECT ${SELECT_CAPTURE_COLUMNS} FROM raw_captures ${where.sql}
       ORDER BY ts_server DESC, capture_id DESC LIMIT ?`,
    );
    const nextPage = this.db.prepare(
      `SELECT ${SELECT_CAPTURE_COLUMNS} FROM raw_captures
       ${where.sql ? `${where.sql} AND` : 'WHERE'} (ts_server < ? OR (ts_server = ? AND capture_id < ?))
       ORDER BY ts_server DESC, capture_id DESC LIMIT ?`,
    );

    for (;;) {
      const rows =
        cursorTs === null || cursorId === null
          ? firstPage.all(...where.params, size)
          : nextPage.all(...where.params, cursorTs, cursorTs, cursorId, size);
      if (rows.length === 0) return;
      for (const row of rows) {
        const capture = rowToCapture(row);
        yield capture;
        emitted += 1;
        if (emitted >= hardLimit) return;
        cursorTs = capture.tsServer ?? 0;
        cursorId = capture.captureId;
      }
      if (rows.length < size) return;
    }
  }

  /* ---------------- discovery views ---------------- */

  /**
   * Hosts ranked by **data-likeness**, not by volume.
   *
   * This ranking is the point of the whole discovery loop: the user needs to
   * find which host actually serves the BETBY payloads among the dozens a
   * sportsbook page talks to. Sorting by capture count would put a CDN serving
   * 400 images at the top and bury the one host that answered with a bets feed.
   *
   * The order is, explicitly:
   *   1. `dataCaptures` desc - captures classified as something other than
   *      asset/telemetry/unknown *and* at or above MIN_CLASSIFY_CONFIDENCE.
   *      A host that produced even one confident data classification outranks
   *      any host that produced none.
   *   2. `bestConfidence` desc - among hosts with no confident classification,
   *      the one we came closest on is the better lead.
   *   3. `dataBytes` desc - bytes that were not classified as assets. Big JSON
   *      is more interesting than big images.
   *   4. `captures` desc, then host name, so the order is stable between calls.
   */
  hosts(): HostStat[] {
    const nonData = NON_DATA_KINDS;
    const rows = this.db
      .prepare(
        `SELECT url_host AS host,
                COUNT(*) AS captures,
                COALESCE(SUM(body_bytes), 0) AS bytes,
                MIN(ts_server) AS first_seen,
                MAX(ts_server) AS last_seen,
                COALESCE(MAX(confidence), 0) AS best_confidence,
                SUM(CASE WHEN kind NOT IN (?, ?, ?) AND confidence >= ? THEN 1 ELSE 0 END) AS data_captures,
                COALESCE(SUM(CASE WHEN kind NOT IN (?, ?, ?) THEN body_bytes ELSE 0 END), 0) AS data_bytes
         FROM raw_captures
         GROUP BY url_host
         ORDER BY data_captures DESC, best_confidence DESC, data_bytes DESC, captures DESC, host ASC`,
      )
      .all(
        nonData[0] ?? 'asset',
        nonData[1] ?? 'telemetry',
        nonData[2] ?? 'unknown',
        MIN_CLASSIFY_CONFIDENCE,
        nonData[0] ?? 'asset',
        nonData[1] ?? 'telemetry',
        nonData[2] ?? 'unknown',
      );

    const kindRows = this.db
      .prepare('SELECT url_host AS host, kind, COUNT(*) AS n FROM raw_captures GROUP BY url_host, kind')
      .all();
    const kindsByHost = new Map<string, Partial<Record<CaptureKind, number>>>();
    for (const row of kindRows) {
      const host = asText(row['host']);
      const kind = asText(row['kind']) as CaptureKind;
      const entry = kindsByHost.get(host) ?? {};
      entry[kind] = asNumber(row['n']);
      kindsByHost.set(host, entry);
    }

    return rows.map((row) => {
      const host = asText(row['host']);
      return {
        host,
        captures: asNumber(row['captures']),
        bytes: asNumber(row['bytes']),
        firstSeen: asNumber(row['first_seen']),
        lastSeen: asNumber(row['last_seen']),
        kinds: kindsByHost.get(host) ?? {},
        bestConfidence: asNumber(row['best_confidence']),
      };
    });
  }

  /**
   * Clusters of identical payload shape, biggest cluster first.
   *
   * This is the "what is all this unknown traffic" view: two responses from the
   * same endpoint share a shape fingerprint even though their values differ, so
   * a hundred captures collapse into a handful of clusters a human can actually
   * inspect one representative at a time.
   */
  shapes(limit = 100): ShapeStat[] {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 500);
    const groups = this.db
      .prepare(
        `SELECT shape_fp,
                COUNT(*) AS n,
                MIN(ts_server) AS first_seen,
                MAX(ts_server) AS last_seen
         FROM raw_captures
         WHERE shape_fp <> ''
         GROUP BY shape_fp
         ORDER BY n DESC, last_seen DESC
         LIMIT ?`,
      )
      .all(safeLimit);

    // The representative is the most confident, most recent member of the
    // cluster: that is the row whose body is most likely to be readable.
    const exemplar = this.db.prepare(
      `SELECT capture_id, kind, confidence, url_host, url_path, body, body_encoding
       FROM raw_captures
       WHERE shape_fp = ?
       ORDER BY confidence DESC, ts_server DESC
       LIMIT 1`,
    );

    const out: ShapeStat[] = [];
    for (const group of groups) {
      const fingerprint = asText(group['shape_fp']);
      const row = exemplar.get(fingerprint);
      if (!row) continue;
      out.push({
        shapeFingerprint: fingerprint,
        count: asNumber(group['n']),
        kind: (asText(row['kind']) || 'unknown') as CaptureKind,
        confidence: asNumber(row['confidence']),
        exampleCaptureId: asText(row['capture_id']),
        host: asText(row['url_host']),
        path: asText(row['url_path']),
        firstSeen: asNumber(group['first_seen']),
        lastSeen: asNumber(group['last_seen']),
        keys: keysOfBody(asTextOrNull(row['body']), asText(row['body_encoding'])),
      });
    }
    return out;
  }

  stats(): CaptureStats {
    const totals = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(body_bytes), 0) AS bytes, MAX(ts_server) AS last_ts FROM raw_captures').get();
    const sessions = this.db.prepare('SELECT COUNT(*) AS n FROM collector_sessions').get();
    const byKindRows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM raw_captures GROUP BY kind').all();
    const byTransportRows = this.db.prepare('SELECT transport, COUNT(*) AS n FROM raw_captures GROUP BY transport').all();

    const byKind: Partial<Record<CaptureKind, number>> = {};
    for (const row of byKindRows) byKind[asText(row['kind']) as CaptureKind] = asNumber(row['n']);
    const byTransport: Partial<Record<CaptureTransport, number>> = {};
    for (const row of byTransportRows) byTransport[asText(row['transport']) as CaptureTransport] = asNumber(row['n']);

    return {
      total: asNumber(totals?.['n']),
      bytes: asNumber(totals?.['bytes']),
      sessions: asNumber(sessions?.['n']),
      byKind,
      byTransport,
      hosts: this.hosts(),
      lastCaptureTs: asNumberOrNull(totals?.['last_ts']),
      serverTime: Date.now(),
    };
  }

  sessions(): SessionStat[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, collector_kind, version, page_origin, frame_origin, is_top_frame,
                first_seen, last_seen, captures, dropped
         FROM collector_sessions ORDER BY last_seen DESC LIMIT 500`,
      )
      .all();
    return rows.map((row) => ({
      sessionId: asText(row['session_id']),
      collectorKind: asText(row['collector_kind']),
      version: asText(row['version']),
      pageOrigin: asText(row['page_origin']),
      frameOrigin: asText(row['frame_origin']),
      isTopFrame: asBool(row['is_top_frame']),
      firstSeen: asNumber(row['first_seen']),
      lastSeen: asNumber(row['last_seen']),
      captures: asNumber(row['captures']),
      dropped: asNumber(row['dropped']),
    }));
  }

  /* ---------------- retention ---------------- */

  /**
   * Deletes captures older than `days`. Opt-in only: 0 means keep forever and
   * that is the default, because CONTRACT.md rule 6 makes history append-only
   * and a deleted capture cannot be re-parsed by a better adapter later.
   */
  /* ---------------- normalized entities ---------------- */

  /**
   * Persists a batch of parsed captures in one transaction.
   *
   * Batched deliberately: one bets-feed poll yields 50 bets with ~90 legs, and
   * committing each row separately turns one fsync into a hundred. The batch is
   * atomic, so a crash mid-write leaves no half-stored bet.
   */
  writeNormalized(
    entries: ReadonlyArray<{ preview: ParsePreview; capture: RawCapture; observedAt: number }>,
  ): NormalizeResult {
    const total = emptyNormalizeResult();
    if (entries.length === 0) return total;

    this.db.exec('BEGIN');
    try {
      for (const entry of entries) {
        addNormalizeResults(total, writeNormalizedRows(this.db, entry.preview, entry.capture, entry.observedAt));
        this.markParsed(entry.capture.captureId, entry.observedAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return total;
  }

  /** Records that a capture has been through the current parser. */
  private markParsed(captureId: string, nowMs: number): void {
    this.db
      .prepare('UPDATE raw_captures SET parsed_at = ?, parser_version = ? WHERE capture_id = ?')
      .run(nowMs, PARSER_VERSION, captureId);
  }

  /** Captures the current parser has never seen. Drives the backfill. */
  unparsedCaptures(limit = 500): RawCapture[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM raw_captures WHERE parsed_at IS NULL OR parser_version < ? ORDER BY ts_server ASC LIMIT ?',
      )
      .all(PARSER_VERSION, clampInt(limit, 1, 5000));
    return rows.map((r) => rowToCapture(r));
  }

  listFeedBets(filter: FeedBetFilter = {}): FeedBetPage {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.sportsbookId) {
      where.push('b.sportsbook_id = ?');
      params.push(filter.sportsbookId);
    }
    if (filter.bettorKey) {
      where.push('b.bettor_key = ?');
      params.push(filter.bettorKey);
    }
    if (filter.type) {
      where.push('b.type = ?');
      params.push(filter.type);
    }
    if (filter.status) {
      where.push('b.status = ?');
      params.push(filter.status);
    }
    if (typeof filter.minStake === 'number') {
      where.push('b.stake >= ?');
      params.push(filter.minStake);
    }
    if (typeof filter.since === 'number') {
      where.push('b.ts >= ?');
      params.push(filter.since);
    }
    if (filter.sport) {
      where.push('EXISTS (SELECT 1 FROM feed_bet_legs l WHERE l.bet_key = b.bet_key AND l.sport = ?)');
      params.push(filter.sport);
    }
    if (filter.q) {
      where.push(
        'EXISTS (SELECT 1 FROM feed_bet_legs l WHERE l.bet_key = b.bet_key AND (l.event_name LIKE ? OR l.selection_name LIKE ? OR l.league LIKE ?))',
      );
      const like = '%' + filter.q + '%';
      params.push(like, like, like);
    }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countRow = this.db.prepare('SELECT COUNT(*) AS n FROM feed_bets b ' + clause).get(...params) ?? {};
    const total = asInt(countRow['n']);

    const limit = clampInt(filter.limit ?? 100, 1, 500);
    const offset = Math.max(0, filter.offset ?? 0);
    // Sort key chosen from a fixed set - never interpolated from user input.
    const sort = filter.sort === 'stake' ? 'b.stake' : filter.sort === 'odds' ? 'b.total_odds' : 'b.ts';
    const dir = filter.dir === 'asc' ? 'ASC' : 'DESC';

    const rows = this.db
      .prepare(
        'SELECT b.*, t.label AS bettor_label FROM feed_bets b LEFT JOIN bettors t ON t.bettor_key = b.bettor_key ' +
          clause +
          ' ORDER BY ' +
          sort +
          ' ' +
          dir +
          ' LIMIT ? OFFSET ?',
      )
      .all(...params, limit, offset);

    return { bets: rows.map((r) => this.hydrateBet(r)), total, limit, offset };
  }

  private hydrateBet(row: Record<string, unknown>): StoredFeedBet {
    const betKey = asText(row['bet_key']);
    const legs = this.db
      .prepare('SELECT * FROM feed_bet_legs WHERE bet_key = ? ORDER BY idx ASC')
      .all(betKey)
      .map((l) => ({
        idx: asInt(l['idx']),
        eventKey: asTextOrNull(l['event_key']),
        sourceEventId: asTextOrNull(l['source_event_id']),
        sport: asTextOrNull(l['sport']),
        league: asTextOrNull(l['league']),
        eventName: asTextOrNull(l['event_name']),
        marketName: asTextOrNull(l['market_name']),
        selectionKey: asTextOrNull(l['selection_key']),
        selectionName: asTextOrNull(l['selection_name']),
        line: asNumberOrNull(l['line']),
        oddsAtBet: asNumberOrNull(l['odds_at_bet']),
        currentOdds: asNumberOrNull(l['current_odds']),
        status: asText(l['status'] ?? 'unknown'),
      }));

    return {
      betKey,
      sportsbookId: asText(row['sportsbook_id']),
      sourceBetId: asTextOrNull(row['source_bet_id']),
      ts: asInt(row['ts']),
      bettorKey: asText(row['bettor_key']),
      bettorLabel: asTextOrNull(row['bettor_label']),
      stake: asNumberOrNull(row['stake']),
      currency: asTextOrNull(row['currency']),
      totalOdds: asNumberOrNull(row['total_odds']),
      potentialWin: asNumberOrNull(row['potential_win']),
      type: asText(row['type'] ?? 'unknown'),
      legCount: asInt(row['leg_count']),
      status: asText(row['status'] ?? 'unknown'),
      firstSeen: asInt(row['first_seen']),
      lastSeen: asInt(row['last_seen']),
      legs,
    };
  }

  /**
   * Stake distribution over a window, so the UI can say how unusual a stake is.
   *
   * Reported as percentiles and a sample count, never as a verdict. A big bet is
   * a fact; "big bet therefore good bet" is the single most seductive error this
   * project exists to avoid.
   *
   * USD only, deliberately: without an FX rate, mixing currencies would rank a
   * 5000 INR stake alongside a 5000 USD one and call both whales.
   */
  stakeDistribution(sportsbookId: string, sinceMs: number): StakeDistribution | null {
    const values = this.db
      .prepare(
        "SELECT stake FROM feed_bets WHERE sportsbook_id = ? AND ts >= ? AND stake IS NOT NULL AND currency = 'USD' ORDER BY stake ASC",
      )
      .all(sportsbookId, sinceMs)
      .map((r) => asNumberOrNull(r['stake']))
      .filter((n): n is number => n !== null);

    if (values.length === 0) return null;
    const at = (p: number): number =>
      values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))] ?? 0;
    return {
      samples: values.length,
      currency: 'USD',
      min: values[0] ?? 0,
      p50: at(50),
      p90: at(90),
      p99: at(99),
      max: values[values.length - 1] ?? 0,
    };
  }

  normalizedCounts(): Record<string, number> {
    // Fixed list - a table name never comes from a caller.
    const tables = ['events', 'markets', 'selections', 'odds_snapshots', 'bettors', 'feed_bets', 'feed_bet_legs'];
    const out: Record<string, number> = {};
    for (const t of tables) {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM ' + t).get() ?? {};
      out[t] = asInt(row['n']);
    }
    return out;
  }

  pruneCaptures(days: number, nowMs: number): { deleted: number; cutoff: number } {
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0, cutoff: 0 };
    const cutoff = nowMs - Math.trunc(days) * 86_400_000;
    const result = this.db.prepare('DELETE FROM raw_captures WHERE ts_server < ?').run(cutoff);
    return { deleted: Number(result.changes), cutoff };
  }
}

/**
 * Reads the top-level key names of a capture body for the shape-cluster view.
 * A body we cannot parse yields no keys - that is the honest answer, and the
 * cluster is still listed with its fingerprint and count.
 */
function keysOfBody(body: string | null, encoding: string): string[] {
  if (body === null || encoding === 'base64') return [];
  try {
    return topLevelKeys(JSON.parse(body) as unknown);
  } catch {
    return [];
  }
}

export function openDb(path: string, opts: OpenDbOptions = {}): ScoutDb {
  return new ScoutDb(path, opts);
}
