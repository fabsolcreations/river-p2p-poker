/**
 * Typed wrappers over the Scout server's REST surface (CONTRACT.md, "Server API").
 *
 * Two deliberate design choices:
 *
 * 1. **Relative URLs.** In development Vite proxies `/api` and `/ws` to
 *    127.0.0.1:8787; in a built bundle the server serves the SPA itself. Both
 *    cases are same-origin, so hard-coding a host would only create a way for
 *    the two to disagree.
 *
 * 2. **Tolerant response coercion.** CONTRACT.md fixes the *paths* and the
 *    domain types but not the envelope each route wraps them in (an array vs
 *    `{ captures, total }`). Rather than guess and render a blank page when the
 *    guess is wrong, every reader accepts the plausible envelopes, validates
 *    structurally, and reports what it could not read. A row that fails
 *    validation is dropped and counted - never patched up with defaults, since
 *    a capture with an invented `url` is worse than a missing capture.
 */

import type {
  CaptureKind,
  CaptureStats,
  CaptureTransport,
  CollectorConfig,
  FrameReport,
  HostStat,
  ParsePreview,
  RawCapture,
  ShapeStat,
} from '../../shared/types.ts';
import { DEFAULT_COLLECTOR_CONFIG } from '../../shared/types.ts';
import { pick } from '../../shared/shape.ts';
import { isValidDecimalOdds } from '../../shared/odds.ts';
import type { LineMovement, MovementKind } from '../../analysis/types.ts';
// MarginSummary is declared beside the summarizer that produces it, in
// analysis/fair.ts, not in analysis/types.ts. Importing it from where it
// actually lives means a rename there breaks this build rather than silently
// leaving the dashboard reading a field the server stopped sending.
import type { MarginSummary } from '../../analysis/fair.ts';

