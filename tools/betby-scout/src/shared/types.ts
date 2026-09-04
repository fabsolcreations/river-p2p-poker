/**
 * Betby Scout - shared domain contract.
 *
 * Everything in this file is used on BOTH sides of the wire (in-page collector
 * and Node server), so it must stay free of any Node- or DOM-only imports.
 *
 * Design rule that drives the whole shape of this file: at Milestone 1 we do
 * not know BETBY's real request/response schemas. We therefore keep two layers
 * strictly apart:
 *
 *   RawCapture      - exactly what the browser saw, never lossy, never guessed
 *   Normalized*     - our model, produced by an adapter, always best-effort
 *
 * A parse failure must degrade to "we captured it, we could not read it",
 * never to a fabricated value.
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Raw capture layer
 * ------------------------------------------------------------------ */

export type CaptureTransport = 'fetch' | 'xhr' | 'websocket' | 'sse' | 'dom' | 'manual';
export type CaptureDirection = 'inbound' | 'outbound';
export type BodyEncoding = 'utf8' | 'base64';

/**
 * What a payload appears to be. Assigned by shape analysis, never by guessing
 * an endpoint name - see CONTRACT.md "No invented endpoints".
 */
export type CaptureKind =
  | 'unknown'
  | 'bets_feed'      // the community/public feed of other users' bets
  | 'user_bets'      // the signed-in user's own bet history
  | 'event_list'     // a list/tree of events
  | 'event_detail'   // one event with its markets
  | 'market_list'    // markets/outcomes for an event
  | 'odds_update'    // incremental price change push
  | 'betslip'        // betslip pricing / validation
  | 'sport_tree'     // sports/categories/tournaments taxonomy
  | 'translation'    // i18n dictionaries (useful for label mapping, not data)
  | 'config'         // widget bootstrap/config
  | 'auth'           // token exchange - captured but never persisted unredacted
  | 'telemetry'      // analytics beacons
  | 'asset';         // images, fonts, css, js

export interface CaptureClassification {
  kind: CaptureKind;
  /** 0..1. Below MIN_CLASSIFY_CONFIDENCE the UI shows it as a guess. */
  confidence: number;
  /** Adapter that produced this verdict, e.g. "betby.generic" or "betby.duel". */
  adapterId: string;
  /** Human-readable evidence. Shown verbatim in the debug panel. */
  reasons: string[];
  /**
   * Stable hash of the payload key-shape (keys + value types, values
   * discarded). Two responses from the same endpoint share a fingerprint, so
   * we can cluster unknown traffic and spot schema drift.
   */
  shapeFingerprint: string;
}

export interface RawCapture {
  /** Deterministic: hash(sessionId + ":" + seq). Safe to replay/dedupe on. */
  captureId: string;
  /** One collector session = one page load of one frame. */
  sessionId: string;
  /** Monotonic within a session. Gaps mean drops, which we surface. */
  seq: number;

  /** Page clock, epoch ms. */
  tsClient: number;
  /** Server clock at ingest, epoch ms. Set server-side only. */
  tsServer?: number;

  transport: CaptureTransport;
  direction: CaptureDirection;

  /** Frame that observed the traffic. BETBY often lives in a child iframe. */
  frameUrl: string;
  frameOrigin: string;
  isTopFrame: boolean;
  /** Best-effort top-level page origin (may equal frameOrigin). */
  pageOrigin: string;

  method?: string;
  url: string;
  urlHost: string;
  urlPath: string;
  /** Query string with values redacted per redact.ts. */
  urlQuery?: string;

  status?: number;
  durationMs?: number;

  reqHeaders?: Record<string, string>;
  reqBody?: string | null;
  resHeaders?: Record<string, string>;
  contentType?: string;

  /** Response body, WS frame, or SSE data. null when unreadable. */
  body: string | null;
  bodyEncoding: BodyEncoding;
  /** Size before truncation, in bytes. */
  bodyBytes: number;
  truncated: boolean;
  /** True if any field was masked by the redactor. */
  redacted: boolean;

  /** Populated when the hook failed to read something, e.g. a locked stream. */
  error?: string;

  classification: CaptureClassification;
}

/* ------------------------------------------------------------------ *
 * Normalized domain layer
 * ------------------------------------------------------------------ */

export type BetStatus =
  | 'open'
  | 'won'
  | 'lost'
  | 'push'
  | 'void'
  | 'cashout'
  | 'partial'
  | 'unknown';

export type BetType = 'single' | 'combo' | 'system' | 'unknown';

