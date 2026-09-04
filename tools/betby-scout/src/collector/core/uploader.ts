/**
 * Ships captures from the page to the local server.
 *
 * Three constraints shape this file:
 *
 * 1. **It must be invisible to the page.** Every network call is
 *    fire-and-forget; nothing here awaits in a path the site can observe, and
 *    no failure is ever thrown where a page handler could see it. The server
 *    being off is a normal, quiet state - the ring keeps buffering.
 *
 * 2. **It must not capture itself.** The uploader's own traffic would be
 *    recorded by our own hooks, and every flush would then enlarge the next
 *    one. Two defences: we hold pristine references to `fetch` and
 *    `WebSocket` taken at module load (before `installHooks` runs), and the
 *    hook independently drops anything addressed to the configured server.
 *
 * 3. **Nothing is lost silently.** A batch handed out by the ring is marked
 *    in-flight; it is acknowledged only when the server confirms it, and any
 *    failure path nacks it back to pending so the next flush retries.
 */

import type {
  CollectorCommand,
  CollectorConfig,
  CollectorIdentity,
  FrameReport,
  IngestBatch,
  RawCapture,
} from '../../shared/types.ts';
import { PROTOCOL_VERSION } from '../../shared/types.ts';
import type { CaptureRing } from './ring.ts';

/**
 * Pristine references, captured at module-evaluation time. The entry file
 * imports this module before it installs any hook, so these are the browser's
 * own implementations even after `window.fetch` is replaced by us or by the
 * page.
 */
const nativeFetch: typeof fetch | null =
  typeof fetch === 'function' ? fetch.bind(globalThis) : null;
const NativeWebSocket: typeof WebSocket | null =
  typeof WebSocket === 'function' ? WebSocket : null;

export interface UploaderStatus {
  connected: boolean;
  transport: 'ws' | 'http' | 'none';
  lastError: string | null;
  sent: number;
  pending: number;
  lastSentAt: number | null;
}

export interface UploaderDeps {
  config: () => CollectorConfig;
  ring: CaptureRing;
  identity: () => CollectorIdentity;
  onCommand: (cmd: CollectorCommand) => void;
  onStatus: (s: UploaderStatus) => void;
}

/** Captures per batch. Keeps one flush bounded when a socket floods us. */
const MAX_BATCH = 200;
/**
 * Byte budget per batch. Fastify's default body limit is 1MB, so a batch that
 * comfortably fits under it survives a server that never raised the default.
 */
const BATCH_BYTE_BUDGET = 512 * 1024;
/**
 * `keepalive: true` lets a POST outlive the page (valuable on unload), but
 * Chrome caps keepalive request bodies at 64KB and rejects anything larger.
 * Above this we send a normal POST instead of losing the batch.
 */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** How long a WS batch may sit unconfirmed before we take drain as delivery. */
const WS_ACK_TIMEOUT_MS = 5_000;

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return String(e);
  } catch {
    return 'unknown error';
  }
}

/** Cheap size estimate for batching. Exact size comes from the final encode. */
function estimateBytes(c: RawCapture): number {
  return (c.body ? c.body.length : 0) + (typeof c.reqBody === 'string' ? c.reqBody.length : 0) + c.url.length + 512;
}

function isCollectorCommand(v: unknown): v is CollectorCommand {
  if (v === null || typeof v !== 'object') return false;
  const type = (v as { type?: unknown }).type;
  return type === 'config' || type === 'ping';
}

/** The server's reply to an ingest batch, recognised structurally. */
/**
 * The server replies `{type:'ingest-result', result:{ok, accepted, ...}}`. The
 * HTTP path returns the bare result instead, so both shapes are accepted here -
 * matching only the bare one would leave every websocket batch unconfirmed,
 * which the reaper eventually re-queues, producing a permanent resend loop that
 * the server silently dedupes and nobody ever notices.
 */
function isIngestResult(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const envelope = v as { type?: unknown; result?: unknown };
  const body = envelope.type === 'ingest-result' && envelope.result !== undefined ? envelope.result : v;
  if (body === null || typeof body !== 'object') return false;
  const o = body as { ok?: unknown; accepted?: unknown };
  return typeof o.ok === 'boolean' && typeof o.accepted === 'number';
}

