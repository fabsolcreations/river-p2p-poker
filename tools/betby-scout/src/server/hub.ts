/**
 * WebSocket fan-out.
 *
 * Two populations share one hub:
 *
 *   dashboards  connect to /ws           and receive ServerEvent
 *   collectors  connect to /ws/collector and exchange ingest / CollectorCommand
 *
 * The hub owns no sockets of its own and knows nothing about Fastify or `ws`.
 * It talks to a minimal structural `HubSocket` interface, which keeps it unit
 * testable with a fake socket and means the transport can change without
 * touching the fan-out logic.
 *
 * The two behaviours that matter under a live feed:
 *
 * **Stats are throttled, not recomputed per capture.** `stats()` runs five
 * aggregate queries over the whole capture table. A BETBY live feed can push
 * hundreds of WebSocket frames a second; recomputing per capture would spend
 * every cycle in SQLite and starve the ingest path. Instead a capture marks
 * stats dirty and at most one recompute happens per `statsIntervalMs`.
 *
 * **A slow dashboard is dropped from, never buffered for.** If a client's send
 * buffer is already backed up, further *droppable* events are discarded and
 * counted. This is safe because the database is the source of truth: a
 * dashboard that missed live frames re-reads /api/captures and is immediately
 * correct again. Buffering instead would grow without bound and take the server
 * down with the tab that stopped reading.
 */

import type {
  CaptureStats,
  CollectorCommand,
  CollectorConfig,
  CollectorIdentity,
  FrameReport,
  RawCapture,
  ServerEvent,
} from '../shared/types.ts';
import { PROTOCOL_VERSION } from '../shared/types.ts';

/** WebSocket.OPEN. Spelled out so this module needs no ws import. */
const OPEN = 1;

/**
 * Bytes already queued on a socket beyond which we stop sending droppable
 * events to it. 1 MB is roughly one large capture body: past that the client is
 * not keeping up in any meaningful sense.
 */
const BACKPRESSURE_BYTES = 1_000_000;

/** The subset of a `ws` socket the hub uses. */
export interface HubSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DashboardClient {
  readonly id: number;
  readonly socket: HubSocket;
  readonly connectedAt: number;
  /** Events discarded because this client was not draining its buffer. */
  droppedEvents: number;
}

export interface CollectorClient {
  readonly id: number;
  readonly socket: HubSocket;
  readonly connectedAt: number;
  /** Null until the collector sends its first ingest batch or hello. */
  identity: CollectorIdentity | null;
}

export interface HubOptions {
  /** Recomputes CaptureStats. Called at most once per `statsIntervalMs`. */
  stats: () => CaptureStats;
  /** Minimum ms between stats broadcasts. */
  statsIntervalMs?: number;
  /** Where the hub reports its own failures. Defaults to console.error. */
  onError?: (message: string, err: unknown) => void;
}

export interface HubCounts {
  dashboards: number;
  collectors: number;
  droppedEvents: number;
  statsBroadcasts: number;
  captureBroadcasts: number;
}

export class Hub {
  private readonly dashboards = new Set<DashboardClient>();
  private readonly collectors = new Set<CollectorClient>();
  private readonly statsProvider: () => CaptureStats;
  private readonly statsIntervalMs: number;
  private readonly onError: (message: string, err: unknown) => void;

  private nextId = 1;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private statsDirty = false;
  private lastStatsAt = 0;
  private stopped = false;

  private droppedEvents = 0;
  private statsBroadcasts = 0;
  private captureBroadcasts = 0;

  constructor(options: HubOptions) {
    this.statsProvider = options.stats;
    this.statsIntervalMs = options.statsIntervalMs ?? 1000;
    this.onError =
      options.onError ??
      ((message, err) => {
        console.error(`[hub] ${message}`, err);
      });
  }

  counts(): HubCounts {
    return {
      dashboards: this.dashboards.size,
      collectors: this.collectors.size,
      droppedEvents: this.droppedEvents,
      statsBroadcasts: this.statsBroadcasts,
      captureBroadcasts: this.captureBroadcasts,
    };
  }