export interface NormalizedEvent {
  /** Deterministic cross-restart key. See ids.ts. */
  key: string;
  sportsbookId: string;
  /** The book's own id, when the payload exposes one. */
  sourceEventId: string | null;
  sport: string | null;
  league: string | null;
  /** Competitors in listed order; 2 for most, N for outrights. */
  competitors: string[];
  home: string | null;
  away: string | null;
  name: string | null;
  /** Epoch ms. */
  startTime: number | null;
  live: boolean | null;
  status: string | null;
}

export interface NormalizedMarket {
  key: string;
  eventKey: string;
  sportsbookId: string;
  sourceMarketId: string | null;
  /** Normalized family, e.g. "moneyline" | "handicap" | "total". Null when unmapped. */
  type: string | null;
  /** The book's own label, kept verbatim. */
  name: string | null;
  /** Handicap / total line. Null for lineless markets. */
  line: number | null;
  period: string | null;
  status: string | null;
}

export interface NormalizedSelection {
  key: string;
  marketKey: string;
  eventKey: string;
  sportsbookId: string;
  sourceSelectionId: string | null;
  name: string | null;
  /** "home" | "away" | "draw" | "over" | "under" | free text. */
  side: string | null;
  line: number | null;
  decimalOdds: number | null;
  status: string | null;
}

export interface OddsSnapshot {
  sportsbookId: string;
  eventKey: string;
  marketKey: string;
  selectionKey: string;
  /** Epoch ms. */
  ts: number;
  decimalOdds: number;
  line: number | null;
  status: string | null;
  /** Which capture this price came from - every snapshot stays traceable. */
  captureId: string | null;
}

export interface NormalizedFeedBetLeg {
  betKey: string;
  idx: number;
  eventKey: string | null;
  sourceEventId: string | null;
  sport: string | null;
  league: string | null;
  eventName: string | null;
  marketKey: string | null;
  marketName: string | null;
  selectionKey: string | null;
  selectionName: string | null;
  line: number | null;
  oddsAtBet: number | null;
  currentOdds: number | null;
  live: boolean | null;
  status: BetStatus;
}

export interface NormalizedFeedBet {
  key: string;
  sportsbookId: string;
  sourceBetId: string | null;
  /** Epoch ms. */
  ts: number;
  /** Deterministic pseudonymous key for the bettor. */
  bettorKey: string;
  /** The masked handle the feed itself shows. Never de-anonymized. */
  bettorLabel: string | null;
  stake: number | null;
  currency: string | null;
  /** Stake in USD when a rate is known; otherwise null (never faked). */
  stakeUsd: number | null;
  totalOdds: number | null;
  potentialWin: number | null;
  type: BetType;
  legCount: number;
  live: boolean | null;
  status: BetStatus;
  legs: NormalizedFeedBetLeg[];
}

/**
 * What an adapter returns for one capture. Empty arrays are normal and
 * expected at Milestone 1 - that is the honest answer for traffic we cannot
 * yet read.
 */
export interface ParsePreview {
  adapterId: string;
  kind: CaptureKind;
  events: NormalizedEvent[];
  markets: NormalizedMarket[];
  selections: NormalizedSelection[];
  bets: NormalizedFeedBet[];
  oddsSnapshots: OddsSnapshot[];
  /** Things the adapter chose not to guess at. */
  warnings: string[];
  /**
   * Dotted paths present in the payload that no rule consumed. This is the
   * main schema-discovery signal - it tells us what we are still ignoring.
   */
  unmappedFields: string[];
}

/* ------------------------------------------------------------------ *
 * Adapter interface
 * ------------------------------------------------------------------ */

export interface AdapterContext {
  /** Epoch ms to use as "now" - injected so parsing is deterministic in tests. */
  now: number;
}

export interface ClassifyInput {
  url: string;
  urlHost: string;
  urlPath: string;
  method?: string;
  contentType?: string;
  transport: CaptureTransport;
  direction: CaptureDirection;
  /** Parsed JSON when the body was JSON, else null. */
  json: unknown;
  /** Raw text body, possibly truncated. */
  text: string | null;
}

export interface ParseInput extends ClassifyInput {
  captureId: string | null;
  sportsbookId: string;
  classification: CaptureClassification;
  ctx: AdapterContext;
}