export const API_BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodyText: string;

  constructor(url: string, status: number, bodyText: string) {
    super(status === 0 ? `Cannot reach the Scout server (${url})` : `${status} from ${url}`);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.bodyText = bodyText;
  }

  /** True when the server answered but does not implement this route. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** True when nothing answered at all - almost always "server not running". */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // A network-level failure has no status; status 0 is our marker for it.
    throw new ApiError(url, 0, err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  if (!res.ok) throw new ApiError(url, res.status, text.slice(0, 2000));
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(url, res.status, `Response was not JSON: ${text.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Envelope handling
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Finds the array in a response whether it arrived bare or wrapped. Checks the
 * named keys first, then falls back to the single array-valued property, which
 * covers an envelope key we did not anticipate without ever inventing rows.
 */
function unwrapArray(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = pick(payload, key);
    if (Array.isArray(value)) return value;
  }
  const arrays = Object.values(payload).filter(Array.isArray);
  return arrays.length === 1 && arrays[0] ? arrays[0] : [];
}

function unwrapTotal(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const value = pick(payload, 'total', 'count', 'totalCount');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Structural validation of one capture row. Only the fields the dashboard
 * actually keys on are required; everything else degrades to a safe absent
 * value of the right type. Returns null when the row is unusable.
 */
export function coerceCapture(raw: unknown): RawCapture | null {
  if (!isRecord(raw)) return null;
  const captureId = str(raw['captureId']);
  const url = str(raw['url']);
  if (!captureId || url === null) return null;

  const cls = isRecord(raw['classification']) ? raw['classification'] : {};
  const reasons = Array.isArray(cls['reasons']) ? cls['reasons'].filter((r): r is string => typeof r === 'string') : [];

  const capture: RawCapture = {
    captureId,
    sessionId: str(raw['sessionId']) ?? '',
    seq: num(raw['seq']) ?? 0,
    tsClient: num(raw['tsClient']) ?? 0,
    transport: (str(raw['transport']) ?? 'manual') as CaptureTransport,
    direction: raw['direction'] === 'outbound' ? 'outbound' : 'inbound',
    frameUrl: str(raw['frameUrl']) ?? '',
    frameOrigin: str(raw['frameOrigin']) ?? '',
    isTopFrame: raw['isTopFrame'] === true,
    pageOrigin: str(raw['pageOrigin']) ?? '',
    url,
    urlHost: str(raw['urlHost']) ?? '',
    urlPath: str(raw['urlPath']) ?? '',
    body: typeof raw['body'] === 'string' ? raw['body'] : null,
    bodyEncoding: raw['bodyEncoding'] === 'base64' ? 'base64' : 'utf8',
    bodyBytes: num(raw['bodyBytes']) ?? 0,
    truncated: raw['truncated'] === true,
    redacted: raw['redacted'] === true,
    classification: {
      kind: (str(cls['kind']) ?? 'unknown') as CaptureKind,
      confidence: num(cls['confidence']) ?? 0,
      adapterId: str(cls['adapterId']) ?? 'unknown',
      reasons,
      shapeFingerprint: str(cls['shapeFingerprint']) ?? '',
    },
  };

  // Optional fields are only attached when genuinely present, so `undefined`
  // keeps meaning "the payload did not carry this".
  const tsServer = num(raw['tsServer']);
  if (tsServer !== null) capture.tsServer = tsServer;
  const method = str(raw['method']);
  if (method !== null) capture.method = method;
  const urlQuery = str(raw['urlQuery']);
  if (urlQuery !== null) capture.urlQuery = urlQuery;
  const status = num(raw['status']);
  if (status !== null) capture.status = status;
  const durationMs = num(raw['durationMs']);
  if (durationMs !== null) capture.durationMs = durationMs;
  const contentType = str(raw['contentType']);
  if (contentType !== null) capture.contentType = contentType;
  const error = str(raw['error']);
  if (error !== null) capture.error = error;
  if (isRecord(raw['reqHeaders'])) capture.reqHeaders = stringMap(raw['reqHeaders']);
  if (isRecord(raw['resHeaders'])) capture.resHeaders = stringMap(raw['resHeaders']);
  if (typeof raw['reqBody'] === 'string' || raw['reqBody'] === null) {
    capture.reqBody = raw['reqBody'] as string | null;
  }

  return capture;
}

function stringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? v : String(v);
  return out;
}

/* ------------------------------------------------------------------ *
 * Captures
 * ------------------------------------------------------------------ */

export interface CaptureFilters {
  limit?: number;
  offset?: number;
  kind?: CaptureKind | '';
  host?: string;
  transport?: CaptureTransport | '';
  session?: string;
  shape?: string;
  since?: number;
  q?: string;
}

/** Serialises filters exactly as CONTRACT.md names them. Empties are omitted. */
export function filterParams(filters: CaptureFilters): URLSearchParams {
  const params = new URLSearchParams();
  const add = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === '' || value === null) return;
    params.set(key, String(value));
  };
  add('limit', filters.limit);
  add('offset', filters.offset);
  add('kind', filters.kind);
  add('host', filters.host);
  add('transport', filters.transport);
  add('session', filters.session);
  add('shape', filters.shape);
  add('since', filters.since);
  add('q', filters.q);
  return params;
}

export interface CaptureListResult {
  captures: RawCapture[];
  /** Server-reported total when the envelope carries one, else null. */
  total: number | null;
  /** Rows the server sent that failed structural validation. Never hidden. */
  malformed: number;
}

export async function listCaptures(filters: CaptureFilters = {}): Promise<CaptureListResult> {
  const query = filterParams(filters).toString();
  const payload = await request(`/captures${query ? `?${query}` : ''}`);
  const rows = unwrapArray(payload, 'captures', 'items', 'rows', 'data', 'results');
  const captures: RawCapture[] = [];
  let malformed = 0;
  for (const row of rows) {
    const capture = coerceCapture(row);
    if (capture) captures.push(capture);
    else malformed += 1;
  }
  return { captures, total: unwrapTotal(payload), malformed };
}

export async function getCapture(captureId: string): Promise<RawCapture> {
  const payload = await request(`/captures/${encodeURIComponent(captureId)}`);
  // A single-capture route may or may not wrap its result.
  const candidate = isRecord(payload) && isRecord(payload['capture']) ? payload['capture'] : payload;
  const capture = coerceCapture(candidate);
  if (!capture) {
    throw new ApiError(`${API_BASE}/captures/${captureId}`, 200, 'Response did not contain a readable capture');
  }
  return capture;
}

const EMPTY_PARSE: Omit<ParsePreview, 'adapterId' | 'kind'> = {
  events: [],
  markets: [],
  selections: [],
  bets: [],
  oddsSnapshots: [],
  warnings: [],
  unmappedFields: [],
};

/**
 * Re-runs the adapter server-side. Empty arrays are the *expected* Milestone 1
 * answer for most traffic (CONTRACT.md, "Adapter contract") and are surfaced as
 * such rather than treated as a failure.
 */
export async function parseCapture(captureId: string): Promise<ParsePreview> {
  const payload = await request(`/captures/${encodeURIComponent(captureId)}/parse`);
  const root = isRecord(payload) && isRecord(payload['preview']) ? payload['preview'] : payload;
  if (!isRecord(root)) {
    return {
      adapterId: 'unknown',
      kind: 'unknown',
      ...EMPTY_PARSE,
      warnings: ['The server returned no parse preview for this capture.'],
    };
  }
  const arrayField = <T>(key: string): T[] => (Array.isArray(root[key]) ? (root[key] as T[]) : []);
  return {
    adapterId: str(root['adapterId']) ?? 'unknown',
    kind: (str(root['kind']) ?? 'unknown') as CaptureKind,
    events: arrayField('events'),
    markets: arrayField('markets'),
    selections: arrayField('selections'),
    bets: arrayField('bets'),
    oddsSnapshots: arrayField('oddsSnapshots'),
    warnings: arrayField<string>('warnings').filter((w) => typeof w === 'string'),
    unmappedFields: arrayField<string>('unmappedFields').filter((f) => typeof f === 'string'),
  };
}

/** Same-origin href for the export buttons, with the live filters applied. */
export function exportUrl(format: 'json' | 'ndjson', filters: CaptureFilters = {}): string {
  const query = filterParams(filters).toString();
  return `${API_BASE}/export/captures.${format}${query ? `?${query}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Stats / discovery
 * ------------------------------------------------------------------ */

export async function getStats(): Promise<CaptureStats> {
  const payload = await request('/stats');
  const root = isRecord(payload) && isRecord(payload['stats']) ? payload['stats'] : payload;
  const base: CaptureStats = {
    total: 0,
    bytes: 0,
    sessions: 0,
    byKind: {},
    byTransport: {},
    hosts: [],
    lastCaptureTs: null,
    serverTime: Date.now(),
  };
  if (!isRecord(root)) return base;
  return {
    total: num(root['total']) ?? 0,
    bytes: num(root['bytes']) ?? 0,
    sessions: num(root['sessions']) ?? 0,
    byKind: isRecord(root['byKind']) ? (root['byKind'] as CaptureStats['byKind']) : {},
    byTransport: isRecord(root['byTransport']) ? (root['byTransport'] as CaptureStats['byTransport']) : {},
    hosts: Array.isArray(root['hosts']) ? (root['hosts'] as HostStat[]) : [],
    lastCaptureTs: num(root['lastCaptureTs']),
    serverTime: num(root['serverTime']) ?? Date.now(),
  };
}

export async function getHosts(): Promise<HostStat[]> {
  const payload = await request('/hosts');
  return unwrapArray(payload, 'hosts', 'items', 'rows', 'data').filter(isHostStat);
}

function isHostStat(v: unknown): v is HostStat {
  return isRecord(v) && typeof v['host'] === 'string';
}

export async function getShapes(): Promise<ShapeStat[]> {
  const payload = await request('/shapes');
  return unwrapArray(payload, 'shapes', 'clusters', 'items', 'rows', 'data').filter(isShapeStat);
}

function isShapeStat(v: unknown): v is ShapeStat {
  return isRecord(v) && typeof v['shapeFingerprint'] === 'string';
}

/* ------------------------------------------------------------------ *
 * Frames
 *
 * CONTRACT.md defines POST /api/frames for the collector but no GET for the
 * dashboard. We try the GET anyway (it is the natural pair and the server
 * module may well expose it); when it 404s we fall back to deriving frame
 * origins from the capture rows themselves, which is real observed data rather
 * than a placeholder. The Frames page tells the user which of the two it used.
 * ------------------------------------------------------------------ */

export interface FramesResult {
  reports: FrameReport[];
  /** False when the server has no GET /api/frames route. */
  supported: boolean;
}

export async function getFrames(): Promise<FramesResult> {
  try {
    const payload = await request('/frames');
    const rows = unwrapArray(payload, 'frames', 'reports', 'items', 'rows', 'data');
    return { reports: rows.filter(isFrameReport), supported: true };
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return { reports: [], supported: false };
    throw err;
  }
}

function isFrameReport(v: unknown): v is FrameReport {
  return isRecord(v) && Array.isArray(v['frames']) && typeof v['topOrigin'] === 'string';
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Validates a config field by field against the default. A field the server
 * sent with the wrong type falls back to the default *and* is listed, so the
 * Settings page can say which values it could not read instead of silently
 * showing a default as though it were the live value.
 */
export function coerceConfig(raw: unknown): { config: CollectorConfig; unreadable: string[] } {
  const source = isRecord(raw) && isRecord(raw['config']) ? raw['config'] : raw;
  // Built as a loose record and narrowed once at the end: assigning through a
  // `keyof CollectorConfig` index would collapse to `never` since the union
  // spans boolean, number and string fields.
  const draft: Record<string, unknown> = { ...DEFAULT_COLLECTOR_CONFIG };
  const unreadable: string[] = [];
  if (!isRecord(source)) {
    return { config: { ...DEFAULT_COLLECTOR_CONFIG }, unreadable: ['the whole response - it was not a JSON object'] };
  }
  for (const key of Object.keys(DEFAULT_COLLECTOR_CONFIG)) {
    const value = source[key];
    const expected = typeof (DEFAULT_COLLECTOR_CONFIG as unknown as Record<string, unknown>)[key];
    if (value === undefined) {
      unreadable.push(`${key} (absent from the response)`);
      continue;
    }
    if (typeof value !== expected) {
      unreadable.push(`${key} (expected ${expected}, got ${typeof value})`);
      continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      unreadable.push(`${key} (not a finite number)`);
      continue;
    }
    draft[key] = value;
  }
  return { config: draft as unknown as CollectorConfig, unreadable };
}

export async function getConfig(): Promise<{ config: CollectorConfig; unreadable: string[] }> {
  return coerceConfig(await request('/config'));
}

export async function saveConfig(config: CollectorConfig): Promise<{ config: CollectorConfig; unreadable: string[] }> {
  const payload = await request('/config', { method: 'POST', body: JSON.stringify(config) });
  const result = coerceConfig(payload);
  // Some servers answer a write with `{ok:true}` rather than the stored row.
  // In that case the values we just sent are the best available truth, and we
  // say so rather than showing defaults.
  if (result.unreadable.length === Object.keys(DEFAULT_COLLECTOR_CONFIG).length) {
    return { config, unreadable: ['the server acknowledged the write without echoing the stored config'] };
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export interface HealthInfo {
  ok: boolean;
  /** Wire protocol version the server speaks, when it reports one. */
  protocolVersion: number | null;
  /** SQLite schema version, when it reports one. */
  schemaVersion: number | null;
  serverTime: number | null;
  uptimeMs: number | null;
  version: string | null;
  dbPath: string | null;
  /** Everything the route returned, shown verbatim so nothing is lost. */
  raw: Record<string, unknown>;
}

export async function getHealth(): Promise<HealthInfo> {
  const payload = await request('/health');
  const root = isRecord(payload) ? payload : {};
  return {
    ok: root['ok'] !== false,
    protocolVersion: num(pick(root, 'protocolVersion', 'protocol', 'v')),
    schemaVersion: num(pick(root, 'schemaVersion', 'schema')),
    serverTime: num(pick(root, 'serverTime', 'time', 'now')),
    uptimeMs: num(pick(root, 'uptimeMs', 'uptime')),
    version: str(pick(root, 'version')),
    dbPath: str(pick(root, 'dbPath', 'db', 'database')),
    raw: root,
  };
}

/* ------------------------------------------------------------------ *
 * Body decoding
 * ------------------------------------------------------------------ */

export interface DecodedBody {
  text: string | null;
  /** Explains anything the reader needs to know about what they are seeing. */
  note: string | null;
}

/**
 * Returns the capture body as text. Binary WebSocket frames arrive base64'd
 * (CONTRACT.md, "Collector"); we attempt a decode so a UTF-8 frame that merely
 * travelled as binary is readable, and keep the base64 when the result is not
 * text - we never render mojibake as though it were the payload.
 */
export function decodeCaptureBody(capture: RawCapture): DecodedBody {
  if (capture.body === null) {
    return { text: null, note: capture.error ?? 'The collector could not read a body for this capture.' };
  }
  if (capture.bodyEncoding !== 'base64') {
    return { text: capture.body, note: capture.truncated ? `Truncated at the collector's per-body cap. Full size was ${capture.bodyBytes} bytes.` : null };
  }
  try {
    const binary = atob(capture.body);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: decoded, note: 'Binary frame, decoded as UTF-8.' };
  } catch {
    return { text: capture.body, note: 'Binary frame that is not UTF-8 text. Shown as the base64 the collector recorded.' };
  }
}