  /** Identities of connected collectors, in connection order. */
  identities(): CollectorIdentity[] {
    const out: CollectorIdentity[] = [];
    for (const client of this.collectors) {
      if (client.identity) out.push(client.identity);
    }
    return out;
  }

  /* ---------------- dashboards ---------------- */

  attachDashboard(socket: HubSocket): DashboardClient {
    const client: DashboardClient = { id: this.nextId++, socket, connectedAt: Date.now(), droppedEvents: 0 };
    this.dashboards.add(client);
    // A fresh dashboard needs the current picture immediately; waiting for the
    // next capture would leave it blank on a quiet feed.
    this.sendTo(client, { type: 'hello', v: PROTOCOL_VERSION, serverTime: Date.now() }, false);
    this.sendTo(client, this.collectorEvent(), false);
    this.markStatsDirty();
    return client;
  }

  detachDashboard(client: DashboardClient): void {
    this.dashboards.delete(client);
  }

  /* ---------------- collectors ---------------- */

  attachCollector(socket: HubSocket): CollectorClient {
    const client: CollectorClient = { id: this.nextId++, socket, connectedAt: Date.now(), identity: null };
    this.collectors.add(client);
    this.broadcastCollectorState();
    return client;
  }

  detachCollector(client: CollectorClient): void {
    if (this.collectors.delete(client)) this.broadcastCollectorState();
  }

  /** Records who a collector socket belongs to, and tells the dashboards. */
  identifyCollector(client: CollectorClient, identity: CollectorIdentity): void {
    const changed = client.identity?.sessionId !== identity.sessionId;
    client.identity = identity;
    if (changed) this.broadcastCollectorState();
  }

  /** Sends a command to one collector. Returns false if the socket was unusable. */
  sendCommand(client: CollectorClient, command: CollectorCommand): boolean {
    return this.sendRaw(client.socket, command, false, () => this.collectors.delete(client));
  }

  /** Pushes a config change to every connected collector. */
  broadcastConfig(config: CollectorConfig): number {
    return this.broadcastCommand({ type: 'config', config });
  }

  broadcastCommand(command: CollectorCommand): number {
    let sent = 0;
    for (const client of [...this.collectors]) {
      if (this.sendCommand(client, command)) sent += 1;
    }
    return sent;
  }

  /* ---------------- events out ---------------- */

  /**
   * Broadcasts accepted captures and schedules a stats refresh.
   *
   * Capture events are droppable: they are a live tail, and every one of them
   * is already durably in SQLite by the time this runs.
   */
  broadcastCaptures(captures: readonly RawCapture[]): void {
    for (const capture of captures) {
      const event: ServerEvent = { type: 'capture', capture };
      for (const client of [...this.dashboards]) this.sendTo(client, event, true);
      this.captureBroadcasts += 1;
    }
    if (captures.length > 0) this.markStatsDirty();
  }

  broadcastFrames(report: FrameReport): void {
    const event: ServerEvent = { type: 'frames', report };
    for (const client of [...this.dashboards]) this.sendTo(client, event, false);
  }

  broadcastCollectorState(): void {
    const event = this.collectorEvent();
    for (const client of [...this.dashboards]) this.sendTo(client, event, false);
  }

  private collectorEvent(): ServerEvent {
    return { type: 'collector', connected: this.collectors.size, identities: this.identities() };
  }

  /* ---------------- throttled stats ---------------- */

  /** Marks the stats stale. The broadcast happens on the throttle boundary. */
  markStatsDirty(): void {
    if (this.stopped) return;
    this.statsDirty = true;
    this.scheduleStats();
  }

  private scheduleStats(): void {
    if (this.statsTimer !== null || this.dashboards.size === 0) return;
    const wait = Math.max(0, this.statsIntervalMs - (Date.now() - this.lastStatsAt));
    const timer = setTimeout(() => {
      this.statsTimer = null;
      this.flushStats();
    }, wait);
    // The timer must never be the reason the process refuses to exit. Node's
    // handle has unref(); the DOM's numeric handle does not, and this file is
    // typechecked against both lib sets, so the capability is probed.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    this.statsTimer = timer;
  }

