/**
 * The in-page debug panel.
 *
 * This is the only human-facing surface the collector has while it is running
 * inside a live sportsbook, and its whole job at Milestone 1 is honesty: show
 * exactly what we captured, exactly what the adapter could and could not read,
 * and never dress a guess up as a fact.
 *
 * Four constraints shape everything below.
 *
 * 1. **We render untrusted strings.** Every url, header, body and parsed label
 *    comes from a third-party page. There is no `innerHTML` here and no caller
 *    can introduce one - all text goes through `dom.ts`, which only ever makes
 *    text nodes and `setAttribute` calls.
 * 2. **We must not break the page, or let the page break us.** The UI lives in
 *    a shadow root so the site's CSS cannot reach in and ours cannot leak out;
 *    the host element is a 0x0 `pointer-events: none` anchor so it can never
 *    swallow a click meant for the site; every callback into `deps` is wrapped,
 *    because a throw from the collector core must not take the panel down with
 *    it.
 * 3. **We must not cover the betslip.** BETBY books put the slip on the right,
 *    so the panel defaults to the left edge and offers one-click snapping.
 * 4. **A busy live feed must not make the page janky.** The capture list is
 *    rebuilt on a coalesced rAF tick with a hard row cap - never once per
 *    capture. A WebSocket odds feed can push hundreds of messages a second and
 *    a per-capture render would be a self-inflicted denial of service on the
 *    user's browser.
 */

import type {
  CaptureKind,
  CollectorConfig,
  NormalizedFeedBet,
  ParsePreview,
  RawCapture,
} from '../../shared/types.ts';
import { MIN_CLASSIFY_CONFIDENCE } from '../../shared/types.ts';
import type { CaptureRing } from '../core/ring.ts';
import type { UploaderStatus } from '../core/uploader.ts';
import { append, clear, el, setText, show } from './dom.ts';
import { PANEL_CSS } from './styles.ts';

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface PanelDeps {
  ring: CaptureRing;
  config: () => CollectorConfig;
  setConfig: (patch: Partial<CollectorConfig>) => void;
  uploaderStatus: () => UploaderStatus;
  parse: (c: RawCapture) => ParsePreview;
  discoverFrames: () => void;
  exportNdjson: () => void;
  version: string;
}

export interface PanelHandle {
  destroy(): void;
  toggle(): void;
  refresh(): void;
}

/* ------------------------------------------------------------------ *
 * The collector-core surface this panel touches
 *
 * Deliberately funnelled through three one-line functions rather than sprinkled
 * across a dozen call sites: the ring and the uploader are owned by
 * `collector/core`, and when their surface moves, exactly one place here needs
 * to move with it.
 * ------------------------------------------------------------------ */

/** Newest-last snapshot of the in-page ring buffer. */
function ringCaptures(ring: CaptureRing): RawCapture[] {
  return ring.list();
}

/** Captures the ring evicted because it was full. Surfaced, never hidden. */
function ringDropped(ring: CaptureRing): number {
  return ring.stats().dropped;
}

function ringClear(ring: CaptureRing): void {
  ring.clear();
}

type DotTone = 'ok' | 'warn' | 'bad' | 'off';

interface ConnectionView {
  tone: DotTone;
  label: string;
  /** Goes in the `title` attribute, so the last error is always reachable. */
  detail: string;
}

/**
 * Amber is not "something is a bit wrong" here - it is specifically the HTTP
 * fallback, which works but loses the server's live command channel. A user who
 * cannot tell those apart will waste an afternoon wondering why config pushes
 * are not arriving.
 */