export function createUploader(deps: UploaderDeps): {
  start(): void;
  stop(): void;
  flushNow(): Promise<void>;
  status(): UploaderStatus;
  sendFrameReport(r: FrameReport): void;
} {
  let running = false;
  let socket: WebSocket | null = null;
  let socketUrl = '';
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let flushing = false;

  let sentCount = 0;
  let lastSentAt: number | null = null;
  let lastError: string | null = null;
  let lastTransport: 'ws' | 'http' | 'none' = 'none';

  /** Batches handed to the socket, oldest first, awaiting confirmation. */
  const wsOutstanding: Array<{ ids: string[]; at: number }> = [];

  const config = (): CollectorConfig | null => {
    try {
      return deps.config();
    } catch {
      return null;
    }
  };

  const pendingCount = (): number => {
    const s = deps.ring.stats();
    // Entries that reached the ring, were not evicted-before-upload, and have
    // not been confirmed. Clamped because `dropped` also counts the (never
    // expected) duplicate-id case, which is not part of totalPushed.
    return Math.max(0, s.totalPushed - s.dropped - sentCount);
  };

  const status = (): UploaderStatus => ({
    connected: socket !== null && socket.readyState === 1,
    transport: socket !== null && socket.readyState === 1 ? 'ws' : lastTransport === 'http' ? 'http' : 'none',
    lastError,
    sent: sentCount,
    pending: pendingCount(),
    lastSentAt,
  });

  const publish = (): void => {
    try {
      deps.onStatus(status());
    } catch {
      /* a status listener must never break the uploader */
    }
  };

  /* -------------------------------------------------------------- *
   * Endpoints
   * -------------------------------------------------------------- */

  const baseUrl = (): string => {
    const cfg = config();
    const raw = cfg ? cfg.serverUrl : '';
    return raw.replace(/\/+$/, '');
  };

  const wsEndpoint = (): string | null => {
    const base = baseUrl();
    if (!base) return null;
    try {
      const u = new URL(base);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws/collector`;
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return null;
    }
  };

  /* -------------------------------------------------------------- *
   * WebSocket transport
   * -------------------------------------------------------------- */

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const nackAllOutstanding = (): void => {
    while (wsOutstanding.length > 0) {
      const batch = wsOutstanding.shift();
      if (batch) deps.ring.nackUpload(batch.ids);
    }
  };

  const scheduleReconnect = (): void => {
    if (!running) return;
    clearReconnect();
    // Exponential backoff with full jitter: a local server restarting while
    // several tabs are open would otherwise get every tab reconnecting in
    // lockstep forever.
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 8));
    const delay = BACKOFF_MIN_MS + Math.random() * Math.max(0, ceiling - BACKOFF_MIN_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (!running || NativeWebSocket === null) return;
    const cfg = config();
    if (cfg === null || !cfg.upload) return;
    if (socket !== null && (socket.readyState === 0 || socket.readyState === 1)) return;

    const url = wsEndpoint();
    if (url === null) {
      lastError = 'Server URL is not a valid URL.';
      publish();
      return;
    }

    let ws: WebSocket;
    try {
      ws = new NativeWebSocket(url);
    } catch (e) {
      lastError = `Could not open the collector socket: ${errText(e)}`;
      publish();
      scheduleReconnect();
      return;
    }

    socket = ws;
    socketUrl = url;

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      attempt = 0;
      lastError = null;
      lastTransport = 'ws';
      // Announce ourselves so the server can list connected collectors before
      // any capture exists. The socket protocol is envelope-based - every frame
      // carries a `type` and the server drops anything without one - so this is
      // a 'hello', not a bare batch.
      try {
        ws.send(JSON.stringify({ type: 'hello', identity: deps.identity() }));
      } catch {
        /* the flush loop will retry */
      }
      publish();
      void flush();
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (socket !== ws) return;
      try {
        if (typeof ev.data !== 'string') return;
        const parsed: unknown = JSON.parse(ev.data);
        if (isIngestResult(parsed)) {
          // The server processes batches in order, so the oldest outstanding
          // batch is the one this result belongs to.
          const batch = wsOutstanding.shift();
          if (batch) confirm(batch.ids);
          return;
        }
        if (isCollectorCommand(parsed)) {
          try {
            deps.onCommand(parsed);
          } catch {
            /* a bad command handler must not kill the socket */
          }
        }
      } catch {
        // Unparseable server chatter is ignored rather than treated as an
        // error: it is not the page's problem and not evidence of data loss.
      }
    });

    const drop = (why: string): void => {
      if (socket !== ws) return;
      socket = null;
      lastError = why;
      lastTransport = 'none';
      nackAllOutstanding();
      publish();
      scheduleReconnect();
    };

    ws.addEventListener('close', (ev: CloseEvent) => {
      drop(ev.wasClean ? 'Collector socket closed.' : `Collector socket closed (code ${ev.code}).`);
    });
    ws.addEventListener('error', () => {
      // The error event carries no detail; close follows, which does the work.
      if (socket === ws) lastError = `Collector socket error against ${socketUrl}.`;
    });
  };

  const disconnect = (): void => {
    clearReconnect();
    const ws = socket;
    socket = null;
    nackAllOutstanding();
    if (ws === null) return;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  };

  /* -------------------------------------------------------------- *
   * Batching
   * -------------------------------------------------------------- */

  const confirm = (ids: string[]): void => {
    deps.ring.ackUpload(ids);
    sentCount += ids.length;
    lastSentAt = Date.now();
    publish();
  };

  /** Times out WS batches the socket has demonstrably drained. */
  const reapOutstanding = (): void => {
    const now = Date.now();
    while (wsOutstanding.length > 0) {
      const head = wsOutstanding[0];
      if (!head || now - head.at < WS_ACK_TIMEOUT_MS) return;
      wsOutstanding.shift();
      const drained = socket !== null && socket.readyState === 1 && socket.bufferedAmount === 0;
      if (drained) {
        // The bytes left the browser and the socket is still healthy. Treating
        // that as delivered is the honest reading; if the server had rejected
        // it we would have had a result message.
        confirm(head.ids);
      } else {
        deps.ring.nackUpload(head.ids);
      }
    }
  };

  const takeBatch = (): RawCapture[] => {
    const taken = deps.ring.takeForUpload(MAX_BATCH);
    if (taken.length === 0) return taken;
    let bytes = 0;
    const keep: RawCapture[] = [];
    const giveBack: string[] = [];
    for (const c of taken) {
      const size = estimateBytes(c);
      // Always keep at least one, even if it alone blows the budget: the
      // alternative is a capture that can never be uploaded at all.
      if (keep.length > 0 && bytes + size > BATCH_BYTE_BUDGET) {
        giveBack.push(c.captureId);
        continue;
      }
      bytes += size;
      keep.push(c);
    }
    if (giveBack.length > 0) deps.ring.nackUpload(giveBack);
    return keep;
  };

  const postBatch = async (batch: IngestBatch, ids: string[]): Promise<void> => {
    if (nativeFetch === null) {
      deps.ring.nackUpload(ids);
      lastError = 'This context has no fetch to upload with.';
      publish();
      return;
    }
    const base = baseUrl();
    if (!base) {
      deps.ring.nackUpload(ids);
      return;
    }
    const payload = JSON.stringify(batch);
    try {
      const res = await nativeFetch(`${base}/api/ingest`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: payload,
        // Only under the keepalive body cap; above it Chrome refuses the
        // request outright and we would lose the batch to a silent failure.
        keepalive: payload.length <= KEEPALIVE_MAX_BYTES,
      });
      if (!res.ok) {
        deps.ring.nackUpload(ids);
        lastError = `Ingest returned HTTP ${res.status}.`;
        lastTransport = 'none';
        publish();
        return;
      }
      lastTransport = 'http';
      lastError = null;
      confirm(ids);
    } catch (e) {
      // The server being down is the common case here and is not an error the
      // user needs to act on - it is recorded and the ring keeps the data.
      deps.ring.nackUpload(ids);
      lastError = `Could not reach ${base}: ${errText(e)}`;
      lastTransport = 'none';
      publish();
    }
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      const cfg = config();
      if (cfg === null || !cfg.upload) return;

      reapOutstanding();

      const captures = takeBatch();
      if (captures.length === 0) return;
      const ids = captures.map((c) => c.captureId);
      const batch: IngestBatch = {
        v: PROTOCOL_VERSION,
        identity: deps.identity(),
        captures,
        dropped: deps.ring.stats().dropped,
      };

      if (socket !== null && socket.readyState === 1) {
        try {
          // Envelope, not a bare batch: /ws/collector multiplexes ingest,
          // frames and hello over one socket, and a frame with no `type` is
          // discarded server-side without a word.
          socket.send(JSON.stringify({ type: 'ingest', batch }));
          wsOutstanding.push({ ids, at: Date.now() });
          lastTransport = 'ws';
          return;
        } catch (e) {
          // A send that throws never left the browser; fall through to HTTP
          // rather than pretending it was delivered.
          lastError = `Socket send failed: ${errText(e)}`;
        }
      }

      await postBatch(batch, ids);
    } catch (e) {
      lastError = errText(e);
    } finally {
      flushing = false;
    }
  };

  /* -------------------------------------------------------------- *
   * Public surface
   * -------------------------------------------------------------- */

  const start = (): void => {
    if (running) return;
    running = true;
    const cfg = config();
    const interval = cfg && Number.isFinite(cfg.flushIntervalMs) ? Math.max(250, cfg.flushIntervalMs) : 1500;
    flushTimer = setInterval(() => {
      void flush();
    }, interval);
    connect();
    publish();
  };

  const stop = (): void => {
    running = false;
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    disconnect();
    lastTransport = 'none';
    publish();
  };

  const sendFrameReport = (report: FrameReport): void => {
    const base = baseUrl();
    if (nativeFetch === null || !base) return;
    const cfg = config();
    if (cfg === null || !cfg.upload) return;
    // Fire and forget over HTTP: /api/frames is the documented route, and the
    // collector socket's protocol is ingest-only.
    void nativeFetch(`${base}/api/frames`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }).then(
      () => undefined,
      (e: unknown) => {
        lastError = `Could not send the frame report: ${errText(e)}`;
        publish();
      },
    );
  };

  return {
    start,
    stop,
    flushNow: () => flush(),
    status,
    sendFrameReport,
  };
}
