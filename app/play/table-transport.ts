import { randomHex } from "./proof";
import type { TranscriptEntry } from "./proof";
import type { TableProofBundle } from "../../worker/table-engine";
import type { SeedAck } from "../../worker/fairness-attestation";

/**
 * Client-side WebSocket wrapper for /api/table/<roomCode> - a plain
 * client-to-server connection to the PokerTable Durable Object (see
 * worker/poker-table.ts, which is the source of truth for these message
 * shapes; restated here rather than imported, keeping client/server types
 * decoupled). Dealing/betting needs no WebRTC/ICE - the server is the
 * trusted dealer, so there's no peer-to-peer connection to negotiate there.
 * Voice chat is the one exception: this same socket also carries WebRTC
 * signaling (offer/answer/ICE) for a peer-to-peer audio mesh between
 * seats - the DO only relays those opaque payloads, never touches media.
 */

export type Seat = number;
export type ActionType = "fold" | "call" | "check" | "raise" | "bet";

export type ChatMessage = { seat: Seat; text: string; ts: number };

export type ClientMessage =
  | { type: "sit"; seatHint?: Seat; buyIn?: number; seed?: string }
  | { type: "action"; action: ActionType; amount?: number }
  | { type: "ready-for-next-hand" }
  | { type: "chat"; text: string }
  | { type: "leave-table" }
  | { type: "voice-join" }
  | { type: "voice-leave" }
  | { type: "voice-signal"; toSeat: Seat; signal: unknown }
  | { type: "update-settings"; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number; actionClockSeconds: number }
  | { type: "rabbit-hunt" }
  | { type: "provide-seed"; seed: string };

export type PublicHandState = {
  handId: string | null;
  street: "waiting" | "preflop" | "flop" | "turn" | "river" | "complete";
  seatCount: number;
  seatsOccupied: boolean[];
  hostSeat: Seat | null;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  // 0 means no clock. actionDeadline is the epoch ms the acting seat gets
  // auto-folded/checked at, when a hand is in progress and the clock is on.
  actionClockSeconds: number;
  actionDeadline: number | null;
  // True for a room opened via the lounge "Join <tier>" matchmaker - stakes
  // stay house-managed (worker/poker-table.ts rejects host settings changes
  // on these), so the client hides the settings gear entirely.
  isLounge: boolean;
  // The NEXT hand's server-entropy commitment and hand id, both published
  // before that hand's client seeds are collected - record these before you
  // play and check them against the bundle afterwards (see
  // table-engine.ts's serverSeedCommitment).
  nextServerSeedCommitment: string;
  nextHandId: string;
  rabbitHuntRevealed: boolean;
  buttonSeat: Seat | null;
  smallBlindSeat: Seat | null;
  bigBlindSeat: Seat | null;
  board: string[];
  pot: number;
  stacks: number[];
  toAct: Seat | null;
  // Derive this seat's own facing bet as
  // Math.max(...streetContributed) - streetContributed[mySeat].
  streetContributed: number[];
  commitments: (string | null)[];
  // "client" if that seat's own browser supplied this hand's randomness,
  // "server" only if it fell back to server-generated randomness because
  // no client seed had arrived in time.
  seedSources: ("client" | "server" | null)[];
  minRaiseIncrement: number;
  allIn: boolean[];
  folded: boolean[];
  transcript: TranscriptEntry[];
};

export type SidePot = { amount: number; eligibleSeats: Seat[]; winners: Seat[] };

export type ServerMessage =
  | { type: "seat-assigned"; seat: Seat }
  // Operator-signed proof that this seat's seed was received for the named
  // hand. Kept locally (see SEED_ACK_STORAGE_KEY) so a later substitution
  // can be proven, not just suspected.
  | { type: "seed-ack"; ack: SeedAck }
  | { type: "hole-cards"; handId: string; cards: [string, string] }
  | { type: "state"; state: PublicHandState }
  | { type: "hand-complete"; sidePots: SidePot[]; payouts: number[]; bundle: TableProofBundle }
  | { type: "opponent-left"; seat: Seat }
  | { type: "chat"; message: ChatMessage }
  | { type: "chat-history"; messages: ChatMessage[] }
  | { type: "left-table"; payout: number }
  | { type: "voice-presence"; seats: Seat[] }
  | { type: "voice-joined"; seat: Seat }
  | { type: "voice-left"; seat: Seat }
  | { type: "voice-signal"; fromSeat: Seat; signal: unknown }
  | { type: "error"; message: string };

export type TransportStatus = "connecting" | "open" | "closed";

export interface TableConnection {
  send(message: ClientMessage): void;
  subscribe(listener: (message: ServerMessage) => void): () => void;
  onStatusChange(listener: (status: TransportStatus) => void): () => void;
  close(): void;
}

const RECONNECT_DELAY_MS = 1500;

// Signed seed acknowledgements are only worth anything if they outlive the
// hand, so they go in localStorage rather than sessionStorage - the point is
// to still have them days later when a receipt looks wrong.
export const SEED_ACK_STORAGE_KEY = "river-seed-acks";
const SEED_ACK_LIMIT = 200;