/* ------------------------------------------------------------------ *
 * Normalized bets
 * ------------------------------------------------------------------ */

export interface StoredLeg {
  idx: number;
  sport: string | null;
  league: string | null;
  eventName: string | null;
  marketName: string | null;
  selectionName: string | null;
  line: number | null;
  oddsAtBet: number | null;
  currentOdds: number | null;
  status: string;
}

export interface StoredBet {
  betKey: string;
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
  legs: StoredLeg[];
}

export interface BetPage {
  bets: StoredBet[];
  total: number;
  limit: number;
  offset: number;
}

export interface BetFilters {
  type?: string;
  sport?: string;
  minStake?: number;
  q?: string;
  sort?: string;
  limit?: number;
}

export interface StakeDistribution {
  samples: number;
  currency?: string;
  min?: number;
  p50?: number;
  p90?: number;
  p99?: number;
  max?: number;
  note?: string;
}

export async function listBets(filters: BetFilters = {}): Promise<BetPage> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === '' || v === null) continue;
    params.set(k, String(v));
  }
  const payload = await request('/bets' + (params.toString() ? '?' + params.toString() : ''));
  const root = isRecord(payload) ? payload : {};
  return {
    bets: Array.isArray(root['bets']) ? (root['bets'] as StoredBet[]) : [],
    total: num(root['total']) ?? 0,
    limit: num(root['limit']) ?? 0,
    offset: num(root['offset']) ?? 0,
  };
}