export interface SportsbookAdapter {
  /** Stable id, e.g. "betby.duel". */
  id: string;
  /** Display name. */
  label: string;
  /** Platform family. Lets analytics treat all BETBY books alike. */
  platform: 'betby' | 'unknown';
  /**
   * Does this adapter claim the page/frame? Host-based only - never used to
   * filter what gets captured, only to pick a parser.
   */
  matches(ctx: { pageOrigin: string; frameOrigin: string; url: string }): boolean;
  /** Shape-based classification. Must not depend on endpoint names. */
  classify(input: ClassifyInput): CaptureClassification;
  /** Best-effort normalization. Must never invent values. */
  parse(input: ParseInput): ParsePreview;
}

/* ------------------------------------------------------------------ *
 * Collector <-> server wire protocol
 * ------------------------------------------------------------------ */

export type CollectorKind = 'extension' | 'userscript';

export interface CollectorIdentity {
  kind: CollectorKind;
  version: string;
  sessionId: string;
  pageOrigin: string;
  frameOrigin: string;
  isTopFrame: boolean;
  userAgent: string;
}

export interface IngestBatch {
  v: number;
  identity: CollectorIdentity;
  captures: RawCapture[];
  /** Captures the collector dropped locally (ring overflow / caps). */
  dropped?: number;
}

export interface IngestResult {
  ok: boolean;
  accepted: number;
  duplicates: number;
  rejected: number;
  errors?: string[];
}

/** Origins the collector saw as iframes - our host-discovery path. */
export interface FrameReport {
  sessionId: string;
  ts: number;
  topOrigin: string;
  frames: Array<{ src: string; origin: string; depth: number; sameOrigin: boolean }>;
}

/** Live push to the dashboard. */
export type ServerEvent =
  | { type: 'hello'; v: number; serverTime: number }
  | { type: 'capture'; capture: RawCapture }
  | { type: 'stats'; stats: CaptureStats }
  | { type: 'frames'; report: FrameReport }
  | { type: 'collector'; connected: number; identities: CollectorIdentity[] };

/** Live push to the collector (config the panel honours immediately). */
export type CollectorCommand =
  | { type: 'config'; config: CollectorConfig }
  | { type: 'ping'; ts: number };

export interface CollectorConfig {
  /** Master switch. */
  enabled: boolean;
  /** Post captures to the local server as well as buffering in-page. */
  upload: boolean;
  serverUrl: string;
  hookFetch: boolean;
  hookXhr: boolean;
  hookWebSocket: boolean;
  hookSse: boolean;
  /** DOM MutationObserver fallback for when nothing readable is on the wire. */
  domFallback: boolean;
  /** Skip obvious non-data traffic (images/fonts/css/js) to keep volume sane. */
  skipAssets: boolean;
  /** Per-body cap in bytes before truncation. */
  maxBodyBytes: number;
  /** In-page ring buffer size. */
  ringSize: number;
  /** Batch flush interval, ms. */
  flushIntervalMs: number;
  /** Mask credential-ish values before anything leaves the page. */
  redact: boolean;
  /** Show the floating debug panel. */
  panel: boolean;
}

export const DEFAULT_COLLECTOR_CONFIG: CollectorConfig = {
  enabled: true,
  upload: true,
  serverUrl: 'http://127.0.0.1:8787',
  hookFetch: true,
  hookXhr: true,
  hookWebSocket: true,
  hookSse: true,
  domFallback: false,
  skipAssets: true,
  maxBodyBytes: 1_000_000,
  ringSize: 2000,
  flushIntervalMs: 1500,
  redact: true,
  panel: true,
};

/* ------------------------------------------------------------------ *
 * Stats / discovery views
 * ------------------------------------------------------------------ */

export interface HostStat {
  host: string;
  captures: number;
  bytes: number;
  firstSeen: number;
  lastSeen: number;
  kinds: Partial<Record<CaptureKind, number>>;
  /** Highest classification confidence seen from this host. */
  bestConfidence: number;
}

export interface ShapeStat {
  shapeFingerprint: string;
  count: number;
  kind: CaptureKind;
  confidence: number;
  exampleCaptureId: string;
  host: string;
  path: string;
  firstSeen: number;
  lastSeen: number;
  /** Top-level key names, for eyeballing what a cluster is. */
  keys: string[];
}

export interface CaptureStats {
  total: number;
  bytes: number;
  sessions: number;
  byKind: Partial<Record<CaptureKind, number>>;
  byTransport: Partial<Record<CaptureTransport, number>>;
  hosts: HostStat[];
  lastCaptureTs: number | null;
  serverTime: number;
}

/** Confidence at or above this is presented as a classification, not a guess. */
export const MIN_CLASSIFY_CONFIDENCE = 0.55;