function connectionView(status: UploaderStatus, config: CollectorConfig): ConnectionView {
  const parts: string[] = [];
  if (status.lastError) parts.push(`Last error: ${status.lastError}`);

  if (!config.upload) {
    parts.unshift('Upload is off - captures stay in the in-page ring buffer only.');
    return { tone: 'off', label: 'no upload', detail: parts.join(' ') };
  }
  if (!status.connected) {
    parts.unshift(`Not reaching the Scout server at ${config.serverUrl}.`);
    return { tone: 'bad', label: 'offline', detail: parts.join(' ') };
  }
  if (status.transport === 'ws') {
    parts.unshift(`Connected to ${config.serverUrl} over WebSocket.`);
    return { tone: 'ok', label: 'ws', detail: parts.join(' ') };
  }
  parts.unshift(
    `Uploading to ${config.serverUrl} over HTTP POST - the WebSocket is unavailable, so live commands from the server will not arrive.`,
  );
  return { tone: 'warn', label: 'http', detail: parts.join(' ') };
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const STORE_KEY = 'betby-scout:panel';

/** Hard cap on rendered rows. The ring holds thousands; a DOM list must not. */
const MAX_ROWS = 200;
const MAX_FIELD_ROWS = 800;
/** Bodies can be a megabyte. Past this we show a note instead of a wall. */
const MAX_RAW_CHARS = 200_000;
const MAX_STRING_CHARS = 300;
const MAX_TREE_CHILDREN = 500;

const MIN_W = 520;
const MIN_H = 260;
const EDGE_GAP = 12;
/** Keep at least this much of the panel on screen when clamping. */
const KEEP_VISIBLE_X = 120;
const KEEP_VISIBLE_Y = 34;

/** Coalescing interval for the live tick. ~4 Hz is plenty for a debug list. */
const TICK_MS = 250;

const TAB_IDS = ['endpoint', 'payload', 'event', 'market', 'bet', 'fields', 'warnings'] as const;
type TabId = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<TabId, string> = {
  endpoint: 'Endpoint',
  payload: 'Payload',
  event: 'Parsed event',
  market: 'Parsed market',
  bet: 'Parsed bet',
  fields: 'Fields',
  warnings: 'Warnings',
};

/**
 * The one sentence this whole milestone turns on: an empty parse is the correct
 * answer for traffic whose schema we have not learned yet, and the UI has to say
 * so in words rather than showing a blank box that reads as a bug - or worse, an
 * example row that reads as data.
 */
function emptyParseNote(what: string): string {
  return `No ${what} parsed. The adapter matched no structural rules for this payload - expected until real BETBY payloads are captured (Milestone 2).`;
}

const TRANSPORT_BADGE: Record<string, string> = {
  fetch: 'FTCH',
  xhr: 'XHR',
  websocket: 'WS',
  sse: 'SSE',
  dom: 'DOM',
  manual: 'MAN',
};

interface ToggleSpec {
  key: BoolConfigKey;
  label: string;
  hint: string;
  warn?: boolean;
}

type BoolConfigKey =
  | 'enabled'
  | 'upload'
  | 'hookFetch'
  | 'hookXhr'
  | 'hookWebSocket'
  | 'hookSse'
  | 'domFallback'
  | 'skipAssets'
  | 'redact'
  | 'panel';

const TOGGLES: ToggleSpec[] = [
  { key: 'enabled', label: 'enabled', hint: 'Master switch. Off leaves the hooks installed but records nothing.' },
  { key: 'upload', label: 'upload', hint: 'Also POST captures to the local Scout server. Off keeps everything in this page.' },
  { key: 'hookFetch', label: 'hookFetch', hint: 'Wrap window.fetch. Responses are read through response.clone().' },
  { key: 'hookXhr', label: 'hookXhr', hint: 'Wrap XMLHttpRequest.' },
  { key: 'hookWebSocket', label: 'hookWebSocket', hint: 'Wrap WebSocket, both directions. Binary frames are base64, never dropped.' },
  { key: 'hookSse', label: 'hookSse', hint: 'Wrap EventSource.' },
  { key: 'domFallback', label: 'domFallback', hint: 'MutationObserver scrape. Off by default - it is noisy and only useful when nothing readable is on the wire.' },
  { key: 'skipAssets', label: 'skipAssets', hint: 'Skip images, fonts, css and js so the ring is not filled with things that carry no data.' },
  {
    key: 'redact',
    label: 'redact',
    warn: true,
    hint: 'Masks credential-shaped values before anything leaves the page. Turning this OFF means session tokens, and anything else that looks like a credential, can end up verbatim in an exported file. Only turn it off if you understand where that file is going.',
  },
  { key: 'panel', label: 'panel', hint: 'Show this panel. Turning it off here hides it; the extension popup can bring it back.' },
];

type NumConfigKey = 'maxBodyBytes' | 'ringSize' | 'flushIntervalMs';

interface NumberSpec {
  key: NumConfigKey;
  label: string;
  hint: string;
  min: number;
  max: number;
}

const NUMBERS: NumberSpec[] = [
  {
    key: 'maxBodyBytes',
    label: 'maxBodyBytes',
    hint: 'Per-body cap before truncation. Truncation is flagged on the capture, never silent.',
    min: 1_000,
    max: 50_000_000,
  },
  {
    key: 'ringSize',
    label: 'ringSize',
    hint: 'In-page ring buffer size. Older captures are dropped once it is full, and the drop count is reported.',
    min: 50,
    max: 100_000,
  },
  {
    key: 'flushIntervalMs',
    label: 'flushIntervalMs',
    hint: 'How often buffered captures are flushed to the server.',
    min: 250,
    max: 60_000,
  },
];

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtClock(ts: number): string {
  if (!Number.isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtTs(ts: number | null | undefined): string | null {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '?';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Paths identify themselves at the tail (`/v2/events/12345`), so when one is too
 * long to show, drop the middle rather than the end.
 */
function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.ceil((n - 1) / 2);
  const tail = Math.floor((n - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ *
 * Small builders
 * ------------------------------------------------------------------ */

function heading(text: string): HTMLElement {
  return el('div', { class: 'bs-h', text });
}

function note(text: string, tone: 'info' | 'warn' | 'bad' = 'info'): HTMLElement {
  return el('div', { class: tone === 'info' ? 'bs-note' : `bs-note ${tone}`, text });
}

interface KvRow {
  k: string;
  v: string | null;
  title?: string;
}

function kvList(rows: KvRow[]): HTMLElement {
  const dl = el('dl', { class: 'bs-kv' });
  for (const row of rows) {
    append(dl, el('dt', { text: row.k }));
    const empty = row.v === null || row.v === '';
    const dd = el('dd', {
      class: empty ? 'dim' : undefined,
      text: empty ? '—' : row.v ?? '—',
      title: row.title,
    });
    append(dl, dd);
  }
  return dl;
}

interface Cell {
  text: string;
  num?: boolean;
  empty?: boolean;
  title?: string;
}

function txtCell(v: string | null | undefined, title?: string): Cell {
  if (v === null || v === undefined || v === '') return { text: '—', empty: true, title };
  return { text: v, title };
}

function numCell(v: number | null | undefined, digits?: number): Cell {
  if (v === null || v === undefined || !Number.isFinite(v)) return { text: '—', empty: true, num: true };
  return { text: digits === undefined ? String(v) : v.toFixed(digits), num: true };
}

function boolCell(v: boolean | null | undefined): Cell {
  if (v === null || v === undefined) return { text: '—', empty: true };
  return { text: v ? 'yes' : 'no' };
}

function buildTable(headers: string[], rows: Cell[][]): HTMLElement {
  const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of row) {
      const cls = [c.num ? 'num' : '', c.empty ? 'null' : ''].filter(Boolean).join(' ');
      append(tr, el('td', { class: cls || undefined, text: c.text, title: c.title }));
    }
    append(tbody, tr);
  }
  return el('div', { class: 'bs-scrollx' }, [el('table', { class: 'bs-table' }, [thead, tbody])]);
}

function rawBlock(text: string): HTMLElement {
  const shown = text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text;
  const frag = el('div');
  append(frag, el('pre', { class: 'bs-raw', text: shown }));
  if (shown.length < text.length) {
    append(
      frag,
      note(
        `Display truncated at ${fmtInt(MAX_RAW_CHARS)} characters (body is ${fmtInt(text.length)}). The export and the server copy carry the whole body.`,
        'warn',
      ),
    );
  }
  return frag;
}

/* ------------------------------------------------------------------ *
 * JSON tree
 *
 * Children are built on expand, not up front. A sport tree or an odds push can
 * be tens of thousands of nodes, and eagerly materialising that many elements
 * inside a page we are trying not to disturb is exactly the jank this panel is
 * supposed to avoid.
 * ------------------------------------------------------------------ */

function describeContainer(v: unknown): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  return `Object(${Object.keys(v as Record<string, unknown>).length})`;
}

function isContainer(v: unknown): boolean {
  return v !== null && typeof v === 'object';
}

function leafValue(v: unknown): HTMLElement {
  if (v === null || v === undefined) return el('span', { class: 'bs-jnull', text: 'null' });
  if (typeof v === 'boolean') return el('span', { class: 'bs-jbool', text: String(v) });
  if (typeof v === 'number' || typeof v === 'bigint') return el('span', { class: 'bs-jnum', text: String(v) });
  const s = String(v);
  return el('span', {
    class: 'bs-jstr',
    text: `"${truncate(s, MAX_STRING_CHARS)}"`,
    // The full string stays reachable without ever being parsed as markup.
    title: s.length > MAX_STRING_CHARS ? truncate(s, 2000) : undefined,
  });
}

function jsonNode(key: string | null, value: unknown, depth: number): HTMLElement {
  const wrap = el('div', { class: depth === 0 ? 'bs-jnode root' : 'bs-jnode' });
  const row = el('div', { class: 'bs-jrow' });
  append(wrap, row);

  if (!isContainer(value)) {
    append(row, el('span', { class: 'bs-twisty', text: ' ' }));
    if (key !== null) append(row, el('span', { class: 'bs-jkey', text: `${key}:` }));
    append(row, leafValue(value));
    return wrap;
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  // Auto-expand only what a human can actually take in at a glance; anything
  // bigger waits for a click.
  let expanded = depth < 2 && entries.length <= 40;
  const children = el('div');
  const twisty = el('button', { class: 'bs-twisty', attrs: { type: 'button' }, text: expanded ? '▾' : '▸' });
  append(row, twisty);
  if (key !== null) append(row, el('span', { class: 'bs-jkey', text: `${key}:` }));
  append(row, el('span', { class: 'bs-jmeta', text: describeContainer(value) }));
  append(wrap, children);

  let built = false;
  const build = (): void => {
    if (built) return;
    built = true;
    const slice = entries.slice(0, MAX_TREE_CHILDREN);
    for (const [k, v] of slice) append(children, jsonNode(k, v, depth + 1));
    if (entries.length > slice.length) {
      append(
        children,
        el('div', { class: 'bs-jmeta', text: `… ${fmtInt(entries.length - slice.length)} more not rendered` }),
      );
    }
  };

  const sync = (): void => {
    setText(twisty, expanded ? '▾' : '▸');
    if (expanded) build();
    show(children, expanded);
  };

  twisty.addEventListener('click', () => {
    expanded = !expanded;
    sync();
  });
  sync();
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Parsed-layer tables
 * ------------------------------------------------------------------ */

function eventsView(preview: ParsePreview): HTMLElement {
  const frag = el('div');
  append(frag, heading(`NormalizedEvent · ${fmtInt(preview.events.length)}`));
  if (preview.events.length === 0) {
    append(frag, note(emptyParseNote('events')));
    return frag;
  }
  append(
    frag,
    buildTable(
      ['key', 'sourceEventId', 'sport', 'league', 'name', 'home', 'away', 'competitors', 'startTime', 'live', 'status'],
      preview.events.map((e) => [
        txtCell(truncate(e.key, 12), e.key),
        txtCell(e.sourceEventId),
        txtCell(e.sport),
        txtCell(e.league),
        txtCell(e.name),
        txtCell(e.home),
        txtCell(e.away),
        txtCell(e.competitors.length > 0 ? e.competitors.join(' vs ') : null),
        txtCell(fmtTs(e.startTime)),
        boolCell(e.live),
        txtCell(e.status),
      ]),
    ),
  );
  return frag;
}

function marketsView(preview: ParsePreview): HTMLElement {
  const frag = el('div');

  append(frag, heading(`NormalizedMarket · ${fmtInt(preview.markets.length)}`));
  if (preview.markets.length === 0) {
    append(frag, note(emptyParseNote('markets')));
  } else {
    append(
      frag,
      buildTable(
        ['key', 'eventKey', 'sourceMarketId', 'type', 'name', 'line', 'period', 'status'],
        preview.markets.map((m) => [
          txtCell(truncate(m.key, 12), m.key),
          txtCell(truncate(m.eventKey, 12), m.eventKey),
          txtCell(m.sourceMarketId),
          txtCell(m.type),
          txtCell(m.name),
          numCell(m.line),
          txtCell(m.period),
          txtCell(m.status),
        ]),
      ),
    );
  }

  append(frag, heading(`NormalizedSelection · ${fmtInt(preview.selections.length)}`));
  if (preview.selections.length === 0) {
    append(frag, note(emptyParseNote('selections')));
  } else {
    append(
      frag,
      buildTable(
        ['key', 'marketKey', 'sourceSelectionId', 'name', 'side', 'line', 'odds', 'status'],
        preview.selections.map((s) => [
          txtCell(truncate(s.key, 12), s.key),
          txtCell(truncate(s.marketKey, 12), s.marketKey),
          txtCell(s.sourceSelectionId),
          txtCell(s.name),
          txtCell(s.side),
          numCell(s.line),
          // Odds always show two decimals - CONTRACT.md, and because 2 and 2.00
          // scanning differently in a column is how a price gets misread.
          numCell(s.decimalOdds, 2),
          txtCell(s.status),
        ]),
      ),
    );
  }

  if (preview.oddsSnapshots.length > 0) {
    append(frag, heading(`OddsSnapshot · ${fmtInt(preview.oddsSnapshots.length)}`));
    append(
      frag,
      buildTable(
        ['ts', 'selectionKey', 'marketKey', 'odds', 'line', 'status', 'captureId'],
        preview.oddsSnapshots.map((o) => [
          txtCell(fmtTs(o.ts)),
          txtCell(truncate(o.selectionKey, 12), o.selectionKey),
          txtCell(truncate(o.marketKey, 12), o.marketKey),
          numCell(o.decimalOdds, 2),
          numCell(o.line),
          txtCell(o.status),
          txtCell(o.captureId),
        ]),
      ),
    );
  }

  return frag;
}

const BET_HEADERS = ['key', 'time', 'bettor', 'stake', 'ccy', 'usd', 'odds', 'to win', 'type', 'legs', 'live', 'status'];

function betRow(b: NormalizedFeedBet): Cell[] {
  return [
    txtCell(truncate(b.key, 10), `${b.key}${b.sourceBetId ? ` · source ${b.sourceBetId}` : ''}`),
    txtCell(fmtTs(b.ts)),
    // The masked handle the feed itself displays, plus our pseudonymous key. We
    // never attempt to resolve either to a real account.
    txtCell(b.bettorLabel, `bettorKey ${b.bettorKey}`),
    numCell(b.stake, 2),
    txtCell(b.currency),
    numCell(b.stakeUsd, 2),
    numCell(b.totalOdds, 2),
    numCell(b.potentialWin, 2),
    txtCell(b.type),
    numCell(b.legCount),
    boolCell(b.live),
    txtCell(b.status),
  ];
}

function betsView(preview: ParsePreview): HTMLElement {
  const frag = el('div');
  append(frag, heading(`NormalizedFeedBet · ${fmtInt(preview.bets.length)}`));
  if (preview.bets.length === 0) {
    append(frag, note(emptyParseNote('bets')));
    return frag;
  }

  const tbody = el('tbody');
  for (const b of preview.bets) {
    const tr = el('tr');
    for (const c of betRow(b)) {
      const cls = [c.num ? 'num' : '', c.empty ? 'null' : ''].filter(Boolean).join(' ');
      append(tr, el('td', { class: cls || undefined, text: c.text, title: c.title }));
    }
    append(tbody, tr);

    // Legs go directly under their bet rather than in a second table: a combo's
    // legs are only meaningful next to the bet that contains them.
    const legTr = el('tr', { class: 'leg' });
    const legTd = el('td', { attrs: { colspan: BET_HEADERS.length } });
    if (b.legs.length === 0) {
      append(legTd, el('div', { text: 'No legs in this bet payload.' }));
    } else {
      append(
        legTd,
        buildTable(
          ['#', 'sport', 'league', 'event', 'market', 'selection', 'line', 'odds@bet', 'current', 'live', 'status'],
          b.legs.map((l) => [
            numCell(l.idx),
            txtCell(l.sport),
            txtCell(l.league),
            txtCell(l.eventName, l.eventKey ?? undefined),
            txtCell(l.marketName, l.marketKey ?? undefined),
            txtCell(l.selectionName, l.selectionKey ?? undefined),
            numCell(l.line),
            numCell(l.oddsAtBet, 2),
            numCell(l.currentOdds, 2),
            boolCell(l.live),
            txtCell(l.status),
          ]),
        ),
      );
    }
    append(legTr, legTd);
    append(tbody, legTr);
  }

  append(
    frag,
    el('div', { class: 'bs-scrollx' }, [
      el('table', { class: 'bs-table' }, [
        el('thead', {}, [el('tr', {}, BET_HEADERS.map((h) => el('th', { text: h })))]),
        tbody,
      ]),
    ]),
  );
  return frag;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

interface Persisted {
  v: 1;
  x: number;
  y: number;
  w: number;
  h: number;
  leftW: number;
  collapsed: boolean;
  tab: TabId;
}

function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function defaultLayout(): Persisted {
  const w = Math.min(760, Math.max(MIN_W, window.innerWidth - EDGE_GAP * 2));
  const h = Math.min(560, Math.max(MIN_H, window.innerHeight - EDGE_GAP * 2));
  return {
    v: 1,
    // Left edge by default: BETBY betslips live on the right, and a debug panel
    // that covers the slip is a debug panel the user turns off.
    x: EDGE_GAP,
    y: EDGE_GAP + 48,
    w,
    h,
    leftW: 330,
    collapsed: false,
    tab: 'endpoint',
  };
}

/**
 * A window can be resized, moved to a smaller screen, or the panel dragged to a
 * second monitor that is no longer attached. A restored position must always
 * leave a grabbable strip of titlebar inside the viewport, or the panel is lost
 * with no way back short of clearing localStorage.
 */
function clampLayout(p: Persisted): Persisted {
  const vw = Math.max(320, window.innerWidth);
  const vh = Math.max(240, window.innerHeight);
  const w = Math.min(Math.max(p.w, MIN_W), Math.max(MIN_W, vw - 8));
  const h = Math.min(Math.max(p.h, MIN_H), Math.max(MIN_H, vh - 8));
  const x = Math.min(Math.max(p.x, -(w - KEEP_VISIBLE_X)), Math.max(0, vw - KEEP_VISIBLE_X));
  const y = Math.min(Math.max(p.y, 0), Math.max(0, vh - KEEP_VISIBLE_Y));
  const leftW = Math.min(Math.max(p.leftW, 240), Math.max(240, w - 260));
  return { ...p, w, h, x, y, leftW };
}

function loadLayout(): Persisted {
  const base = defaultLayout();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch {
    // Sandboxed iframes and "block third-party cookies" both make localStorage
    // throw on access rather than return null. The panel still works; it just
    // forgets where it was.
    return base;
  }
  if (raw === null) return base;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return base;
    const o = parsed as Record<string, unknown>;
    return clampLayout({
      v: 1,
      x: numberOr(o.x, base.x),
      y: numberOr(o.y, base.y),
      w: numberOr(o.w, base.w),
      h: numberOr(o.h, base.h),
      leftW: numberOr(o.leftW, base.leftW),
      collapsed: o.collapsed === true,
      tab: isTabId(o.tab) ? o.tab : base.tab,
    });
  } catch {
    return base;
  }
}

function saveLayout(p: Persisted): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    // Storage full, or disabled. Losing the layout is not worth an error path.
  }
}

/* ------------------------------------------------------------------ *
 * mountPanel
 * ------------------------------------------------------------------ */

export function mountPanel(deps: PanelDeps): PanelHandle {
  /* ---------------------------------------------------------- state -- */

  let layout = loadLayout();
  let visible = deps.config().panel !== false;
  let settingsOpen = false;
  let filterText = '';
  const kindFilter = new Set<CaptureKind>();
  let selectedId: string | null = null;
  let selected: RawCapture | null = null;
  let selectedAged = false;
  let preview: ParsePreview | null = null;
  let previewError: string | null = null;

  /** Signature of what the list last rendered, so an idle tick does no work. */
  let listSig = '';
  let chipSig = '';

  const cleanups: Array<() => void> = [];
  let endDrag: (() => void) | null = null;
  let rafId: number | null = null;
  let tickTimer: number | null = null;
  let destroyed = false;

  function on(target: EventTarget, type: string, fn: (ev: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    cleanups.push(() => target.removeEventListener(type, fn, capture));
  }

  /** Anything that calls back into the collector core is fenced. */
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      setFooter(`${what} failed: ${errText(e)}`, true);
    }
  }

  /* ------------------------------------------------------------ DOM -- */

  const host = el('div', { attrs: { 'data-betby-scout-panel': deps.version } });
  // Closed: the page cannot reach into our tree through host.shadowRoot. Devtools
  // still shows it, which is the only inspection path that matters to us.
  const shadow = host.attachShadow({ mode: 'closed' });
  append(shadow, el('style', { text: PANEL_CSS }));

  // documentElement, not body: at document_start there may be no body yet, and
  // single-page apps routinely replace the whole body subtree.
  document.documentElement.appendChild(host);

  const root = el('div', { class: 'bs-root' });
  append(shadow, root);

  /* -- titlebar -- */
  const counterEl = el('span', { class: 'bs-counter' });
  const dotEl = el('span', { class: 'bs-dot off' });
  const dotLabel = el('span', { class: 'bs-dotlabel', text: '—' });
  const pauseBtn = el('button', { class: 'bs-btn', attrs: { type: 'button' }, text: 'Pause' });
  const clearBtn = el('button', { class: 'bs-btn', attrs: { type: 'button' }, text: 'Clear' });
  const exportBtn = el('button', {
    class: 'bs-btn',
    attrs: { type: 'button' },
    text: 'Export raw capture',
    title: 'Download the in-page ring buffer as NDJSON.',
  });
  const framesBtn = el('button', {
    class: 'bs-btn',
    attrs: { type: 'button' },
    text: 'Discover frames',
    title: 'Walk the frame tree and report the iframe origins present on this page.',
  });
  const snapLeftBtn = el('button', {
    class: 'bs-btn icon',
    attrs: { type: 'button' },
    text: '⇤',
    title: 'Snap to the left edge (keeps the betslip clear).',
  });
  const snapRightBtn = el('button', {
    class: 'bs-btn icon',
    attrs: { type: 'button' },
    text: '⇥',
    title: 'Snap to the right edge. On most BETBY books this covers the betslip.',
  });
  const settingsBtn = el('button', { class: 'bs-btn icon', attrs: { type: 'button' }, text: '⚙', title: 'Settings' });
  const collapseBtn = el('button', { class: 'bs-btn icon', attrs: { type: 'button' }, text: '–', title: 'Collapse to a pill' });

  const titlebar = el('div', { class: 'bs-titlebar' }, [
    el('span', { class: 'bs-brand', text: 'BETBY SCOUT' }),
    el('span', { class: 'bs-ver', text: `v${deps.version}` }),
    counterEl,
    el('span', { class: 'bs-spacer' }),
    dotEl,
    dotLabel,
    pauseBtn,
    clearBtn,
    exportBtn,
    framesBtn,
    snapLeftBtn,
    snapRightBtn,
    settingsBtn,
    collapseBtn,
  ]);

  /* -- left column -- */
  const filterInput = el('input', {
    class: 'bs-input',
    attrs: { type: 'text', placeholder: 'filter url / host / kind', spellcheck: 'false' },
  });
  const listCount = el('span', { class: 'bs-counter' });
  const chipsEl = el('div', { class: 'bs-chips' });
  const listEl = el('div', { class: 'bs-list' });
  const leftEl = el('div', { class: 'bs-left' }, [
    el('div', { class: 'bs-toolrow' }, [filterInput, listCount]),
    chipsEl,
    listEl,
  ]);

  /* -- right column -- */
  const tabsEl = el('div', { class: 'bs-tabs' });
  const tabBody = el('div', { class: 'bs-tabbody' });
  const rightEl = el('div', { class: 'bs-right' }, [tabsEl, tabBody]);
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const tabBadges = new Map<TabId, HTMLElement>();
  for (const id of TAB_IDS) {
    const badge = el('span', { class: 'badge' });
    show(badge, false);
    const btn = el('button', { class: 'bs-tab', attrs: { type: 'button' } }, [TAB_LABELS[id], badge]);
    btn.addEventListener('click', () => {
      layout = { ...layout, tab: id };
      saveLayout(layout);
      renderTabs();
      renderDetail();
    });
    tabButtons.set(id, btn);
    tabBadges.set(id, badge);
    append(tabsEl, btn);
  }

  const splitEl = el('div', { class: 'bs-split' });
  const bodyEl = el('div', { class: 'bs-body' }, [leftEl, splitEl, rightEl]);

  /* -- footer, drawer, grip -- */
  const footerMsgEl = el('span', { class: 'msg' });
  const footerStatsEl = el('span', {});
  const footerEl = el('div', { class: 'bs-footer' }, [footerMsgEl, el('span', { class: 'bs-spacer' }), footerStatsEl]);
  const drawerEl = el('div', { class: 'bs-drawer' });
  show(drawerEl, false);
  const gripEl = el('div', { class: 'bs-resize', title: 'Drag to resize' });

  const panelEl = el('div', { class: 'bs-panel' }, [titlebar, bodyEl, footerEl, drawerEl, gripEl]);

  /* -- collapsed pill -- */
  const pillCounter = el('span', { class: 'bs-counter' });
  const pillDot = el('span', { class: 'bs-dot off' });
  const pillEl = el('div', { class: 'bs-pill', title: 'Betby Scout — drag to move, click to expand' }, [
    el('span', { class: 'bs-brand', text: 'BS' }),
    pillCounter,
    pillDot,
  ]);

  append(root, panelEl);
  append(root, pillEl);

  /* ------------------------------------------------------- settings -- */

  const boolInputs = new Map<BoolConfigKey, HTMLInputElement>();
  const numInputs = new Map<NumConfigKey, HTMLInputElement>();
  const serverInput = el('input', {
    class: 'bs-input mono',
    attrs: { type: 'text', id: 'bs-set-serverUrl', spellcheck: 'false', placeholder: 'http://127.0.0.1:8787' },
  });

  function buildSettings(): void {
    append(drawerEl, heading('collector config'));
    append(
      drawerEl,
      note('Every change here is applied immediately and pushed to the collector core. Nothing is queued.'),
    );

    for (const spec of TOGGLES) {
      const input = el('input', { attrs: { type: 'checkbox', id: `bs-set-${spec.key}` } });
      input.addEventListener('change', () => {
        const patch: Partial<CollectorConfig> = {};
        patch[spec.key] = input.checked;
        guard(`Setting ${spec.key}`, () => deps.setConfig(patch));
        setFooter(`${spec.key} = ${input.checked ? 'on' : 'off'}`);
      });
      boolInputs.set(spec.key, input);
      append(
        drawerEl,
        el('div', { class: 'bs-set' }, [
          input,
          el('label', { attrs: { for: `bs-set-${spec.key}` }, text: spec.label }),
          el('div', { class: spec.warn ? 'hint warn' : 'hint', text: spec.hint }),
        ]),
      );
    }

    for (const spec of NUMBERS) {
      const input = el('input', {
        class: 'bs-input mono',
        attrs: { type: 'number', min: spec.min, max: spec.max, step: 1, id: `bs-set-${spec.key}` },
      });
      // 'change' rather than 'input': a number field is transiently invalid on
      // the way to being valid ("2" while typing "2000"), and pushing every
      // keystroke would set ringSize to 2 on the way past.
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < spec.min || value > spec.max) {
          input.classList.add('bad');
          setFooter(`${spec.key} must be a whole number between ${fmtInt(spec.min)} and ${fmtInt(spec.max)} — not applied.`, true);
          return;
        }
        input.classList.remove('bad');
        const patch: Partial<CollectorConfig> = {};
        patch[spec.key] = value;
        guard(`Setting ${spec.key}`, () => deps.setConfig(patch));
        setFooter(`${spec.key} = ${fmtInt(value)}`);
      });
      numInputs.set(spec.key, input);
      append(
        drawerEl,
        el('div', { class: 'bs-setnum' }, [
          el('label', { attrs: { for: `bs-set-${spec.key}` }, text: spec.label }),
          input,
          el('div', { class: 'hint', text: spec.hint }),
        ]),
      );
    }

    serverInput.addEventListener('change', () => {
      const raw = serverInput.value.trim();
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        serverInput.classList.add('bad');
        setFooter('serverUrl is not a URL. Expected something like http://127.0.0.1:8787 — not applied.', true);
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        serverInput.classList.add('bad');
        setFooter('serverUrl must be http or https — not applied.', true);
        return;
      }
      serverInput.classList.remove('bad');
      // Trailing slash stripped so the uploader can concatenate paths safely.
      const serverUrl = url.origin + url.pathname.replace(/\/$/, '');
      guard('Setting serverUrl', () => deps.setConfig({ serverUrl }));
      setFooter(`serverUrl = ${serverUrl}`);
    });
    append(
      drawerEl,
      el('div', { class: 'bs-setnum' }, [
        el('label', { attrs: { for: 'bs-set-serverUrl' }, text: 'serverUrl' }),
        serverInput,
        el('div', { class: 'hint', text: 'Where captures are uploaded. The Scout server binds to 127.0.0.1 only.' }),
      ]),
    );

    append(drawerEl, heading('this collector'));
    append(
      drawerEl,
      kvList([
        { k: 'version', v: deps.version },
        { k: 'frame origin', v: window.location.origin },
        { k: 'top frame', v: window.top === window.self ? 'yes' : 'no' },
      ]),
    );
  }

  function syncSettings(): void {
    const config = deps.config();
    const active = shadow.activeElement;
    for (const [key, input] of boolInputs) {
      if (input === active) continue;
      input.checked = config[key];
    }
    for (const [key, input] of numInputs) {
      if (input === active) continue;
      input.value = String(config[key]);
      input.classList.remove('bad');
    }
    if (serverInput !== active) {
      serverInput.value = config.serverUrl;
      serverInput.classList.remove('bad');
    }
  }

  buildSettings();

  /* ------------------------------------------------------- geometry -- */

  function applyLayout(): void {
    root.style.left = `${layout.x}px`;
    root.style.top = `${layout.y}px`;
    if (layout.collapsed) {
      root.style.width = 'auto';
      root.style.height = 'auto';
    } else {
      root.style.width = `${layout.w}px`;
      root.style.height = `${layout.h}px`;
    }
    leftEl.style.width = `${layout.leftW}px`;
    show(panelEl, !layout.collapsed);
    show(pillEl, layout.collapsed);
    show(root, visible);
  }

  function setLayout(patch: Partial<Persisted>, persist = true): void {
    layout = clampLayout({ ...layout, ...patch });
    applyLayout();
    if (persist) saveLayout(layout);
  }

  /**
   * Drag helper.
   *
   * Listeners go on `window` in the CAPTURE phase deliberately: a sportsbook
   * page is entitled to call stopPropagation on pointer events, and a drag that
   * dies halfway because the site swallowed pointermove leaves the panel stuck
   * to the cursor. Capture on window runs before anything in the page can.
   */
  function beginDrag(ev: PointerEvent, onMove: (dx: number, dy: number) => void, onEnd?: (moved: number) => void): void {
    ev.preventDefault();
    endDrag?.();
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let moved = 0;

    const move = (e: Event): void => {
      const p = e as PointerEvent;
      const dx = p.clientX - x0;
      const dy = p.clientY - y0;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      onMove(dx, dy);
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      titlebar.classList.remove('bs-dragging');
      pillEl.classList.remove('bs-dragging');
      endDrag = null;
      saveLayout(layout);
      onEnd?.(moved);
    };

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    endDrag = stop;
  }

  function dragFrom(el0: HTMLElement, cls: 'bs-dragging' | null, onMove: (dx: number, dy: number, start: Persisted) => void, onEnd?: (moved: number) => void): void {
    el0.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const target = ev.target as Element | null;
      // Never start a drag from a control - closest() stops at the shadow root,
      // so this only ever sees our own tree.
      if (target && target.closest('button, input, select, textarea')) return;
      const start = layout;
      if (cls) el0.classList.add(cls);
      beginDrag(ev, (dx, dy) => onMove(dx, dy, start), onEnd);
    });
  }

  dragFrom(titlebar, 'bs-dragging', (dx, dy, start) => setLayout({ x: start.x + dx, y: start.y + dy }, false));
  dragFrom(
    pillEl,
    'bs-dragging',
    (dx, dy, start) => setLayout({ x: start.x + dx, y: start.y + dy }, false),
    (moved) => {
      // A press that did not travel is a click, and a pill with no room for a
      // separate button needs click-to-expand.
      if (moved < 4) setLayout({ collapsed: false });
    },
  );
  dragFrom(gripEl, null, (dx, dy, start) => setLayout({ w: start.w + dx, h: start.h + dy }, false));
  dragFrom(splitEl, null, (dx, _dy, start) => setLayout({ leftW: start.leftW + dx }, false));

  on(window, 'resize', () => setLayout({}, false));

  /* --------------------------------------------------------- header -- */

  function setFooter(msg: string, bad = false): void {
    setText(footerMsgEl, msg);
    footerMsgEl.className = bad ? 'msg bad' : 'msg';
  }

  function renderHeader(captures: RawCapture[], dropped: number): void {
    const config = deps.config();

    clear(counterEl);
    append(counterEl, el('b', { text: fmtInt(captures.length) }));
    append(counterEl, ' captured');
    if (dropped > 0) {
      append(counterEl, ' · ');
      append(counterEl, el('span', { class: 'bs-drop', text: `${fmtInt(dropped)} dropped` }));
    }

    clear(pillCounter);
    append(pillCounter, el('b', { text: fmtInt(captures.length) }));

    let view: ConnectionView;
    try {
      view = connectionView(deps.uploaderStatus(), config);
    } catch (e) {
      // The uploader failing to report is itself a fact worth showing, and it
      // must not take the panel's render down with it.
      view = { tone: 'bad', label: 'unknown', detail: `The uploader did not report a status: ${errText(e)}` };
    }
    dotEl.className = `bs-dot ${view.tone}`;
    dotEl.setAttribute('title', view.detail);
    pillDot.className = `bs-dot ${view.tone}`;
    pillDot.setAttribute('title', view.detail);
    setText(dotLabel, view.label);
    dotLabel.setAttribute('title', view.detail);

    const paused = !config.enabled;
    setText(pauseBtn, paused ? 'Paused' : 'Pause');
    pauseBtn.className = paused ? 'bs-btn warnstate' : 'bs-btn';
    pauseBtn.setAttribute(
      'title',
      paused ? 'Collection is off. Hooks stay installed; nothing is recorded.' : 'Stop recording captures.',
    );

    setText(footerStatsEl, `ring ${fmtInt(captures.length)}/${fmtInt(config.ringSize)} · dropped ${fmtInt(dropped)}`);
  }

  /* ---------------------------------------------------------- chips -- */

  function renderChips(counts: Map<CaptureKind, number>): void {
    const kinds = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    for (const k of kindFilter) if (!counts.has(k)) kinds.push(k);

    const sig = `${kinds.map((k) => `${k}:${counts.get(k) ?? 0}`).join(',')}|${[...kindFilter].sort().join(',')}`;
    if (sig === chipSig) return;
    chipSig = sig;

    clear(chipsEl);
    const all = el('button', {
      class: kindFilter.size === 0 ? 'bs-kchip on' : 'bs-kchip',
      attrs: { type: 'button' },
      text: 'all',
    });
    all.addEventListener('click', () => {
      kindFilter.clear();
      chipSig = '';
      listSig = '';
      scheduleRender();
    });
    append(chipsEl, all);

    for (const kind of kinds) {
      const chip = el('button', { class: kindFilter.has(kind) ? 'bs-kchip on' : 'bs-kchip', attrs: { type: 'button' } }, [
        kind,
        ' ',
        el('span', { class: 'n', text: fmtInt(counts.get(kind) ?? 0) }),
      ]);
      chip.addEventListener('click', () => {
        if (kindFilter.has(kind)) kindFilter.delete(kind);
        else kindFilter.add(kind);
        chipSig = '';
        listSig = '';
        scheduleRender();
      });
      append(chipsEl, chip);
    }
  }

  /* ----------------------------------------------------------- list -- */

  function matches(c: RawCapture, needle: string): boolean {
    if (kindFilter.size > 0 && !kindFilter.has(c.classification.kind)) return false;
    if (needle === '') return true;
    return (
      c.url.toLowerCase().includes(needle) ||
      c.urlHost.toLowerCase().includes(needle) ||
      c.classification.kind.includes(needle) ||
      (c.method ?? '').toLowerCase().includes(needle)
    );
  }

  function rowFor(c: RawCapture): HTMLElement {
    const cls = c.classification;
    const guess = cls.confidence < MIN_CLASSIFY_CONFIDENCE;
    const status = c.status;
    const statusCls =
      status === undefined
        ? ''
        : status >= 500
          ? ' bad5'
          : status >= 400
            ? ' warn4'
            : status >= 200
              ? ' ok2'
              : '';

    const detail = [
      `${c.method ?? c.transport} ${c.url}`,
      `${cls.kind} · confidence ${cls.confidence.toFixed(2)} · ${cls.adapterId}`,
      `shape ${cls.shapeFingerprint}`,
      `${fmtInt(c.bodyBytes)} bytes${c.truncated ? ' (truncated)' : ''}${c.redacted ? ' · redacted' : ''}`,
      c.error ? `error: ${c.error}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const row = el('div', { class: c.captureId === selectedId ? 'bs-row sel' : 'bs-row', title: detail }, [
      el('span', { class: 't', text: fmtClock(c.tsClient) }),
      el('span', {
        class: `bs-tr ${c.transport === 'websocket' ? 'ws' : c.transport === 'sse' ? 'sse' : c.transport === 'dom' ? 'dom' : ''}`.trim(),
        text: TRANSPORT_BADGE[c.transport] ?? c.transport.slice(0, 4).toUpperCase(),
        title: `${c.transport} · ${c.direction}`,
      }),
      // WebSocket frames have no method, so the direction arrow takes that slot -
      // for a duplex feed, which way a frame went is the useful fact.
      el('span', { class: 'm', text: c.method ?? (c.direction === 'outbound' ? '→' : '←') }),
      el('span', { class: `st${statusCls}`, text: status === undefined ? '—' : String(status) }),
      el('span', { class: 'bs-loc' }, [
        el('span', { class: 'h', text: `${c.urlHost} ` }),
        el('span', { class: 'p', text: truncateMiddle(c.urlPath, 64) }),
      ]),
      el('span', { class: 'sz', text: `${fmtBytes(c.bodyBytes)}${c.truncated ? '·' : ''}` }),
      el('span', {
        class: `bs-chip k-${cls.kind}${guess ? ' guess' : ''}`,
        // A "?" so the guess reads as a guess even in a screenshot, where the
        // outline-vs-solid distinction can be lost.
        text: guess ? `${cls.kind}?` : cls.kind,
        title: `${cls.kind} · confidence ${cls.confidence.toFixed(2)}${guess ? ` (below the ${MIN_CLASSIFY_CONFIDENCE} threshold - treated as a guess)` : ''}`,
      }),
    ]);

    row.addEventListener('click', () => selectCapture(c));
    return row;
  }

  function renderList(captures: RawCapture[]): void {
    const needle = filterText.trim().toLowerCase();
    const hits: RawCapture[] = [];
    let selectedStillHeld = false;
    // Walk newest-first so the cap keeps the most recent rows, which is what a
    // live feed is for.
    for (let i = captures.length - 1; i >= 0; i--) {
      const c = captures[i];
      if (c === undefined) continue;
      if (c.captureId === selectedId) selectedStillHeld = true;
      if (hits.length < MAX_ROWS && matches(c, needle)) hits.push(c);
    }
    let matching = hits.length;
    if (matching === MAX_ROWS) {
      matching = 0;
      for (const c of captures) if (matches(c, needle)) matching++;
    }
    selectedAged = selectedId !== null && !selectedStillHeld;

    setText(listCount, `${fmtInt(matching)} shown`);

    const first = hits[0];
    const last = hits[hits.length - 1];
    const sig = `${hits.length}:${matching}:${first?.captureId ?? ''}:${last?.captureId ?? ''}:${selectedId ?? ''}`;
    if (sig === listSig) return;
    listSig = sig;

    const scrollTop = listEl.scrollTop;
    clear(listEl);

    if (hits.length === 0) {
      append(
        listEl,
        el('div', {
          class: 'bs-empty',
          text:
            captures.length === 0
              ? 'Nothing captured yet in this frame. If the BETBY widget lives in a cross-origin iframe, use "Discover frames" and grant that origin in the extension popup - the panel only sees the frame it is running in.'
              : 'No capture matches this filter.',
        }),
      );
    } else {
      for (const c of hits) append(listEl, rowFor(c));
      if (matching > hits.length) {
        append(
          listEl,
          el('div', {
            class: 'bs-empty',
            text: `Showing the newest ${fmtInt(hits.length)} of ${fmtInt(matching)} matching captures. The rest are still in the ring buffer and still export.`,
          }),
        );
      }
    }
    listEl.scrollTop = scrollTop;
  }

  /* --------------------------------------------------------- detail -- */

  function selectCapture(c: RawCapture): void {
    selectedId = c.captureId;
    selected = c;
    preview = null;
    previewError = null;
    listSig = '';
    try {
      preview = deps.parse(c);
    } catch (e) {
      // A parse that throws is a fact about the adapter, not a reason to show
      // nothing. Report it verbatim and keep the raw capture readable.
      previewError = errText(e);
    }
    scheduleRender();
    renderTabs();
    renderDetail();
  }

  function renderTabs(): void {
    for (const id of TAB_IDS) {
      const btn = tabButtons.get(id);
      const badge = tabBadges.get(id);
      if (!btn || !badge) continue;
      btn.className = id === layout.tab ? 'bs-tab on' : 'bs-tab';

      let count: number | null = null;
      let tone = '';
      if (preview) {
        if (id === 'event') count = preview.events.length;
        else if (id === 'market') count = preview.markets.length + preview.selections.length;
        else if (id === 'bet') count = preview.bets.length;
        else if (id === 'fields') {
          count = preview.unmappedFields.length;
          tone = count > 0 ? ' info' : '';
        } else if (id === 'warnings') {
          count = preview.warnings.length;
          tone = count > 0 ? ' alert' : '';
        }
      }
      if (count === null) {
        show(badge, false);
      } else {
        setText(badge, fmtInt(count));
        badge.className = `badge${tone}`;
        show(badge, true);
      }
    }
  }

  function endpointView(c: RawCapture): HTMLElement {
    const frag = el('div');
    const cls = c.classification;
    const guess = cls.confidence < MIN_CLASSIFY_CONFIDENCE;

    if (selectedAged) {
      append(
        frag,
        note(
          'This capture has aged out of the in-page ring buffer. What you see here is the copy the panel is holding; it is no longer in the export or the upload queue.',
          'warn',
        ),
      );
    }
    if (c.error) append(frag, note(`The hook reported: ${c.error}`, 'bad'));

    append(frag, heading('request'));
    append(
      frag,
      kvList([
        { k: 'method', v: c.method ?? null },
        { k: 'url', v: c.url },
        { k: 'host', v: c.urlHost },
        { k: 'path', v: c.urlPath },
        { k: 'query', v: c.urlQuery ?? null },
        { k: 'status', v: c.status === undefined ? null : String(c.status) },
        { k: 'duration', v: c.durationMs === undefined ? null : `${c.durationMs} ms` },
        { k: 'transport', v: c.transport },
        { k: 'direction', v: c.direction },
        { k: 'content-type', v: c.contentType ?? null },
        { k: 'size', v: `${fmtInt(c.bodyBytes)} bytes (${fmtBytes(c.bodyBytes)})` },
        { k: 'encoding', v: c.bodyEncoding },
        { k: 'truncated', v: c.truncated ? `yes — capped at maxBodyBytes` : 'no' },
        { k: 'redacted', v: c.redacted ? 'yes — one or more values were masked before this left the page' : 'no' },
      ]),
    );

    append(frag, heading('frame'));
    append(
      frag,
      kvList([
        { k: 'frame origin', v: c.frameOrigin },
        { k: 'frame url', v: c.frameUrl },
        { k: 'top frame', v: c.isTopFrame ? 'yes' : 'no' },
        { k: 'page origin', v: c.pageOrigin },
        { k: 'session', v: c.sessionId },
        { k: 'seq', v: String(c.seq) },
        { k: 'capture id', v: c.captureId },
        { k: 'client time', v: fmtTs(c.tsClient) },
        { k: 'server time', v: fmtTs(c.tsServer ?? null) },
      ]),
    );

    append(frag, heading('classification'));
    append(
      frag,
      kvList([
        { k: 'kind', v: cls.kind },
        { k: 'confidence', v: cls.confidence.toFixed(2) },
        { k: 'adapter', v: cls.adapterId },
        { k: 'shape', v: cls.shapeFingerprint },
      ]),
    );
    if (guess) {
      append(
        frag,
        note(
          `Confidence ${cls.confidence.toFixed(2)} is below the ${MIN_CLASSIFY_CONFIDENCE} threshold, so this kind is a guess, not a verdict. Treat it as "unknown, leaning ${cls.kind}".`,
          'warn',
        ),
      );
    }
    append(frag, heading(`reasons · ${fmtInt(cls.reasons.length)}`));
    if (cls.reasons.length === 0) {
      append(frag, note('The adapter recorded no evidence for this verdict.'));
    } else {
      append(frag, el('ul', { class: 'bs-reasons' }, cls.reasons.map((r) => el('li', { text: r }))));
    }

    const reqHeaders = Object.entries(c.reqHeaders ?? {});
    if (reqHeaders.length > 0) {
      append(frag, heading('request headers'));
      append(frag, kvList(reqHeaders.map(([k, v]) => ({ k, v }))));
    }
    const resHeaders = Object.entries(c.resHeaders ?? {});
    if (resHeaders.length > 0) {
      append(frag, heading('response headers'));
      append(frag, kvList(resHeaders.map(([k, v]) => ({ k, v }))));
    }

    return frag;
  }

  function copyButton(label: string, getText: () => string): HTMLElement {
    const btn = el('button', { class: 'bs-btn', attrs: { type: 'button' }, text: label });
    btn.addEventListener('click', () => {
      const text = getText();
      const fallback = (): void => {
        // Insecure origins and older engines have no async clipboard. The
        // textarea lives inside our shadow root, so it never touches the page.
        try {
          const ta = el('textarea');
          ta.value = text;
          ta.style.position = 'absolute';
          ta.style.left = '-9999px';
          ta.style.top = '0';
          append(panelEl, ta);
          ta.focus();
          ta.select();
          const ok = document.execCommand('copy');
          panelEl.removeChild(ta);
          setFooter(ok ? `Copied ${fmtInt(text.length)} characters.` : 'The browser refused the copy.', !ok);
        } catch (e) {
          setFooter(`Copy failed: ${errText(e)}`, true);
        }
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => setFooter(`Copied ${fmtInt(text.length)} characters.`),
          fallback,
        );
      } else {
        fallback();
      }
    });
    return btn;
  }

  function bodyView(title: string, body: string, encoding: string, c: RawCapture): HTMLElement {
    const frag = el('div');
    append(frag, heading(title));
    append(
      frag,
      el('div', { class: 'bs-toolrow' }, [
        copyButton('Copy', () => body),
        el('span', { class: 'bs-dotlabel', text: `${fmtInt(body.length)} chars · ${encoding}` }),
      ]),
    );

    if (encoding === 'base64') {
      append(
        frag,
        note(
          'Binary frame, kept as base64 so nothing is lost. There is no JSON view for it; decode it from the export if you need to look inside.',
        ),
      );
      append(frag, rawBlock(body));
      return frag;
    }

    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(body);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) {
      append(frag, el('div', { class: 'bs-json' }, [jsonNode(null, parsed, 0)]));
    } else {
      append(frag, note(`Not JSON (content-type ${c.contentType ?? 'unknown'}). Showing the raw text.`));
      append(frag, rawBlock(body));
    }
    return frag;
  }

  function payloadView(c: RawCapture): HTMLElement {
    const frag = el('div');
    append(
      frag,
      kvList([
        { k: 'shape', v: c.classification.shapeFingerprint, title: 'Payloads from the same endpoint share this fingerprint.' },
        { k: 'bytes', v: `${fmtInt(c.bodyBytes)}${c.truncated ? ' (truncated)' : ''}` },
        { k: 'encoding', v: c.bodyEncoding },
      ]),
    );
    if (c.truncated) {
      append(
        frag,
        note('This body hit maxBodyBytes and was cut. Anything below the cut is missing from the JSON view as well.', 'warn'),
      );
    }

    if (c.body === null) {
      append(frag, note('No body was readable for this capture. The hook records that rather than guessing at content.'));
    } else {
      append(frag, bodyView(c.transport === 'websocket' ? 'frame' : 'response body', c.body, c.bodyEncoding, c));
    }

    // Request bodies are where a book's query language lives; for schema
    // discovery they are often worth more than the response.
    if (typeof c.reqBody === 'string' && c.reqBody.length > 0) {
      append(frag, bodyView('request body', c.reqBody, 'utf8', c));
    }
    return frag;
  }

  function fieldsView(p: ParsePreview): HTMLElement {
    const frag = el('div');
    append(frag, heading(`unmapped fields · ${fmtInt(p.unmappedFields.length)}`));
    append(
      frag,
      note(
        'Every dotted path in this payload that no adapter rule consumed. This is the schema-discovery list: it is what we are still ignoring, and it is where Milestone 2 starts.',
      ),
    );
    if (p.unmappedFields.length === 0) {
      append(frag, note('The adapter reported no unmapped fields for this payload.'));
      return frag;
    }
    const box = el('div', { class: 'bs-fields' });
    const shown = p.unmappedFields.slice(0, MAX_FIELD_ROWS);
    for (const path of shown) append(box, el('div', { text: path }));
    append(frag, box);
    if (p.unmappedFields.length > shown.length) {
      append(frag, note(`${fmtInt(p.unmappedFields.length - shown.length)} more paths not rendered.`, 'warn'));
    }
    return frag;
  }

  function warningsView(p: ParsePreview): HTMLElement {
    const frag = el('div');
    append(frag, heading(`warnings · ${fmtInt(p.warnings.length)}`));
    if (p.warnings.length === 0) {
      append(frag, note('The adapter reported no warnings for this capture.'));
      return frag;
    }
    append(
      frag,
      note('Each line is something the adapter refused to guess at. A field named here is null in the parsed view, not defaulted.'),
    );
    for (const w of p.warnings) append(frag, note(w, 'warn'));
    return frag;
  }

  function renderDetail(): void {
    clear(tabBody);
    const c = selected;
    if (c === null) {
      append(
        tabBody,
        el('div', {
          class: 'bs-empty',
          text: 'Select a capture on the left to inspect it. Nothing is pre-selected — the panel does not decide for you what is interesting.',
        }),
      );
      return;
    }

    if (layout.tab === 'endpoint') {
      append(tabBody, endpointView(c));
      return;
    }
    if (layout.tab === 'payload') {
      append(tabBody, payloadView(c));
      return;
    }

    if (previewError !== null) {
      append(tabBody, note(`The adapter threw while parsing this capture: ${previewError}`, 'bad'));
      append(tabBody, note('The raw capture is unaffected — the Endpoint and Payload tabs still show exactly what was received.'));
      return;
    }
    const p = preview;
    if (p === null) {
      append(tabBody, note('No parse result for this capture yet.'));
      return;
    }

    append(
      tabBody,
      kvList([
        { k: 'adapter', v: p.adapterId },
        { k: 'kind', v: p.kind },
      ]),
    );
    if (layout.tab === 'event') append(tabBody, eventsView(p));
    else if (layout.tab === 'market') append(tabBody, marketsView(p));
    else if (layout.tab === 'bet') append(tabBody, betsView(p));
    else if (layout.tab === 'fields') append(tabBody, fieldsView(p));
    else if (layout.tab === 'warnings') append(tabBody, warningsView(p));
  }

  /* ----------------------------------------------------------- tick -- */

  function renderNow(): void {
    if (destroyed || !visible) return;
    let captures: RawCapture[] = [];
    let dropped = 0;
    try {
      captures = ringCaptures(deps.ring);
      dropped = ringDropped(deps.ring);
    } catch (e) {
      setFooter(`The ring buffer did not answer: ${errText(e)}`, true);
      return;
    }

    renderHeader(captures, dropped);
    if (layout.collapsed) return;

    const counts = new Map<CaptureKind, number>();
    for (const c of captures) counts.set(c.classification.kind, (counts.get(c.classification.kind) ?? 0) + 1);
    renderChips(counts);
    renderList(captures);
    if (settingsOpen) syncSettings();
  }

  function scheduleRender(): void {
    if (destroyed || rafId !== null) return;
    // rAF, not a bare timer: a hidden tab never paints, so the work simply does
    // not happen while the user is elsewhere.
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      renderNow();
    });
  }

  tickTimer = window.setInterval(scheduleRender, TICK_MS);

  /* -------------------------------------------------------- actions -- */

  pauseBtn.addEventListener('click', () => {
    const next = !deps.config().enabled;
    guard('Pause', () => deps.setConfig({ enabled: next }));
    setFooter(next ? 'Collecting.' : 'Paused. Hooks stay installed; nothing is recorded.');
    scheduleRender();
  });

  clearBtn.addEventListener('click', () => {
    guard('Clear', () => ringClear(deps.ring));
    selectedId = null;
    selected = null;
    preview = null;
    previewError = null;
    listSig = '';
    chipSig = '';
    setFooter('Ring buffer cleared. Captures already uploaded to the server are unaffected.');
    renderTabs();
    renderDetail();
    scheduleRender();
  });

  exportBtn.addEventListener('click', () => {
    guard('Export', () => deps.exportNdjson());
    setFooter('Export requested — check your downloads.');
  });

  framesBtn.addEventListener('click', () => {
    guard('Frame discovery', () => deps.discoverFrames());
    setFooter('Frame walk requested. Origins appear in the extension popup and the dashboard.');
  });

  snapLeftBtn.addEventListener('click', () => setLayout({ x: EDGE_GAP }));
  snapRightBtn.addEventListener('click', () =>
    setLayout({ x: Math.max(EDGE_GAP, window.innerWidth - layout.w - EDGE_GAP) }),
  );

  settingsBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsBtn.className = settingsOpen ? 'bs-btn icon on' : 'bs-btn icon';
    show(drawerEl, settingsOpen);
    if (settingsOpen) syncSettings();
  });

  collapseBtn.addEventListener('click', () => setLayout({ collapsed: true }));

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    listSig = '';
    scheduleRender();
  });

  /* ---------------------------------------------------------- start -- */

  applyLayout();
  renderTabs();
  renderDetail();
  setFooter(`Panel v${deps.version} ready. Captures are read-only: nothing here can place, price or modify a bet.`);
  renderNow();

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      endDrag?.();
      if (tickTimer !== null) window.clearInterval(tickTimer);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      for (const off of cleanups.splice(0)) {
        try {
          off();
        } catch {
          // A listener we can no longer remove is not worth failing teardown for.
        }
      }
      host.remove();
    },
    toggle(): void {
      visible = !visible;
      applyLayout();
      if (visible) renderNow();
    },
    refresh(): void {
      listSig = '';
      chipSig = '';
      renderTabs();
      renderDetail();
      renderNow();
    },
  };
}