export async function getStakeDistribution(): Promise<StakeDistribution> {
  const payload = await request('/bets/stakes');
  const root = isRecord(payload) ? payload : {};
  // `samples: 0` is the honest default: the server returns a note instead of a
  // distribution when it has nothing comparable to measure against yet.
  return {
    samples: num(root['samples']) ?? 0,
    currency: typeof root['currency'] === 'string' ? root['currency'] : undefined,
    min: num(root['min']) ?? undefined,
    p50: num(root['p50']) ?? undefined,
    p90: num(root['p90']) ?? undefined,
    p99: num(root['p99']) ?? undefined,
    max: num(root['max']) ?? undefined,
    note: typeof root['note'] === 'string' ? root['note'] : undefined,
  };
}

export interface NormalizedCounts {
  counts: Record<string, number>;
  refs: Record<string, unknown>;
}

export async function getNormalized(): Promise<NormalizedCounts> {
  const payload = await request('/normalized');
  const root = isRecord(payload) ? payload : {};
  return {
    counts: isRecord(root['counts']) ? (root['counts'] as Record<string, number>) : {},
    refs: isRecord(root['refs']) ? (root['refs'] as Record<string, unknown>) : {},
  };
}

/* ------------------------------------------------------------------ *
 * Analysis
 *
 * Two routes, both of which return numbers that are honest for a SINGLE book:
 * how much margin it charges, and how its own prices have moved against their
 * own past. Neither is an edge, and nothing in this section computes one — see
 * the header of src/analysis/types.ts for why a second price source is the
 * missing ingredient rather than a missing feature.
 * ------------------------------------------------------------------ */

