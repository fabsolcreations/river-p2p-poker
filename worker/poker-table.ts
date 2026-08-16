import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { handParticipants, hands, ledgerEntries, tables, users } from "../db/schema";
import { getSessionUser } from "./auth";
import {
  applyAction,
  buildProofBundle,
  startHand,
  IllegalActionError,
  type ActionType,
  type EngineState,
  type Seat,
  type TableProofBundle,
} from "./table-engine";

/**
 * PokerTable: the trusted dealer for one N-seat room (2-10 seats,
 * defaulting to 6-max - see fetch()). Holds the deck, deals each seat's
 * hole cards only to that seat's own socket, and enforces turn order via
 * table-engine.ts. Test chips only - see the roadmap in the project plan
 * for what's gated on real licensing before this ever touches real money.
 *
 * Hibernation safety: a Durable Object can be evicted from memory between
 * messages, so nothing here relies on a plain class field surviving.
 * `ctx.storage` is the source of truth (seatCount/seats/stacks/hand/
 * readyForNext); the constructor rehydrates in-memory fields from it every
 * time (cold start and post-hibernation wake look identical at the
 * constructor). Seat identity lives on each WebSocket's attachment, not a
 * Map, since seats are assigned lazily on the first "sit" message rather
 * than at accept time.
 */

// userId is null for anonymous/guest seats (the pre-accounts behavior,
// still fully supported) and the authenticated user's id otherwise - used
// to tell a genuine reconnect (same user reclaiming their seat, no new
// buy-in) apart from a new occupant taking over an abandoned seat.
type SeatRecord = { connected: boolean; userId: string | null };
type ChatMessage = { seat: Seat; text: string; ts: number };
type SocketAttachment = { seat: Seat | null; userId: string | null; username: string | null };

const CHAT_MAX_LENGTH = 240;
const CHAT_HISTORY_LIMIT = 50;

export type ClientMessage =
  // seed rides along in the sit message itself, not a separate follow-up -
  // maybeStartHand() runs synchronously at the end of handleSit, so a seed
  // sent as its own later message would almost always lose the race to a
  // table that's already full (confirmed live: two seats filling back-to-
  // back both fell back to server randomness before this fix).
  | { type: "sit"; seatHint?: Seat; buyIn?: number; seed?: string }
  | { type: "action"; action: ActionType; amount?: number }
  | { type: "ready-for-next-hand" }
  | { type: "chat"; text: string }
  | { type: "leave-table" }
  | { type: "voice-join" }
  | { type: "voice-leave" }
  | { type: "voice-signal"; toSeat: Seat; signal: unknown }
  // Host-only; rejected unless the sender IS the host seat and no hand is
  // in progress - see handleUpdateSettings.
  | { type: "update-settings"; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number }
  // Any seated player can request it once a hand has ended before the
  // river - see handleRabbitHunt. The board is already deterministically
  // fixed at hand start (commit-reveal), so this needs no new randomness,
  // just a permission gate on revealing data the server already computed.
  | { type: "rabbit-hunt" }
  // A seat's own browser-generated random contribution to the next hand's
  // shuffle - see handleProvideSeed. Sent proactively (right after sitting
  // down and again after every hand-complete), not requested by the
  // server, so it's normally already on hand by the time a hand deals.
  | { type: "provide-seed"; seed: string };

export type PublicHandState = {
  handId: string | null;
  street: EngineState["street"] | "waiting";
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
  // The client derives its own facingBet as
  // max(...streetContributed) - streetContributed[mySeat] - with N seats
  // there's no single symmetric "the" facing bet the way heads-up had.
  streetContributed: number[];
  commitments: (string | null)[];
  // Which party actually supplied each dealt seat's raw randomness -
  // "client" (that seat's own browser) or "server" (this Durable Object,
  // only as a fallback when a seat didn't supply one in time). See
  // table-engine.ts's EngineState.seedSources for why this is what makes
  // the commit-reveal scheme actually provably fair, not just tamper-evident.
  seedSources: ("client" | "server" | null)[];
  minRaiseIncrement: number;
  allIn: boolean[];
  folded: boolean[];
  transcript: EngineState["transcript"];
};

