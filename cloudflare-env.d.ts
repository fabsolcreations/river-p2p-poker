interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
  error?: string;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

// --- Durable Objects + hibernatable WebSockets (minimal, hand-written -
// this project deliberately avoids depending on @cloudflare/workers-types).
// Only NEW members are merged onto the existing DOM `WebSocket`/
// `ResponseInit` globals below - never redeclare members DOM's lib.dom.d.ts
// already provides (send/close/addEventListener/etc), since a conflicting
// redeclaration fails to merge.

interface WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: {
  new (): WebSocketPair;
};

interface ResponseInit {
  webSocket?: WebSocket;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    // Hot signing key for EscrowVault.sol's `operator` role (worker/chain.ts) -
    // a real secret, never committed. Local dev reads it from a root
    // .dev.vars file (see .dev.vars.example); a real deploy needs its own
    // secret-store equivalent, not yet wired (see worker/chain-config.ts).
    OPERATOR_PRIVATE_KEY?: string;
    [key: string]: unknown;
  };
}