/**
 * Named-key lookup with no single-array fallback.
 *
 * `unwrapArray` guesses the lone array-valued property when it recognises no
 * key, which is right for a one-list envelope and actively dangerous here: the
 * margins response carries two lists, and a payload missing `bySport` would hand
 * back `byType` labelled as sports. Silence is better than the wrong list.
 */
function namedArray(root: Record<string, unknown>, ...keys: string[]): unknown[] {
  const value = pick(root, ...keys);
  return Array.isArray(value) ? value : [];
}

/**
 * A margin row as the dashboard is willing to render it.
 *
 * `MarginSummary` types min/max as plain numbers because `summarizeMargins`
 * always produces them. Over the wire they can be absent, and an absent bound
 * has to render as a dash — defaulting it to the median would draw a range of
 * zero width, which reads as "every market in this group priced identically".
 */
export interface MarginRow extends Omit<MarginSummary, 'minMarginPct' | 'maxMarginPct'> {
  minMarginPct: number | null;
  maxMarginPct: number | null;
}

/**
 * Structural validation of one margin row. A row without a group name, a market
 * count or a median is dropped rather than repaired: the whole value of this
 * page is that every median is displayed next to the number of markets it was
 * taken over, and a row that cannot supply that number is not publishable.
 */
export function coerceMarginRow(raw: unknown): MarginRow | null {
  if (!isRecord(raw)) return null;
  const group = str(pick(raw, 'group', 'name', 'label'));
  const markets = num(pick(raw, 'markets', 'count', 'samples'));
  const medianMarginPct = num(pick(raw, 'medianMarginPct', 'median'));
  if (group === null || group === '' || markets === null || medianMarginPct === null) return null;
  // A median over zero markets is not a median.
  if (markets < 1) return null;
  return {
    group,
    markets,
    medianMarginPct,
    minMarginPct: num(pick(raw, 'minMarginPct', 'min')),
    maxMarginPct: num(pick(raw, 'maxMarginPct', 'max')),
  };
}