export type ServerMessage =
  | { type: "seat-assigned"; seat: Seat }
  | { type: "hole-cards"; handId: string; cards: [string, string] }
  | { type: "state"; state: PublicHandState }
  | {
      type: "hand-complete";
      sidePots: { amount: number; eligibleSeats: Seat[]; winners: Seat[] }[];
      payouts: number[]; // net chips gained (or lost, negative) this hand, per seat
      bundle: TableProofBundle;
    }
  | { type: "opponent-left"; seat: Seat }
  | { type: "chat"; message: ChatMessage }
  | { type: "chat-history"; messages: ChatMessage[] }
  | { type: "left-table"; payout: number }
  // Voice is pure WebRTC signaling relay - the DO never sees or stores any
  // media, just forwards opaque offer/answer/ICE payloads between seats.
  // voiceSeats itself is deliberately NOT persisted to ctx.storage (unlike
  // everything else in this file): it's transient real-time presence, not
  // game state, and a hibernation-triggered reset just means peers
  // re-announce - no correctness issue the way a stale roomCode was.
  | { type: "voice-presence"; seats: Seat[] }
  | { type: "voice-joined"; seat: Seat }
  | { type: "voice-left"; seat: Seat }
  | { type: "voice-signal"; fromSeat: Seat; signal: unknown }
  | { type: "error"; message: string };

const MIN_SEATS = 2;
const MAX_SEATS = 10;
const DEFAULT_SEATS = 6;
// Out-of-the-box range at the default 1/2 blinds - 20bb to 100bb. The host
// can change all four of these any time between hands (see
// handleUpdateSettings); players then choose their own buy-in within
// [minBuyIn, maxBuyIn] when sitting down (see handleSit), PokerNow-style.
const DEFAULT_SMALL_BLIND = 1;
const DEFAULT_BIG_BLIND = 2;
const DEFAULT_MIN_BUY_IN = 40;
const DEFAULT_MAX_BUY_IN = 200;

// Shared by handleUpdateSettings (a host changing an existing room) and
// fetch() (whoever creates a room choosing its opening stakes) - one rule,
// checked in both places, rather than two copies drifting apart.
function isValidTableSettings(smallBlind: number, bigBlind: number, minBuyIn: number, maxBuyIn: number): boolean {
  return (
    Number.isInteger(smallBlind) &&
    smallBlind >= 1 &&
    Number.isInteger(bigBlind) &&
    bigBlind > smallBlind &&
    Number.isInteger(minBuyIn) &&
    minBuyIn >= bigBlind * 2 &&
    Number.isInteger(maxBuyIn) &&
    maxBuyIn >= minBuyIn &&
    maxBuyIn <= 1_000_000
  );
}

