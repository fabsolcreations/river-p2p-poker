import { randomHex } from "./proof";
import type { TranscriptEntry } from "./proof";
import type { TableProofBundle } from "../../worker/table-engine";

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
  | { type: "update-settings"; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number }
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

export type InitialTableSettings = { smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number };

export function connectTable(roomCode: string, seatCount = 6, initialSettings?: InitialTableSettings): TableConnection {
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
    // automatic reconnect-resume above always include one - the seed must
    // arrive in the SAME message as the sit, not a later follow-up, since
    // the server may start a hand synchronously the instant this seat
    // fills the table.
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