export interface MarginsResult {
  bySport: MarginRow[];
  byType: MarginRow[];
  /** The server's own caveat about these numbers. Rendered verbatim. */
  note: string | null;
  /** Rows the server sent that failed structural validation. Never hidden. */
  malformed: number;
  /** False when this server build has no /api/analysis/margins route. */
  supported: boolean;
}

export async function getMargins(): Promise<MarginsResult> {
  let payload: unknown;
  try {
    payload = await request('/analysis/margins');
  } catch (err) {
    // A 404 means "this server does not implement the route", which is a
    // different message to the user than "the analysis failed".
    if (err instanceof ApiError && err.isNotFound) {
      return { bySport: [], byType: [], note: null, malformed: 0, supported: false };
    }
    throw err;
  }
  const root = isRecord(payload) ? payload : {};
  let malformed = 0;
  const read = (...keys: string[]): MarginRow[] => {
    const out: MarginRow[] = [];
    for (const raw of namedArray(root, ...keys)) {
      const row = coerceMarginRow(raw);
      if (row) out.push(row);
      else malformed += 1;
    }
    return out;
  };
  return {
    bySport: read('bySport', 'sports'),
    byType: read('byType', 'byMarketType', 'types'),
    note: str(pick(root, 'note', 'explanation')),
    malformed,
    supported: true,
  };
}