export class PokerTable {
  private ctx: DurableObjectState;
  private ready = false;
  private seatCount = 0; // 0 means "not yet initialized" - see fetch()
  private seats: (SeatRecord | null)[] = [];
  private stacks: number[] = [];
  private hand: EngineState | null = null;
  private readyForNext: boolean[] = [];
  private handStartStacks: number[] = [];
  private chatLog: ChatMessage[] = [];
  private roomCode = "unknown";
  private voiceSeats = new Set<Seat>();
  // The host is whoever first takes a seat in this room; reassigned to the
  // next connected seat only when the host explicitly leaves (handleLeave),
  // deliberately NOT on a mere disconnect - a briefly-dropped host shouldn't
  // lose control of the table.
  private hostSeat: Seat | null = null;
  private smallBlind = DEFAULT_SMALL_BLIND;
  private bigBlind = DEFAULT_BIG_BLIND;
  private minBuyIn = DEFAULT_MIN_BUY_IN;
  private maxBuyIn = DEFAULT_MAX_BUY_IN;
  // Reset to false at the start of every new hand (maybeStartHand). Once
  // true, publicState() reveals the full board even past finalStreet.
  private rabbitHuntRevealed = false;
  // Client-supplied randomness for each seat's NEXT hand - deliberately
  // NOT persisted, same as voiceSeats: it's transient per-connection state,
  // not authoritative game state. If a Durable Object hibernation wipes it
  // before a hand starts, the only consequence is that seat's contribution
  // falls back to server-generated randomness for that one hand (see
  // maybeStartHand + table-engine.ts's clientSeeds fallback) - never a
  // correctness or security problem, just slightly less player-controlled
  // entropy for that single hand. Consumed and cleared the moment a hand
  // actually uses it, since reusing a seed across hands would be a real bug.
  private pendingSeeds = new Map<Seat, string>();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async hydrate(): Promise<void> {
    if (this.ready) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.seatCount = (await this.ctx.storage.get<number>("seatCount")) ?? 0;
      this.seats = (await this.ctx.storage.get<(SeatRecord | null)[]>("seats")) ?? [];
      this.stacks = (await this.ctx.storage.get<number[]>("stacks")) ?? [];
      this.hand = (await this.ctx.storage.get<EngineState | null>("hand")) ?? null;
      this.readyForNext = (await this.ctx.storage.get<boolean[]>("readyForNext")) ?? [];
      this.handStartStacks = (await this.ctx.storage.get<number[]>("handStartStacks")) ?? [];
      this.chatLog = (await this.ctx.storage.get<ChatMessage[]>("chatLog")) ?? [];
      this.roomCode = (await this.ctx.storage.get<string>("roomCode")) ?? "unknown";
      this.hostSeat = (await this.ctx.storage.get<Seat | null>("hostSeat")) ?? null;
      this.smallBlind = (await this.ctx.storage.get<number>("smallBlind")) ?? DEFAULT_SMALL_BLIND;
      this.bigBlind = (await this.ctx.storage.get<number>("bigBlind")) ?? DEFAULT_BIG_BLIND;
      this.minBuyIn = (await this.ctx.storage.get<number>("minBuyIn")) ?? DEFAULT_MIN_BUY_IN;
      this.maxBuyIn = (await this.ctx.storage.get<number>("maxBuyIn")) ?? DEFAULT_MAX_BUY_IN;
      this.rabbitHuntRevealed = (await this.ctx.storage.get<boolean>("rabbitHuntRevealed")) ?? false;
      this.ready = true;
    });
  }

  private async persist(
    keys: (
      | "seatCount"
      | "seats"
      | "stacks"
      | "hand"
      | "readyForNext"
      | "handStartStacks"
      | "chatLog"
      | "roomCode"
      | "hostSeat"
      | "smallBlind"
      | "bigBlind"
      | "minBuyIn"
      | "maxBuyIn"
      | "rabbitHuntRevealed"
    )[],
  ): Promise<void> {
    for (const key of keys) {
      if (key === "seatCount") await this.ctx.storage.put("seatCount", this.seatCount);
      else if (key === "seats") await this.ctx.storage.put("seats", this.seats);
      else if (key === "stacks") await this.ctx.storage.put("stacks", this.stacks);
      else if (key === "hand") await this.ctx.storage.put("hand", this.hand);
      else if (key === "readyForNext") await this.ctx.storage.put("readyForNext", this.readyForNext);
      else if (key === "handStartStacks") await this.ctx.storage.put("handStartStacks", this.handStartStacks);
      else if (key === "chatLog") await this.ctx.storage.put("chatLog", this.chatLog);
      else if (key === "roomCode") await this.ctx.storage.put("roomCode", this.roomCode);
      else if (key === "hostSeat") await this.ctx.storage.put("hostSeat", this.hostSeat);
      else if (key === "smallBlind") await this.ctx.storage.put("smallBlind", this.smallBlind);
      else if (key === "bigBlind") await this.ctx.storage.put("bigBlind", this.bigBlind);
      else if (key === "minBuyIn") await this.ctx.storage.put("minBuyIn", this.minBuyIn);
      else if (key === "maxBuyIn") await this.ctx.storage.put("maxBuyIn", this.maxBuyIn);
      else await this.ctx.storage.put("rabbitHuntRevealed", this.rabbitHuntRevealed);
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    if (this.seatCount === 0) {
      // First connection to this room ever - seat count and room code come
      // from the room URL and are fixed for this room's lifetime after.
      // Persisted (not just held in a field) because webSocketMessage/
      // webSocketClose fire on a hibernation-woken instance WITHOUT fetch()
      // running again - a plain field here would silently revert to
      // "unknown" the same way handStartStacks used to revert to [].
      const url = new URL(request.url);
      this.roomCode = url.pathname.match(/^\/api\/table\/([A-Za-z0-9_-]+)$/)?.[1] ?? "unknown";
      const requested = Number(url.searchParams.get("seats"));
      this.seatCount = Number.isInteger(requested) ? Math.min(MAX_SEATS, Math.max(MIN_SEATS, requested)) : DEFAULT_SEATS;
      this.seats = new Array(this.seatCount).fill(null);
      this.stacks = new Array(this.seatCount).fill(0);
      this.readyForNext = new Array(this.seatCount).fill(false);
      // The room's creator can choose opening stakes (lobby's "New table"
      // dialog offers presets) via query params, same optional-and-clamped
      // pattern as `seats` above - falls back to the defaults wholesale
      // (never a partial mix) if any of the four is missing or the set
      // doesn't pass the same sanity rule the host's later settings changes
      // are held to.
      const requestedSmallBlind = Number(url.searchParams.get("smallBlind"));
      const requestedBigBlind = Number(url.searchParams.get("bigBlind"));
      const requestedMinBuyIn = Number(url.searchParams.get("minBuyIn"));
      const requestedMaxBuyIn = Number(url.searchParams.get("maxBuyIn"));
      const openingStakesValid = isValidTableSettings(requestedSmallBlind, requestedBigBlind, requestedMinBuyIn, requestedMaxBuyIn);
      this.smallBlind = openingStakesValid ? requestedSmallBlind : DEFAULT_SMALL_BLIND;
      this.bigBlind = openingStakesValid ? requestedBigBlind : DEFAULT_BIG_BLIND;
      this.minBuyIn = openingStakesValid ? requestedMinBuyIn : DEFAULT_MIN_BUY_IN;
      this.maxBuyIn = openingStakesValid ? requestedMaxBuyIn : DEFAULT_MAX_BUY_IN;
      await this.persist(["seatCount", "seats", "stacks", "readyForNext", "roomCode", "smallBlind", "bigBlind", "minBuyIn", "maxBuyIn"]);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // Resolved once at connect time from the session cookie (if any) and
    // carried on the socket's attachment - anonymous/guest play (userId
    // null) stays fully supported, matching every prior phase.
    let sessionUser: { id: string; username: string } | null = null;
    try {
      sessionUser = await getSessionUser(request);
    } catch {
      // D1 unreachable or not migrated yet - degrade to anonymous rather
      // than failing the whole connection.
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = { seat: null, userId: sessionUser?.id ?? null, username: sessionUser?.username ?? null };
    server.serializeAttachment(attachment);
    // Spectating is now the default (no auto-sit) - without this, a
    // spectator in a room where nobody has sat yet would never learn the
    // host's blinds/buy-in range, since broadcastState() only ever fires
    // as a side effect of someone sitting down.
    this.send(server, { type: "state", state: this.publicState() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.hydrate();
    if (typeof raw !== "string") return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "sit") return this.handleSit(ws, message.seatHint, message.buyIn, message.seed);
    if (message.type === "action") return this.handleAction(ws, message.action, message.amount);
    if (message.type === "ready-for-next-hand") return this.handleReady(ws);
    if (message.type === "chat") return this.handleChat(ws, message.text);
    if (message.type === "leave-table") return this.handleLeave(ws);
    if (message.type === "voice-join") return this.handleVoiceJoin(ws);
    if (message.type === "voice-leave") return this.handleVoiceLeave(ws);
    if (message.type === "voice-signal") return this.handleVoiceSignal(ws, message.toSeat, message.signal);
    if (message.type === "update-settings")
      return this.handleUpdateSettings(ws, message.smallBlind, message.bigBlind, message.minBuyIn, message.maxBuyIn);
    if (message.type === "rabbit-hunt") return this.handleRabbitHunt(ws);
    if (message.type === "provide-seed") return this.handleProvideSeed(ws, message.seed);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.hydrate();
    await this.disconnectSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.hydrate();
    await this.disconnectSocket(ws);
  }

  private async disconnectSocket(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    const prior = this.seats[seat];
    this.seats[seat] = { connected: false, userId: prior?.userId ?? null };
    await this.persist(["seats"]);
    this.broadcast({ type: "opponent-left", seat });
    if (this.voiceSeats.delete(seat)) this.broadcast({ type: "voice-left", seat });
    await this.syncRegistry();
  }

  private attachmentOf(ws: WebSocket): SocketAttachment | null {
    return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
  }

  private seatOf(ws: WebSocket): Seat | null {
    return this.attachmentOf(ws)?.seat ?? null;
  }

  private socketFor(seat: Seat): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.seatOf(ws) === seat) return ws;
    }
    return null;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket may be mid-close; nothing to do
    }
  }

  private broadcast(message: ServerMessage, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) if (ws !== exclude) this.send(ws, message);
  }

  private broadcastState(): void {
    const state = this.publicState();
    this.broadcast({ type: "state", state });
  }

  // Durable Objects can't be listed/enumerated by Cloudflare's API, so this
  // upsert into a plain D1 table is the only way a lobby page can show
  // which rooms are actually open. Called only at occupancy/status
  // transitions (sit, leave, disconnect, hand start/end) - not on every
  // betting action, which would be a lot of D1 writes for no benefit to a
  // listing that only needs to be roughly fresh.
  private async syncRegistry(): Promise<void> {
    try {
      const db = getDb();
      const occupiedCount = this.seats.filter((seat) => seat?.connected).length;
      const status = this.hand && this.hand.street !== "complete" ? "playing" : "waiting";
      await db
        .insert(tables)
        .values({ roomCode: this.roomCode, seatCount: this.seatCount, occupiedCount, status })
        .onConflictDoUpdate({
          target: tables.roomCode,
          set: { seatCount: this.seatCount, occupiedCount, status, updatedAt: sql`CURRENT_TIMESTAMP` },
        });
    } catch {
      // Best-effort - the lobby listing is a convenience, never a gate on gameplay.
    }
  }

  // EngineState.stacks is only meaningful for seats dealt into the current
  // hand (startHand zero-fills every other slot) - a seat that connects
  // mid-hand keeps its real room-level bankroll in this.stacks until it's
  // actually dealt in, rather than showing (or persisting) a phantom 0.
  private mergedStacks(hand: EngineState): number[] {
    return this.stacks.map((roomStack, s) => (hand.inHand[s] ? hand.stacks[s] : roomStack));
  }

  private publicState(): PublicHandState {
    const seatsOccupied = this.seats.map((seat) => seat?.connected === true);
    if (!this.hand) {
      return {
        handId: null,
        street: "waiting",
        seatCount: this.seatCount,
        seatsOccupied,
        hostSeat: this.hostSeat,
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        minBuyIn: this.minBuyIn,
        maxBuyIn: this.maxBuyIn,
        rabbitHuntRevealed: false,
        buttonSeat: null,
        smallBlindSeat: null,
        bigBlindSeat: null,
        board: [],
        pot: 0,
        stacks: this.stacks,
        toAct: null,
        streetContributed: new Array(this.seatCount).fill(0),
        commitments: new Array(this.seatCount).fill(null),
        seedSources: new Array(this.seatCount).fill(null),
        minRaiseIncrement: 0,
        allIn: new Array(this.seatCount).fill(false),
        folded: new Array(this.seatCount).fill(false),
        transcript: [],
      };
    }
    // Only reveal what was actually dealt by default: mid-hand this is just
    // the current street, same as before. Once the hand is complete, use
    // finalStreet (the street actually played, e.g. "preflop" for a
    // preflop fold) instead of always showing all 5 - UNLESS a rabbit hunt
    // was requested, which is the one thing allowed to override it.
    const revealStreet = this.hand.street === "complete" && !this.rabbitHuntRevealed ? this.hand.finalStreet : this.hand.street;
    const visibleCount = { preflop: 0, flop: 3, turn: 4, river: 5, complete: 5 }[revealStreet];
    return {
      handId: this.hand.handId,
      street: this.hand.street,
      seatCount: this.seatCount,
      seatsOccupied,
      hostSeat: this.hostSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      minBuyIn: this.minBuyIn,
      maxBuyIn: this.maxBuyIn,
      rabbitHuntRevealed: this.rabbitHuntRevealed,
      buttonSeat: this.hand.buttonSeat,
      smallBlindSeat: this.hand.smallBlindSeat,
      bigBlindSeat: this.hand.bigBlindSeat,
      board: this.hand.board.slice(0, visibleCount).map((card) => card.code),
      pot: this.hand.contributed.reduce((sum, c) => sum + c, 0),
      stacks: this.mergedStacks(this.hand),
      toAct: this.hand.toAct,
      streetContributed: this.hand.streetContributed,
      commitments: this.hand.seedCommitments,
      seedSources: this.hand.seedSources,
      minRaiseIncrement: this.hand.minRaiseIncrement,
      allIn: this.hand.allIn,
      folded: this.hand.folded,
      transcript: this.hand.transcript,
    };
  }

  private resolveSeat(seatHint?: Seat): Seat | null {
    const isFree = (seat: Seat) => this.seats[seat] === null || this.seats[seat]?.connected === false;
    if (seatHint !== undefined && seatHint >= 0 && seatHint < this.seatCount && isFree(seatHint)) return seatHint;
    for (let s = 0; s < this.seatCount; s += 1) if (isFree(s)) return s;
    return null;
  }

  // A different tab/browser for the same account (no stored seatHint -
  // e.g. a fresh incognito window, or clearing site data) would otherwise
  // pass resolveSeat's free-seat scan and buy in AGAIN at a brand-new seat,
  // permanently orphaning the stack sitting in their original
  // still-disconnected seat (never cashed out, never reachable again).
  // Checking for an existing seat first - connected or not - makes any
  // reconnect path find the same seat, matching real poker sites' one
  // seat per account per table.
  private findSeatForUser(userId: string): Seat | null {
    for (let s = 0; s < this.seatCount; s += 1) if (this.seats[s]?.userId === userId) return s;
    return null;
  }

  // Debits a real buy-in from the user's persistent D1 balance (test chips)
  // and returns the amount bought in for, or null if they can't afford the
  // table's minimum (or lost a race to another simultaneous buy-in - the
  // conditional WHERE below makes the decrement atomic against that race).
  // desiredAmount is the player's own choice (PokerNow-style), clamped to
  // the host's configured [minBuyIn, maxBuyIn] range and then to what they
  // can actually afford.
  private async buyIn(userId: string, roomCode: string, desiredAmount: number): Promise<number | null> {
    try {
      const db = getDb();
      const rows = await db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1);
      const balance = rows[0]?.balance ?? 0;
      if (balance < this.minBuyIn) return null;
      const amount = Math.min(Math.max(Math.trunc(desiredAmount), this.minBuyIn), this.maxBuyIn, balance);
      const updated = await db
        .update(users)
        .set({ balance: sql`${users.balance} - ${amount}` })
        .where(and(eq(users.id, userId), gte(users.balance, amount)))
        .returning({ balance: users.balance });
      if (updated.length === 0) return null;
      await db.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId, delta: -amount, reason: "buy_in", roomCode });
      return amount;
    } catch {
      return null;
    }
  }

  // Anonymous/guest seats have no persistent D1 balance to debit (the
  // existing convention - see the class doc comment), so their "buy-in" is
  // just clamping the requested amount into the host's range with no
  // affordability check.
  private anonymousBuyIn(desiredAmount: number): number {
    return Math.min(Math.max(Math.trunc(desiredAmount), this.minBuyIn), this.maxBuyIn);
  }

  private async cashOut(userId: string, amount: number, roomCode: string): Promise<void> {
    if (amount <= 0) return;
    try {
      const db = getDb();
      await db.update(users).set({ balance: sql`${users.balance} + ${amount}` }).where(eq(users.id, userId));
      await db.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId, delta: amount, reason: "cash_out", roomCode });
    } catch {
      // Best-effort - table state itself is unaffected either way. A real
      // product would want a retry queue here; out of scope for this v1.
    }
  }

  private async handleSit(ws: WebSocket, seatHint?: Seat, buyInAmount?: number, seed?: string): Promise<void> {
    const attachment = this.attachmentOf(ws) ?? { seat: null, userId: null, username: null };
    const seat = (attachment.userId ? this.findSeatForUser(attachment.userId) : null) ?? this.resolveSeat(seatHint);
    if (seat === null) {
      this.send(ws, { type: "error", message: "Room is full." });
      return;
    }
    // A seat with a prior record (even disconnected) held by this SAME
    // authenticated user is a reconnect, not a fresh sit - they already
    // have chips at the table, so no new buy-in. Any other case (truly
    // empty seat, or a different user taking over an abandoned one) buys
    // in fresh, for the amount they chose (defaulting to the table max),
    // clamped into the host's configured range.
    const priorOccupant = this.seats[seat];
    const isReturningOwner = priorOccupant !== null && attachment.userId !== null && priorOccupant.userId === attachment.userId;
    const desired = Number.isFinite(buyInAmount) && (buyInAmount as number) > 0 ? (buyInAmount as number) : this.maxBuyIn;

    if (!isReturningOwner) {
      if (attachment.userId) {
        const bought = await this.buyIn(attachment.userId, this.roomCode, desired);
        if (bought === null) {
          this.send(ws, {
            type: "error",
            message: `Insufficient balance - you need at least ${this.minBuyIn} chips to sit down. Visit your account to check your bankroll.`,
          });
          return;
        }
        this.stacks[seat] = bought;
      } else {
        this.stacks[seat] = this.anonymousBuyIn(desired);
      }
      await this.persist(["stacks"]);
    }

    ws.serializeAttachment({ ...attachment, seat });
    this.seats[seat] = { connected: true, userId: attachment.userId };
    // Store this seat's seed BEFORE maybeStartHand() runs below, in the
    // same message rather than a separate follow-up - see the ClientMessage
    // comment on "sit" for why that ordering matters.
    if (this.isValidSeed(seed)) this.pendingSeeds.set(seat, seed);
    if (this.hostSeat === null) {
      this.hostSeat = seat;
      await this.persist(["seats", "hostSeat"]);
    } else {
      await this.persist(["seats"]);
    }
    this.send(ws, { type: "seat-assigned", seat });

    if (this.hand && this.hand.street !== "complete" && this.hand.inHand[seat]) {
      const cards = this.hand.holeCards[seat];
      if (cards) this.send(ws, { type: "hole-cards", handId: this.hand.handId, cards: [cards[0].code, cards[1].code] });
    }
    if (this.chatLog.length > 0) this.send(ws, { type: "chat-history", messages: this.chatLog });
    this.broadcastState();
    await this.syncRegistry();
    await this.maybeStartHand();
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    const attachment = this.attachmentOf(ws);
    const seat = attachment?.seat ?? null;
    if (seat === null) return;
    const midHand = Boolean(this.hand && this.hand.street !== "complete" && this.hand.inHand[seat] && !this.hand.folded[seat]);
    if (midHand) {
      this.send(ws, { type: "error", message: "Finish this hand before leaving the table." });
      return;
    }
    const payout = this.stacks[seat] ?? 0;
    if (attachment?.userId) await this.cashOut(attachment.userId, payout, this.roomCode);
    // Vacated slot always resets to a clean 0 - the next occupant (whether
    // this seat or a different one) always buys in fresh via handleSit
    // rather than inheriting a leftover stack.
    this.stacks[seat] = 0;
    await this.persist(["stacks"]);
    this.seats[seat] = null;
    // A pending seed belongs to whoever generated it - if a different
    // person takes this seat number next, they must supply their own,
    // not inherit the departed occupant's.
    this.pendingSeeds.delete(seat);
    const persistKeys: ("seats" | "hostSeat")[] = ["seats"];
    if (this.hostSeat === seat) {
      this.hostSeat = this.nextHostCandidate();
      persistKeys.push("hostSeat");
    }
    await this.persist(persistKeys);
    ws.serializeAttachment({ ...attachment, seat: null });
    this.send(ws, { type: "left-table", payout: attachment?.userId ? payout : 0 });
    this.broadcastState();
    await this.syncRegistry();
    if (this.voiceSeats.delete(seat)) this.broadcast({ type: "voice-left", seat });
  }

  // Next connected seat becomes host, lowest seat number first (arbitrary
  // but deterministic); null if the room is now empty.
  private nextHostCandidate(): Seat | null {
    for (let s = 0; s < this.seatCount; s += 1) if (this.seats[s]?.connected) return s;
    return null;
  }

  // Pure signaling relay - the DO never touches any media, just forwards
  // opaque WebRTC offer/answer/ICE payloads between two specific seats.
  private async handleVoiceJoin(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    this.send(ws, { type: "voice-presence", seats: [...this.voiceSeats] });
    this.voiceSeats.add(seat);
    this.broadcast({ type: "voice-joined", seat }, ws);
  }

  private async handleVoiceLeave(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    if (this.voiceSeats.delete(seat)) this.broadcast({ type: "voice-left", seat }, ws);
  }

  private async handleVoiceSignal(ws: WebSocket, toSeat: Seat, signal: unknown): Promise<void> {
    const fromSeat = this.seatOf(ws);
    if (fromSeat === null) return;
    const target = this.socketFor(toSeat);
    if (target) this.send(target, { type: "voice-signal", fromSeat, signal });
  }

  private async handleUpdateSettings(ws: WebSocket, smallBlind: number, bigBlind: number, minBuyIn: number, maxBuyIn: number): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null || seat !== this.hostSeat) {
      this.send(ws, { type: "error", message: "Only the host can change table settings." });
      return;
    }
    if (this.hand && this.hand.street !== "complete") {
      this.send(ws, { type: "error", message: "Table settings can only change between hands." });
      return;
    }
    if (!isValidTableSettings(smallBlind, bigBlind, minBuyIn, maxBuyIn)) {
      this.send(ws, { type: "error", message: "Those settings don't add up - check the blinds and buy-in range." });
      return;
    }
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.minBuyIn = minBuyIn;
    this.maxBuyIn = maxBuyIn;
    await this.persist(["smallBlind", "bigBlind", "minBuyIn", "maxBuyIn"]);
    this.broadcastState();
  }

  // Any seated player (not just the host) can request it - it's revealing
  // data the server already deterministically committed to at hand start,
  // not a privileged action. A no-op once already revealed or if the hand
  // actually reached the river (nothing left to hunt for).
  private async handleRabbitHunt(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    if (!this.hand || this.hand.street !== "complete" || this.hand.finalStreet === "river" || this.rabbitHuntRevealed) return;
    this.rabbitHuntRevealed = true;
    await this.persist(["rabbitHuntRevealed"]);
    this.broadcastState();
  }

  // Format check only - a fixed-length hex string matching randomHex()'s
  // own output. This isn't about the VALUE being "good" randomness (a
  // seat sending a predictable seed only weakens ITS OWN contribution,
  // never anyone else's, since the final shuffle combines every dealt
  // seat's seed together); it's to stop a malformed or adversarial seed
  // string (e.g. containing "|") from corrupting the pipe-delimited
  // commitment hash input in table-engine.ts's seatCommitment().
  private isValidSeed(seed: unknown): seed is string {
    return typeof seed === "string" && /^[0-9a-f]{64}$/i.test(seed);
  }

  private async handleProvideSeed(ws: WebSocket, seed: string): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null || !this.isValidSeed(seed)) return;
    this.pendingSeeds.set(seat, seed);
  }

  private async handleChat(ws: WebSocket, text: string): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) {
      this.send(ws, { type: "error", message: "Take a seat before chatting." });
      return;
    }
    const trimmed = text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!trimmed) return;
    const message: ChatMessage = { seat, text: trimmed, ts: Date.now() };
    this.chatLog = [...this.chatLog, message].slice(-CHAT_HISTORY_LIMIT);
    await this.persist(["chatLog"]);
    this.broadcast({ type: "chat", message });
  }

  private async handleAction(ws: WebSocket, action: ActionType, amount?: number): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) {
      this.send(ws, { type: "error", message: "Take a seat before acting." });
      return;
    }
    if (!this.hand) {
      this.send(ws, { type: "error", message: "No hand in progress." });
      return;
    }
    let next: EngineState;
    try {
      next = await applyAction(this.hand, seat, action, amount);
    } catch (error) {
      if (error instanceof IllegalActionError) {
        this.send(ws, { type: "error", message: error.message });
        return;
      }
      throw error;
    }
    this.hand = next;
    this.stacks = this.mergedStacks(next);
    await this.persist(["hand", "stacks"]);
    this.broadcastState();

    if (this.hand.street === "complete" && this.hand.sidePots) {
      const bundle = buildProofBundle(this.hand);
      const payouts = this.stacks.map((stack, s) => (this.hand!.inHand[s] ? stack - (this.handStartStacks[s] ?? stack) : 0));
      this.broadcast({ type: "hand-complete", sidePots: this.hand.sidePots, payouts, bundle });
      this.readyForNext = new Array(this.seatCount).fill(false);
      await this.persist(["readyForNext"]);
      await this.syncRegistry();
      await this.recordHandHistory(bundle, payouts);
    }
  }

  // Best-effort - only records a hand if at least one seat was an
  // authenticated account (anonymous seats have no account to attach
  // history to, and a room of entirely anonymous seats has nobody who
  // could ever look this row up).
  private async recordHandHistory(bundle: TableProofBundle, payouts: number[]): Promise<void> {
    if (!this.hand) return;
    const participants: { userId: string; seat: Seat; netResult: number }[] = [];
    for (let s = 0; s < this.seatCount; s += 1) {
      const userId = this.seats[s]?.userId;
      if (userId && this.hand.inHand[s]) participants.push({ userId, seat: s, netResult: payouts[s] });
    }
    if (participants.length === 0) return;
    try {
      const db = getDb();
      await db.insert(hands).values({
        handId: bundle.handId,
        roomCode: this.roomCode,
        seatCount: this.seatCount,
        bundle: JSON.stringify(bundle),
      });
      await db.insert(handParticipants).values(
        participants.map((p) => ({ id: crypto.randomUUID(), handId: bundle.handId, userId: p.userId, seat: p.seat, netResult: p.netResult })),
      );
    } catch {
      // Hand history is a convenience, never a gate on gameplay.
    }
  }

  private async handleReady(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    this.readyForNext[seat] = true;
    await this.persist(["readyForNext"]);

    const connectedSeats: Seat[] = [];
    for (let s = 0; s < this.seatCount; s += 1) if (this.seats[s]?.connected) connectedSeats.push(s);
    const allReady = connectedSeats.length > 0 && connectedSeats.every((s) => this.readyForNext[s]);
    if (allReady) {
      this.readyForNext = new Array(this.seatCount).fill(false);
      await this.persist(["readyForNext"]);
      await this.maybeStartHand();
    }
  }

  private async maybeStartHand(): Promise<void> {
    const occupiedSeats: { seat: Seat; stack: number }[] = [];
    for (let s = 0; s < this.seatCount; s += 1) {
      if (this.seats[s]?.connected && this.stacks[s] > 0) occupiedSeats.push({ seat: s, stack: this.stacks[s] });
    }
    const noHandInProgress = !this.hand || this.hand.street === "complete";
    if (occupiedSeats.length < 2 || !noHandInProgress) return;

    const handId = `river-table-${crypto.randomUUID()}`;
    const previousButton = this.hand?.buttonSeat ?? null;
    this.handStartStacks = this.stacks.slice();
    // Each dealt-in seat's own browser-generated seed, if it sent one
    // ahead of time (see handleProvideSeed) - consumed and cleared here so
    // it's never reused for a later hand. A seat with none pending falls
    // back to server-generated randomness for just that seat (see
    // table-engine.ts's clientSeeds param and EngineState.seedSources).
    const clientSeeds: Partial<Record<Seat, string>> = {};
    for (const { seat } of occupiedSeats) {
      const seed = this.pendingSeeds.get(seat);
      if (seed) {
        clientSeeds[seat] = seed;
        this.pendingSeeds.delete(seat);
      }
    }
    this.hand = await startHand(handId, this.seatCount, occupiedSeats, previousButton, this.smallBlind, this.bigBlind, clientSeeds);
    this.stacks = this.mergedStacks(this.hand);
    this.rabbitHuntRevealed = false;
    await this.persist(["hand", "stacks", "handStartStacks", "rabbitHuntRevealed"]);

    for (const { seat } of occupiedSeats) {
      const socket = this.socketFor(seat);
      if (!socket) continue;
      const cards = this.hand.holeCards[seat];
      if (cards) this.send(socket, { type: "hole-cards", handId, cards: [cards[0].code, cards[1].code] });
    }
    this.broadcastState();
    await this.syncRegistry();
  }
}