export function storeSeedAck(ack: SeedAck): void {
  try {
    const acks = readSeedAcks().filter((existing) => !(existing.handId === ack.handId && existing.seat === ack.seat));
    acks.push(ack);
    // Bounded so a long session can't fill the origin's storage quota; the
    // oldest go first, since a dispute is almost always about a recent hand.
    window.localStorage.setItem(SEED_ACK_STORAGE_KEY, JSON.stringify(acks.slice(-SEED_ACK_LIMIT)));
  } catch {
    // Storage disabled or full - the hand is unaffected, only the ability to
    // prove a substitution afterwards is lost.
  }
}

export function readSeedAcks(): SeedAck[] {
  try {
    const raw = window.localStorage.getItem(SEED_ACK_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SeedAck[]) : [];
  } catch {
    return [];
  }
}

export function findSeedAck(handId: string, seat: number): SeedAck | undefined {
  return readSeedAcks().find((ack) => ack.handId === handId && ack.seat === seat);
}

export type InitialTableSettings = { smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number; isLounge?: boolean };

export function randomRoomCode() {
  const bytes = new Uint8Array(3);
  window.crypto.getRandomValues(bytes);
  return `TABLE-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function connectTable(
  roomCode: string,
  seatCount = 6,
  initialSettings?: InitialTableSettings,
  autoSit = false,
): TableConnection {
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const statusListeners = new Set<(status: TransportStatus) => void>();
  let ws: WebSocket | null = null;
  let closedByCaller = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const seatKey = `river-table-seat-${roomCode}`;

  function setStatus(status: TransportStatus) {
    for (const listener of statusListeners) listener(status);
  }

  function socketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ seats: String(seatCount) });
    // Only meaningful the moment a room is first created (see poker-table.ts
    // fetch()) - a room that already exists ignores these, so it's harmless
    // to keep sending them on every reconnect of the same tab.
    if (initialSettings) {
      params.set("smallBlind", String(initialSettings.smallBlind));
      params.set("bigBlind", String(initialSettings.bigBlind));
      params.set("minBuyIn", String(initialSettings.minBuyIn));
      params.set("maxBuyIn", String(initialSettings.maxBuyIn));
      if (initialSettings.isLounge) params.set("lounge", "1");
    }
    return `${protocol}//${window.location.host}/api/table/${encodeURIComponent(roomCode)}?${params.toString()}`;
  }

  function open() {
    closedByCaller = false;
    setStatus("connecting");
    ws = new WebSocket(socketUrl());

    ws.onopen = () => {
      setStatus("open");
      // Only auto-resume a seat this same tab already held (a real
      // reconnect, e.g. a network blip or page refresh) - a brand-new
      // visitor lands as a spectator and explicitly chooses to sit down
      // (and how much to buy in for), PokerNow-style. See sitDown() below.
      const storedSeat = window.sessionStorage.getItem(seatKey);
      const parsedSeat = storedSeat === null ? NaN : Number(storedSeat);
      if (Number.isInteger(parsedSeat) && parsedSeat >= 0) send({ type: "sit", seatHint: parsedSeat as Seat });
      // Lounge "Join <tier>" arrivals (app/lobby/page.tsx) skip the normal
      // spectate-first flow - but only for a genuinely fresh visitor. A
      // real reconnect (storedSeat above) always takes priority so this
      // never double-sits the same tab into two seats.
      else if (autoSit) send({ type: "sit" });
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "seat-assigned") {
        window.sessionStorage.setItem(seatKey, String(message.seat));
      } else if (message.type === "seed-ack") {
        storeSeedAck(message.ack);
      }
      for (const listener of messageListeners) listener(message);
    };

    ws.onclose = () => {
      setStatus("closed");
      if (!closedByCaller) scheduleReconnect();
    };
    ws.onerror = () => {
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (closedByCaller || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closedByCaller) open();
    }, RECONNECT_DELAY_MS);
  }

  function send(message: ClientMessage) {
    // A deliberate stand-up should never come back as the same seat on the
    // next reconnect (that seat is gone - the server just cashed it out).
    if (message.type === "leave-table") window.sessionStorage.removeItem(seatKey);
    // Every "sit" carries this seat's own randomness for the shuffle,
    // generated right here rather than the server generating it alone -
    // see worker/table-engine.ts's EngineState.seedSources. Attached here
    // (not left to each call site) so both a deliberate sit-down and the
    // automatic reconnect-resume above always include one - simplest to
    // just always send it, even though the server's fixed-window fair-start
    // delay (poker-table.ts's armHandStart) now gives a follow-up message
    // real margin too.
    const outgoing = message.type === "sit" && !message.seed ? { ...message, seed: randomHex() } : message;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(outgoing));
  }

  open();

  return {
    send,
    subscribe(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    close() {
      closedByCaller = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    },
  };
}