  /** Recomputes and broadcasts now. Exposed for tests; normally timer-driven. */
  flushStats(): void {
    if (this.stopped || !this.statsDirty || this.dashboards.size === 0) return;
    this.statsDirty = false;
    this.lastStatsAt = Date.now();
    let stats: CaptureStats;
    try {
      stats = this.statsProvider();
    } catch (err) {
      // A failed stats query must not take the socket layer down with it; the
      // dashboards simply keep the numbers they had.
      this.onError('failed to compute stats for broadcast', err);
      return;
    }
    const event: ServerEvent = { type: 'stats', stats };
    this.statsBroadcasts += 1;
    for (const client of [...this.dashboards]) this.sendTo(client, event, true);
  }

  /* ---------------- send plumbing ---------------- */

  private sendTo(client: DashboardClient, event: ServerEvent, droppable: boolean): boolean {
    if (droppable && client.socket.bufferedAmount > BACKPRESSURE_BYTES) {
      client.droppedEvents += 1;
      this.droppedEvents += 1;
      // The client is behind, so its totals are wrong. Leaving stats dirty means
      // it gets a corrected count as soon as it drains.
      this.statsDirty = true;
      return false;
    }
    return this.sendRaw(client.socket, event, droppable, () => this.dashboards.delete(client));
  }

  private sendRaw(socket: HubSocket, payload: unknown, droppable: boolean, onDead: () => void): boolean {
    if (socket.readyState !== OPEN) {
      onDead();
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      // A send that throws means the socket is gone in a way readyState had not
      // caught up with yet. Drop the client rather than retrying into a void.
      onDead();
      if (!droppable) this.onError('failed to send on a websocket', err);
      return false;
    }
  }

  /** Cancels the pending timer and closes every socket. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.statsTimer !== null) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
    for (const client of [...this.dashboards]) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        /* already gone */
      }
    }
    for (const client of [...this.collectors]) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        /* already gone */
      }
    }
    this.dashboards.clear();
    this.collectors.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Collector -> server messages
 *
 * The collector may push batches over its socket instead of POSTing them. The
 * message set is deliberately tiny and is validated structurally here, because
 * it arrives from a web page.
 * ------------------------------------------------------------------ */

export type CollectorMessage =
  | { type: 'ingest'; batch: unknown }
  | { type: 'frames'; report: unknown }
  | { type: 'hello'; identity: unknown }
  | { type: 'pong'; ts: number };

export function parseCollectorMessage(data: unknown): CollectorMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  switch (record['type']) {
    case 'ingest':
      return { type: 'ingest', batch: record['batch'] };
    case 'frames':
      return { type: 'frames', report: record['report'] };
    case 'hello':
      return { type: 'hello', identity: record['identity'] };
    case 'pong':
      return { type: 'pong', ts: typeof record['ts'] === 'number' ? record['ts'] : 0 };
    default:
      return null;
  }
}

/**
 * Validates a CollectorIdentity that arrived from a page. Every field must be
 * present and the right type; we do not fill in plausible values, because the
 * identity is what a session row is keyed and attributed by.
 */
export function parseIdentity(input: unknown): CollectorIdentity | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = record['kind'];
  const sessionId = record['sessionId'];
  if (kind !== 'extension' && kind !== 'userscript') return null;
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) return null;
  const text = (key: string, max: number): string => {
    const value = record[key];
    return typeof value === 'string' ? value.slice(0, max) : '';
  };
  return {
    kind,
    sessionId,
    version: text('version', 64),
    pageOrigin: text('pageOrigin', 2048),
    frameOrigin: text('frameOrigin', 2048),
    isTopFrame: record['isTopFrame'] === true,
    userAgent: text('userAgent', 1024),
  };
}