/**
 * A movement plus whatever human-readable labels the server attached.
 *
 * `LineMovement` carries keys, not names, because the analysis layer works on
 * keys. Names are optional here and null when absent — the page falls back to
 * showing the key rather than inventing a title for an event.
 */
export interface MovementRow extends LineMovement {
  eventName: string | null;
  selectionName: string | null;
}

/**
 * Derived from the union so a new `MovementKind` fails validation loudly here
 * instead of being quietly rewritten to something this page knows how to draw.
 */
const MOVEMENT_KINDS: readonly MovementKind[] = ['steam', 'drift', 'round-trip', 'move'];

export function coerceMovement(raw: unknown): MovementRow | null {
  if (!isRecord(raw)) return null;
  const selectionKey = str(pick(raw, 'selectionKey'));
  const eventKey = str(pick(raw, 'eventKey'));
  const kind = MOVEMENT_KINDS.find((k) => k === str(pick(raw, 'kind')));
  const tsFrom = num(pick(raw, 'tsFrom'));
  const tsTo = num(pick(raw, 'tsTo'));
  const oddsFrom = num(pick(raw, 'oddsFrom'));
  const oddsTo = num(pick(raw, 'oddsTo'));
  const probDelta = num(pick(raw, 'probDelta'));
  const durationMs = num(pick(raw, 'durationMs'));
  const samples = num(pick(raw, 'samples'));

  if (!selectionKey || !eventKey || kind === undefined) return null;
  if (tsFrom === null || tsTo === null || durationMs === null || durationMs < 0) return null;
  if (samples === null || samples < 1) return null;
  // Prices are validated with the same band the rest of the system uses rather
  // than a local "looks numeric" check, so a parse artefact like 0 or 1e9 is
  // rejected here exactly as it would be in the analysis layer.
  if (!isValidDecimalOdds(oddsFrom) || !isValidDecimalOdds(oddsTo)) return null;
  // probDelta is the ranking key and the only column in comparable units. It is
  // NOT recomputed from the two prices when the server omits it: the sign
  // convention belongs to the analysis layer, and a guess at it that came out
  // backwards would relabel every shortening on the page as a drift.
  if (probDelta === null) return null;

  return {
    selectionKey,
    eventKey,
    kind,
    tsFrom,
    tsTo,
    oddsFrom,
    oddsTo,
    probDelta,
    durationMs,
    samples,
    eventName: str(pick(raw, 'eventName', 'event')),
    selectionName: str(pick(raw, 'selectionName', 'selection')),
  };
}

export interface MovementsResult {
  movements: MovementRow[];
  note: string | null;
  malformed: number;
  /** False when this server build has no /api/analysis/movements route. */
  supported: boolean;
}

export async function getMovements(): Promise<MovementsResult> {
  let payload: unknown;
  try {
    payload = await request('/analysis/movements');
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) {
      return { movements: [], note: null, malformed: 0, supported: false };
    }
    throw err;
  }
  const root = isRecord(payload) ? payload : {};
  const movements: MovementRow[] = [];
  let malformed = 0;
  // One list in this envelope, so unwrapArray's fallback is safe and useful.
  for (const raw of unwrapArray(payload, 'movements', 'items', 'rows', 'data')) {
    const row = coerceMovement(raw);
    if (row) movements.push(row);
    else malformed += 1;
  }
  return { movements, note: str(pick(root, 'note', 'explanation')), malformed, supported: true };
}
