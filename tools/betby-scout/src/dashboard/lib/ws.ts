/**
 * Reconnecting WebSocket to the Scout server's `/ws` dashboard channel.
 *
 * The thing this has to survive is the developer restarting the server twenty
 * times an hour while the dashboard stays open. So:
 *
 *   - one socket per page, shared by every subscriber (a table, a header dot and
 *     a stats card must not open three sockets);
 *   - exponential backoff with jitter, because a fleet of one still shouldn't
 *     hammer a socket that is refusing connections;
 *   - immediate retry when the tab becomes visible or the machine comes back
 *     online, so returning to the tab does not mean waiting out a 15s backoff;
 *   - unparseable frames are counted and reported, never silently dropped.
 *
 * Nothing here originates sportsbook traffic. It only listens to our own local
 * server on 127.0.0.1.
 */

import { useEffect, useRef, useState } from 'react';

import type { ServerEvent } from '../../shared/types.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface SocketStatus {
  state: ConnectionState;
  /** Consecutive failed connection attempts. Resets to 0 on a successful open. */
  attempts: number;
  /** When the last event of any type arrived. */
  lastEventTs: number | null;
  /** Last transport-level problem, for the tooltip on the connection dot. */
  lastError: string | null;
  /** Frames that arrived but did not look like a ServerEvent. */
  malformedFrames: number;
}

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: SocketStatus) => void;

const KNOWN_EVENT_TYPES = new Set(['hello', 'capture', 'stats', 'frames', 'collector']);

function isServerEvent(value: unknown): value is ServerEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && KNOWN_EVENT_TYPES.has(type);
}

function socketUrl(): string {
  // Same-origin: Vite proxies /ws in dev, the server serves the SPA in a build.
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
}

class ScoutSocket {
  private ws: WebSocket | null = null;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private retryTimer: number | null = null;
  private listenersBound = false;

  private status: SocketStatus = {
    state: 'closed',
    attempts: 0,
    lastEventTs: null,
    lastError: null,
    malformedFrames: 0,
  };

  getStatus(): SocketStatus {
    return this.status;
  }

  subscribe(onEvent: EventHandler, onStatus?: StatusHandler): () => void {
    this.eventHandlers.add(onEvent);
    if (onStatus) this.statusHandlers.add(onStatus);
    this.bindWindowListeners();
    this.connect();
    return () => {
      this.eventHandlers.delete(onEvent);
      if (onStatus) this.statusHandlers.delete(onStatus);
      // The socket is deliberately left open when the last subscriber leaves.
      // React StrictMode mounts, unmounts and remounts every effect in dev, and
      // tearing the socket down on that cycle produces a permanent reconnect
      // loop that looks exactly like a broken server.
    };
  }

  private bindWindowListeners(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;
    window.addEventListener('online', () => this.connectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.connectNow();
    });
  }

  /** Cancels any pending backoff and retries immediately. */
  private connectNow(): void {
    if (this.status.state === 'open') return;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connect();
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus({ state: 'connecting' });

    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl());
    } catch (err) {
      this.setStatus({ state: 'closed', lastError: err instanceof Error ? err.message : String(err) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.setStatus({ state: 'open', attempts: 0, lastError: null });
    });

    ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== 'string') {
        // The dashboard channel is JSON text only; a binary frame here means
        // the two sides disagree about the protocol, which is worth surfacing.
        this.setStatus({ malformedFrames: this.status.malformedFrames + 1, lastError: 'Received a non-text frame on /ws' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data) as unknown;
      } catch {
        this.setStatus({ malformedFrames: this.status.malformedFrames + 1, lastError: 'Received a frame that was not JSON' });
        return;
      }
      if (!isServerEvent(parsed)) {
        this.setStatus({ malformedFrames: this.status.malformedFrames + 1, lastError: 'Received a frame with an unrecognised event type' });
        return;
      }
      this.setStatus({ lastEventTs: Date.now() });
      for (const handler of this.eventHandlers) {
        try {
          handler(parsed);
        } catch (err) {
          // One misbehaving subscriber must not stop the others from updating.
          console.error('Betby Scout: a /ws subscriber threw', err);
        }
      }
    });

    ws.addEventListener('error', () => {
      // The error event carries no useful detail in browsers; the close event
      // that follows is where the reconnect actually happens.
      this.setStatus({ lastError: 'WebSocket error - is the Scout server running on 127.0.0.1:8787?' });
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.setStatus({ state: 'closed' });
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const attempts = this.status.attempts + 1;
    this.setStatus({ attempts });
    // 500ms doubling to a 15s ceiling, plus up to 30% jitter.
    const base = Math.min(500 * 2 ** Math.min(attempts - 1, 5), 15_000);
    const delay = base * (1 + Math.random() * 0.3);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(patch: Partial<SocketStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const handler of this.statusHandlers) handler(this.status);
  }
}

export const scoutSocket = new ScoutSocket();

/**
 * Subscribes a component to the live stream.
 *
 * The handler is held in a ref so a component can close over changing state
 * without re-subscribing on every render - re-subscribing per render would
 * churn the handler set hundreds of times a second while captures stream in.
 */
export function useServerEvents(onEvent: EventHandler): SocketStatus {
  const [status, setStatus] = useState<SocketStatus>(() => scoutSocket.getStatus());
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const unsubscribe = scoutSocket.subscribe(
      (event) => handlerRef.current(event),
      (next) => setStatus(next),
    );
    setStatus(scoutSocket.getStatus());
    return unsubscribe;
  }, []);

  return status;
}
