import { and, eq, gte, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { randomHex } from "../app/play/proof.ts";
import { handParticipants, hands, ledgerEntries, tables, users } from "../db/schema";
import { getSessionUser } from "./auth";
import { signSeedAck, type SeedAck } from "./fairness-attestation.ts";
import * as mp from "./mental-poker-protocol.ts";
import type { ProofBundleV3 as MentalPokerBundle } from "../app/play/mental-poker.ts";
import {
  applyAction,
  buildProofBundle,
  cardsFromCodes,
  finishShowdown,
  startTrustlessHand,
  legalActions,
  serverSeedCommitment,
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
  // originally because handleSit used to start a hand synchronously, so a
  // seed sent as its own later message would almost always lose that race
  // (confirmed live: two seats filling back-to-back both fell back to
  // server randomness before this fix). Hand start is now deferred by
  // armHandStart's fixed window (see below), which gives a follow-up
  // message real margin too - but there's no reason to add a second path
  // for something this cheap to just always include upfront.
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
  | { type: "update-settings"; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number; actionClockSeconds: number }
  // Any seated player can request it once a hand has ended before the
  // river - see handleRabbitHunt. The board is already deterministically
  // fixed at hand start (commit-reveal), so this needs no new randomness,
  // just a permission gate on revealing data the server already computed.
  | { type: "rabbit-hunt" }
  // A seat's own browser-generated random contribution to the next hand's
  // shuffle - see handleProvideSeed. Sent proactively (right after sitting
  // down and again after every hand-complete), not requested by the
  // server, so it's normally already on hand by the time a hand deals.
  | { type: "provide-seed"; seed: string }
  // Trustless (mental-poker) tables only. These carry the two browsers'
  // dealing protocol; the Durable Object relays and orders them but holds no
  // key and cannot read a card from any of them. See
  // worker/mental-poker-protocol.ts.
  | { type: "mp-commit"; commitment: string; publicKey: string }
  | { type: "mp-mask"; deck: string[] }
  | { type: "mp-hole-partial"; position: number; partial: string }
  | { type: "mp-board-partial"; position: number; partial: string }
  | { type: "mp-showdown-reveal"; cards: [string, string]; partials: [string, string] }
  | { type: "mp-seed-reveal"; seed: string };

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
  // 0 means no clock (host disabled it). When non-zero and a hand is in
  // progress, actionDeadline is the epoch ms the acting seat auto-folds
  // (or auto-checks, when legal) - null whenever no seat is actively on
  // the clock (no hand, hand complete, or the clock is disabled).
  actionClockSeconds: number;
  actionDeadline: number | null;
  // True for a room opened via the lounge matchmaker (app/api/lounge/join)
  // - stakes stay house-managed, so the client hides the settings gear.
  isLounge: boolean;
  // True on a mental-poker table: this object relays the deal rather than
  // performing it, and holds no key. Drives the client's protocol driver.
  isTrustless: boolean;
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
  // Signed proof that the server received this seat's seed for the named
  // hand - keep it to be able to prove a later substitution.
  | { type: "seed-ack"; ack: SeedAck }
  // Trustless protocol progress: what phase the deal is in, which seats it
  // is waiting on, and the artifacts a client needs to take its next step.
  | {
      type: "mp-progress";
      phase: mp.MpPhase;
      waitingOn: number[];
      handId: string;
      deckToMask: string[] | null;
      maskedDeck: string[] | null;
      openBoardPositions: number[];
      board: string[];
      publicKeys: (string | null)[];
      abortReason: string | null;
    }
  // A partial for one of YOUR hole positions, produced by your opponent.
  | { type: "mp-hole-partial"; position: number; partial: string }
  | { type: "mp-aborted"; reason: string }
  // The trustless hand's real, independently verifiable receipt
  // (verifyMentalPokerBundle in app/play/mental-poker.ts).
  | { type: "mp-receipt"; bundle: MentalPokerBundle }
  | { type: "hole-cards"; handId: string; cards: [string, string] }
  | { type: "state"; state: PublicHandState }
  | {
      type: "hand-complete";
      sidePots: { amount: number; eligibleSeats: Seat[]; winners: Seat[] }[];
      payouts: number[]; // net chips gained (or lost, negative) this hand, per seat
      // null on a trustless table: this object never held a deck, so a
      // server-dealt bundle here would be a fabrication. The real receipt
      // arrives as mp-receipt once both parties reveal their masker seeds.
      bundle: TableProofBundle | null;
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
// How long a hand-start, once armed, always waits before dealing -
// fixed and content-independent on purpose (see armHandStart) so the
// server has no discretion over the moment left to exploit. Short enough
// not to feel like a real delay to players.
const FAIR_START_WINDOW_MS = 2000;
// How long a trustless table waits on any single protocol step (a masking
// round, a partial, a showdown reveal) before abandoning the hand and
// refunding. Generous: these steps involve real elliptic-curve work in the
// browser, and abandoning a hand is worse than waiting a moment longer.
const MP_STEP_TIMEOUT_MS = 45_000;
// Per-action countdown default (0 = no clock). Host-configurable, same
// pattern as blinds/buy-in range - see isValidTableSettings.
const DEFAULT_ACTION_CLOCK_SECONDS = 30;
const MAX_ACTION_CLOCK_SECONDS = 300;

// Shared by handleUpdateSettings (a host changing an existing room) and
// fetch() (whoever creates a room choosing its opening stakes) - one rule,
// checked in both places, rather than two copies drifting apart.
function isValidTableSettings(
  smallBlind: number,
  bigBlind: number,
  minBuyIn: number,
  maxBuyIn: number,
  actionClockSeconds: number,
): boolean {
  return (
    Number.isInteger(smallBlind) &&
    smallBlind >= 1 &&
    Number.isInteger(bigBlind) &&
    bigBlind > smallBlind &&
    Number.isInteger(minBuyIn) &&
    minBuyIn >= bigBlind * 2 &&
    Number.isInteger(maxBuyIn) &&
    maxBuyIn >= minBuyIn &&
    Number.isInteger(actionClockSeconds) &&
    actionClockSeconds >= 0 &&
    actionClockSeconds <= MAX_ACTION_CLOCK_SECONDS &&
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
  private actionClockSeconds = DEFAULT_ACTION_CLOCK_SECONDS;
  // True for a room opened via the lounge "Join <tier>" matchmaker
  // (app/api/lounge/join) - stakes stay house-managed for these, so
  // handleUpdateSettings rejects any change once this is set. Fixed at
  // room-creation time in fetch(), never changes afterward.
  private isLounge = false;
  // Trustless (mental-poker) room: the two browsers deal to each other and
  // this object never holds a key or sees a card before showdown. Fixed at
  // room creation, heads-up only.
  private isTrustless = false;
  private mpState: mp.MpState | null = null;
  private mpDeadline: number | null = null;
  // The epoch ms the currently-acting seat auto-folds/checks at, once
  // armed - see armActionDeadline()/alarm(). null whenever no seat is
  // actively on the clock.
  private actionDeadline: number | null = null;
  // Reset to false at the start of every new hand (startHandIfReady). Once
  // true, publicState() reveals the full board even past finalStreet.
  private rabbitHuntRevealed = false;
  // The fixed, content-independent deadline a hand is allowed to start at,
  // once armed - see armHandStart()/alarm() for why this is what actually
  // closes the timing-discretion gap /fairness discloses (the server can
  // never move this earlier OR later based on what seeds have arrived).
  // null when no start is currently pending.
  private pendingHandStartAt: number | null = null;
  // The NEXT hand's server entropy and hand id, both fixed (and their
  // commitment published in publicState) strictly before that hand's client
  // seeds are collected - see ensureNextHandCommitment(). Persisted like
  // every other authoritative field: a hibernation that lost these would
  // silently let the server pick a fresh pair after already seeing seeds,
  // which is exactly the grind this design exists to prevent.
  private nextServerSeed = "";
  private nextHandId = "";
  // Stored rather than re-hashed, so publicState() can stay synchronous.
  private nextServerSeedCommitment = "";
  // Client-supplied randomness for each seat's NEXT hand - deliberately
  // NOT persisted, same as voiceSeats: it's transient per-connection state,
  // not authoritative game state. If a Durable Object hibernation wipes it
  // before a hand starts, the only consequence is that seat's contribution
  // falls back to server-generated randomness for that one hand (see
  // startHandIfReady + table-engine.ts's clientSeeds fallback) - never a
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
      this.actionClockSeconds = (await this.ctx.storage.get<number>("actionClockSeconds")) ?? DEFAULT_ACTION_CLOCK_SECONDS;
      this.isLounge = (await this.ctx.storage.get<boolean>("isLounge")) ?? false;
      this.isTrustless = (await this.ctx.storage.get<boolean>("isTrustless")) ?? false;
      this.mpState = (await this.ctx.storage.get<mp.MpState | null>("mpState")) ?? null;
      this.mpDeadline = (await this.ctx.storage.get<number | null>("mpDeadline")) ?? null;
      this.actionDeadline = (await this.ctx.storage.get<number | null>("actionDeadline")) ?? null;
      this.rabbitHuntRevealed = (await this.ctx.storage.get<boolean>("rabbitHuntRevealed")) ?? false;
      this.pendingHandStartAt = (await this.ctx.storage.get<number | null>("pendingHandStartAt")) ?? null;
      this.nextServerSeed = (await this.ctx.storage.get<string>("nextServerSeed")) ?? "";
      this.nextHandId = (await this.ctx.storage.get<string>("nextHandId")) ?? "";
      this.nextServerSeedCommitment = (await this.ctx.storage.get<string>("nextServerSeedCommitment")) ?? "";
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
      | "actionClockSeconds"
      | "isLounge"
      | "isTrustless"
      | "mpState"
      | "mpDeadline"
      | "actionDeadline"
      | "rabbitHuntRevealed"
      | "pendingHandStartAt"
      | "nextServerSeed"
      | "nextHandId"
      | "nextServerSeedCommitment"
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
      else if (key === "actionClockSeconds") await this.ctx.storage.put("actionClockSeconds", this.actionClockSeconds);
      else if (key === "isLounge") await this.ctx.storage.put("isLounge", this.isLounge);
      else if (key === "isTrustless") await this.ctx.storage.put("isTrustless", this.isTrustless);
      else if (key === "mpState") await this.ctx.storage.put("mpState", this.mpState);
      else if (key === "mpDeadline") await this.ctx.storage.put("mpDeadline", this.mpDeadline);
      else if (key === "actionDeadline") await this.ctx.storage.put("actionDeadline", this.actionDeadline);
      else if (key === "rabbitHuntRevealed") await this.ctx.storage.put("rabbitHuntRevealed", this.rabbitHuntRevealed);
      else if (key === "nextServerSeed") await this.ctx.storage.put("nextServerSeed", this.nextServerSeed);
      else if (key === "nextHandId") await this.ctx.storage.put("nextHandId", this.nextHandId);
      else if (key === "nextServerSeedCommitment") await this.ctx.storage.put("nextServerSeedCommitment", this.nextServerSeedCommitment);
      else await this.ctx.storage.put("pendingHandStartAt", this.pendingHandStartAt);
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
      // Not sourced from a URL param (the lobby's "New table" dialog has no
      // clock picker yet) - always DEFAULT_ACTION_CLOCK_SECONDS here, always
      // valid, so it never affects openingStakesValid either way.
      const openingStakesValid = isValidTableSettings(
        requestedSmallBlind,
        requestedBigBlind,
        requestedMinBuyIn,
        requestedMaxBuyIn,
        DEFAULT_ACTION_CLOCK_SECONDS,
      );
      this.smallBlind = openingStakesValid ? requestedSmallBlind : DEFAULT_SMALL_BLIND;
      this.bigBlind = openingStakesValid ? requestedBigBlind : DEFAULT_BIG_BLIND;
      this.minBuyIn = openingStakesValid ? requestedMinBuyIn : DEFAULT_MIN_BUY_IN;
      this.maxBuyIn = openingStakesValid ? requestedMaxBuyIn : DEFAULT_MAX_BUY_IN;
      this.actionClockSeconds = DEFAULT_ACTION_CLOCK_SECONDS;
      // Only meaningful at creation - set by the lounge matchmaker
      // (app/api/lounge/join, connectTable's InitialTableSettings.isLounge)
      // when it mints a fresh room for a tier rather than finding an open
      // one. A room created any other way is never a lounge room.
      this.isLounge = url.searchParams.get("lounge") === "1";
      // Heads-up only: mental poker needs every party online for every card,
      // so it does not generalise past two seats.
      this.isTrustless = url.searchParams.get("trustless") === "1" && this.seatCount === 2;
      await this.persist([
        "seatCount",
        "seats",
        "stacks",
        "readyForNext",
        "roomCode",
        "smallBlind",
        "bigBlind",
        "minBuyIn",
        "maxBuyIn",
        "actionClockSeconds",
        "isLounge",
        "isTrustless",
      ]);
    }
    // Before the first socket is even accepted, so the opening hand's
    // commitment is already fixed and public before anyone can sit down
    // (and a "sit" is what carries the first client seed).
    await this.ensureNextHandCommitment();
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
      return this.handleUpdateSettings(
        ws,
        message.smallBlind,
        message.bigBlind,
        message.minBuyIn,
        message.maxBuyIn,
        message.actionClockSeconds,
      );
    if (message.type === "rabbit-hunt") return this.handleRabbitHunt(ws);
    if (message.type === "provide-seed") return this.handleProvideSeed(ws, message.seed);
    if (message.type.startsWith("mp-")) return this.handleMpMessage(ws, message);
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
      const stakes = {
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        minBuyIn: this.minBuyIn,
        maxBuyIn: this.maxBuyIn,
        isLounge: this.isLounge,
        isTrustless: this.isTrustless,
      };
      await db
        .insert(tables)
        .values({ roomCode: this.roomCode, seatCount: this.seatCount, occupiedCount, status, ...stakes })
        .onConflictDoUpdate({
          target: tables.roomCode,
          set: { seatCount: this.seatCount, occupiedCount, status, ...stakes, updatedAt: sql`CURRENT_TIMESTAMP` },
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
        actionClockSeconds: this.actionClockSeconds,
        actionDeadline: null,
        isLounge: this.isLounge,
        isTrustless: this.isTrustless,
        nextServerSeedCommitment: this.nextServerSeedCommitment,
        nextHandId: this.nextHandId,
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
    // "showdown" means betting finished and the full board was dealt - the
    // hand is only waiting on trustless reveals, so the board shows as river.
    const visibleCount = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, complete: 5 }[revealStreet];
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
      actionClockSeconds: this.actionClockSeconds,
      actionDeadline: this.actionDeadline,
      isLounge: this.isLounge,
      isTrustless: this.isTrustless,
      nextServerSeedCommitment: this.nextServerSeedCommitment,
      nextHandId: this.nextHandId,
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
    // Store this seat's seed BEFORE armHandStart() runs below, in the
    // same message rather than a separate follow-up - see the ClientMessage
    // comment on "sit" for why that ordering matters.
    if (this.isValidSeed(seed)) {
      this.pendingSeeds.set(seat, seed);
      await this.sendSeedAck(ws, seat, seed);
    }
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
    await this.armHandStart();
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

  private async handleUpdateSettings(
    ws: WebSocket,
    smallBlind: number,
    bigBlind: number,
    minBuyIn: number,
    maxBuyIn: number,
    actionClockSeconds: number,
  ): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null || seat !== this.hostSeat) {
      this.send(ws, { type: "error", message: "Only the host can change table settings." });
      return;
    }
    if (this.hand && this.hand.street !== "complete") {
      this.send(ws, { type: "error", message: "Table settings can only change between hands." });
      return;
    }
    if (this.isLounge) {
      this.send(ws, { type: "error", message: "Lounge tables keep house-managed stakes - they can't be changed." });
      return;
    }
    if (!isValidTableSettings(smallBlind, bigBlind, minBuyIn, maxBuyIn, actionClockSeconds)) {
      this.send(ws, { type: "error", message: "Those settings don't add up - check the blinds, buy-in range, and clock." });
      return;
    }
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.minBuyIn = minBuyIn;
    this.maxBuyIn = maxBuyIn;
    this.actionClockSeconds = actionClockSeconds;
    await this.persist(["smallBlind", "bigBlind", "minBuyIn", "maxBuyIn", "actionClockSeconds"]);
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

  // ---- trustless (mental-poker) relay ---------------------------------
  //
  // Everything below moves protocol artifacts between the two browsers and
  // enforces ordering via worker/mental-poker-protocol.ts. This object never
  // holds a masking key, so it cannot decrypt a hole card at any point - the
  // one thing it does verify (a showdown reveal) needs only the partials
  // both parties already published.

  private async handleMpMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    if (!this.isTrustless || !this.mpState) {
      this.send(ws, { type: "error", message: "This table is not a trustless table." });
      return;
    }
    try {
      await this.routeMpMessage(seat, message);
    } catch (error) {
      // A protocol violation is a client bug or an attempted shortcut, not a
      // reason to kill the hand - tell that seat and let the clock decide if
      // it never recovers.
      const text = error instanceof mp.MpProtocolError ? error.message : "Protocol error.";
      this.send(ws, { type: "error", message: text });
      return;
    }
    await this.persist(["mpState"]);
    this.broadcastMpProgress();
    await this.armMpDeadline();
    await this.maybeStartTrustlessBetting();
    // Board cards just landed: whoever is to act is now genuinely able to,
    // so put them back on the clock.
    if (this.mpState?.phase === "betting" && this.hand && this.hand.street !== "complete") {
      await this.armActionDeadline();
      this.broadcastState();
    }
  }

  private async routeMpMessage(seat: Seat, message: ClientMessage): Promise<void> {
    const state = this.mpState!;
    if (message.type === "mp-commit") {
      this.mpState = mp.applyCommitment(state, seat, message.commitment, message.publicKey);
      return;
    }
    if (message.type === "mp-mask") {
      this.mpState = mp.applyMaskRound(state, seat, message.deck);
      return;
    }
    if (message.type === "mp-hole-partial") {
      this.mpState = mp.applyHolePartial(state, seat, message.position, message.partial);
      // Straight to the seat that owns the card - it's useless to anyone else.
      const owner = mp.holeOwner(message.position);
      const target = this.socketFor(owner);
      if (target) this.send(target, { type: "mp-hole-partial", position: message.position, partial: message.partial });
      return;
    }
    if (message.type === "mp-board-partial") {
      const result = await mp.applyBoardPartial(state, seat, message.position, message.partial);
      this.mpState = result.state;
      return;
    }
    if (message.type === "mp-showdown-reveal") {
      this.mpState = await mp.applyShowdownReveal(state, seat, message.cards, message.partials);
      await this.maybeFinishTrustlessShowdown();
      return;
    }
    if (message.type === "mp-seed-reveal") {
      this.mpState = mp.applyMaskerSeedReveal(state, seat, message.seed);
      if (this.mpState.phase === "complete") await this.emitTrustlessReceipt();
      return;
    }
  }

  private broadcastMpProgress(): void {
    const state = this.mpState;
    if (!state) return;
    const openBoardPositions = Object.keys(state.boardPartials)
      .map(Number)
      .filter((position) => !state.releasedBoardPositions.includes(position));
    // deckToMask is whichever deck the next masker needs as input: the fresh
    // one for seat 0 (built client-side) and seat 0's output for seat 1.
    const deckToMask = state.phase === "mask-seat-1" ? state.deckAfterSeat0 : null;
    this.broadcast({
      type: "mp-progress",
      phase: state.phase,
      waitingOn: mp.waitingOn(state, this.contestingSeatsForMp()),
      handId: state.handId,
      deckToMask,
      maskedDeck: state.maskedDeck,
      openBoardPositions,
      board: state.board,
      publicKeys: state.publicKeys,
      abortReason: state.abortReason,
    });
  }

  private contestingSeatsForMp(): number[] {
    if (!this.hand) return [0, 1];
    const out: number[] = [];
    for (let s = 0; s < this.seatCount; s += 1) if (this.hand.inHand[s] && !this.hand.folded[s]) out.push(s);
    return out;
  }

  /** Once dealing completes, the betting engine takes over for the hand. */
  private async maybeStartTrustlessBetting(): Promise<void> {
    if (!this.mpState || this.mpState.phase !== "betting") return;
    if (this.hand && this.hand.street !== "complete") return;

    const occupiedSeats: { seat: Seat; stack: number }[] = [];
    for (let s = 0; s < this.seatCount; s += 1) {
      if (this.seats[s]?.connected && this.stacks[s] > 0) occupiedSeats.push({ seat: s, stack: this.stacks[s] });
    }
    if (occupiedSeats.length !== 2) return;

    this.handStartStacks = this.stacks.slice();
    this.hand = await startTrustlessHand(
      this.mpState.handId,
      this.seatCount,
      occupiedSeats,
      this.hand?.buttonSeat ?? null,
      this.smallBlind,
      this.bigBlind,
    );
    this.stacks = this.mergedStacks(this.hand);
    await this.persist(["hand", "stacks", "handStartStacks"]);
    await this.armActionDeadline();
    this.broadcastState();
    await this.syncRegistry();
  }

  /**
   * Opens the board cards for a street the betting engine has just reached.
   * Called after every action, so the flop is only unsealed once preflop
   * betting is genuinely closed.
   */
  private async openTrustlessBoardStreet(street: string): Promise<void> {
    if (!this.isTrustless || !this.mpState) return;
    if (mp.positionsForStreet(street).length === 0) return;
    if (this.mpState.phase !== "betting") return;
    this.mpState = mp.openBoardStreet(this.mpState, street);
    await this.persist(["mpState"]);
    this.broadcastMpProgress();
  }

  private async maybeFinishTrustlessShowdown(): Promise<void> {
    if (!this.hand || !this.mpState || this.hand.street !== "showdown") return;
    const contesting = this.contestingSeatsForMp();
    if (!mp.allRequiredRevealsIn(this.mpState, contesting)) return;
    if (this.mpState.board.length !== 5) return;

    const holeCards: EngineState["holeCards"] = new Array(this.seatCount).fill(null);
    for (const seat of contesting) {
      const codes = this.mpState.revealedHole[seat];
      if (!codes) return;
      const [first, second] = cardsFromCodes(codes);
      holeCards[seat] = [first, second];
    }
    const settled = await finishShowdown(this.hand, holeCards, cardsFromCodes(this.mpState.board));
    this.hand = settled;
    this.stacks = this.mergedStacks(settled);
    await this.persist(["hand", "stacks"]);
    this.broadcastState();
    await this.completeTrustlessHand();
  }

  /**
   * Returns every chip contributed this hand. Used when the protocol can't
   * finish - with dealing incomplete there is no honest way to pick a
   * winner, and awarding the pot to whoever stayed online would make
   * stalling profitable.
   */
  private async abortTrustlessHand(reason: string): Promise<void> {
    if (!this.mpState) return;
    this.mpState = mp.abort(this.mpState, reason);
    if (this.hand && this.hand.street !== "complete") {
      const refunded = this.stacks.slice();
      for (let s = 0; s < this.seatCount; s += 1) refunded[s] = (this.handStartStacks[s] ?? refunded[s]);
      this.stacks = refunded;
      this.hand = null;
      await this.persist(["hand", "stacks"]);
    }
    this.actionDeadline = null;
    await this.persist(["mpState", "actionDeadline"]);
    this.broadcast({ type: "mp-aborted", reason });
    this.broadcastState();
    await this.beginTrustlessHand();
  }

  /** Fresh protocol state for the next trustless hand. */
  private async beginTrustlessHand(): Promise<void> {
    if (!this.isTrustless) return;
    await this.ensureNextHandCommitment();
    this.mpState = mp.initialMpState(this.nextHandId);
    this.nextServerSeed = "";
    this.nextHandId = "";
    this.nextServerSeedCommitment = "";
    await this.ensureNextHandCommitment();
    await this.persist(["mpState"]);
    this.broadcastMpProgress();
    await this.armMpDeadline();
  }

  private async completeTrustlessHand(): Promise<void> {
    if (!this.hand || !this.hand.sidePots) return;
    const payouts = this.stacks.map((stack, s) => (this.hand!.inHand[s] ? stack - (this.handStartStacks[s] ?? stack) : 0));
    this.broadcast({
      type: "hand-complete",
      sidePots: this.hand.sidePots,
      payouts,
      bundle: null,
    });
    this.readyForNext = new Array(this.seatCount).fill(false);
    await this.persist(["readyForNext"]);
    await this.syncRegistry();

    // Now ask both parties to reveal their masker seeds, which is what lets
    // anyone replay the shuffle from scratch and check it.
    if (this.mpState) {
      this.mpState = mp.beginSettle(this.mpState);
      await this.persist(["mpState"]);
      this.broadcastMpProgress();
      await this.armMpDeadline();
    }
  }

  private async emitTrustlessReceipt(): Promise<void> {
    if (!this.mpState || this.mpState.phase !== "complete") return;
    try {
      const bundle = await mp.buildMentalPokerBundle(this.mpState);
      // A hand that folded before any card was turned up has nothing to
      // attest to: no board was unsealed and nobody showed down, so the
      // receipt would carry zero deals - which verifyMentalPokerBundle
      // rejects. Publishing a receipt that reads PROOF REJECTED on an
      // entirely honest hand would do more damage to trust in the verifier
      // than publishing none, so this stays silent and the client says why.
      if (bundle.deals.length === 0) return;
      this.broadcast({ type: "mp-receipt", bundle });
      // Same history table as a server-dealt hand: the column is JSON and
      // both receipt shapes name their own version, so /receipts can tell
      // them apart and run the right verifier.
      if (this.hand) {
        const payouts = this.stacks.map((stack, s) =>
          this.hand!.inHand[s] ? stack - (this.handStartStacks[s] ?? stack) : 0,
        );
        await this.recordHandHistory(bundle.handId, bundle, payouts);
      }
    } catch {
      // A receipt that can't be assembled is worth surfacing as absent
      // rather than as something fabricated - the hand result already stands
      // on the betting engine's own transcript.
    }
    this.mpDeadline = null;
    await this.persist(["mpDeadline"]);
  }

  private async handleProvideSeed(ws: WebSocket, seed: string): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null || !this.isValidSeed(seed)) return;
    this.pendingSeeds.set(seat, seed);
    await this.sendSeedAck(ws, seat, seed);
  }

  /**
   * Signs "for hand H, seat N, I hold a seed hashing to X" and hands it to
   * the seat that sent it. Keeping this is what lets a player later prove -
   * not merely assert - that their contribution was swapped, since the
   * signature contradicts the published receipt for that same hand. See
   * worker/fairness-attestation.ts.
   *
   * Issued against nextHandId, which is already fixed and public before any
   * of this hand's seeds are collected, so the acknowledgement names the
   * exact hand the seed will be used in.
   */
  private async sendSeedAck(ws: WebSocket, seat: Seat, seed: string): Promise<void> {
    const signingKey = env.FAIRNESS_SIGNING_KEY;
    if (!signingKey || !this.nextHandId) return;
    try {
      const ack = await signSeedAck(this.nextHandId, seat, seed, signingKey);
      this.send(ws, { type: "seed-ack", ack });
    } catch {
      // Never let attestation trouble block someone from playing - the hand
      // itself is unaffected, and an ack that never arrives is visible to
      // the client as a missing receipt rather than a silent downgrade.
    }
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
    // On a trustless table the engine reaches a street before that street's
    // cards exist - they only appear once both parties publish partials.
    // Accepting a bet in that window would mean betting a board nobody can
    // see yet, so actions are refused until the deal catches up.
    if (this.isTrustless && this.mpState && this.mpState.phase !== "betting") {
      this.send(ws, { type: "error", message: "Waiting for both players to unseal the next card." });
      return;
    }
    try {
      await this.applyEngineAction(seat, action, amount);
    } catch (error) {
      if (error instanceof IllegalActionError) {
        this.send(ws, { type: "error", message: error.message });
        return;
      }
      throw error;
    }
  }

  // Shared by handleAction (a real player's WebSocket message) and alarm()
  // (an auto-fold/auto-check when the action clock expires) - one path for
  // "an action just happened," so the two can never drift apart on what
  // happens after (persist, broadcast, re-arm the next deadline, hand-
  // complete handling).
  private async applyEngineAction(seat: Seat, action: ActionType, amount?: number): Promise<void> {
    if (!this.hand) return;
    const previousStreet = this.hand.street;
    const next = await applyAction(this.hand, seat, action, amount);
    this.hand = next;
    this.stacks = this.mergedStacks(next);
    await this.persist(["hand", "stacks"]);

    // Trustless tables unseal board cards only after the street that
    // precedes them has finished betting - the cards physically cannot be
    // read before both parties publish partials for them. This runs BEFORE
    // arming the action clock: otherwise the clock is armed against a street
    // whose cards don't exist yet, and its alarm auto-acts on a sealed board.
    if (this.isTrustless && this.hand.street !== previousStreet) {
      if (this.hand.street === "showdown") this.mpState = mp.beginShowdown(this.mpState!);
      else await this.openTrustlessBoardStreet(this.hand.street);
      await this.persist(["mpState"]);
      this.broadcastMpProgress();
      await this.armMpDeadline();
    }

    await this.armActionDeadline();
    this.broadcastState();

    if (this.hand.street === "complete" && this.hand.sidePots) {
      // A trustless hand that ends by folding never reaches showdown, so it
      // lands here rather than in maybeFinishTrustlessShowdown. It must NOT
      // take the server-dealt path: buildProofBundle would fabricate a
      // receipt from a deck this object never held, and nobody would ever be
      // asked for their shuffle keys - leaving the table stuck waiting.
      if (this.isTrustless) {
        await this.completeTrustlessHand();
        return;
      }
      const bundle = buildProofBundle(this.hand);
      const payouts = this.stacks.map((stack, s) => (this.hand!.inHand[s] ? stack - (this.handStartStacks[s] ?? stack) : 0));
      this.broadcast({ type: "hand-complete", sidePots: this.hand.sidePots, payouts, bundle });
      this.readyForNext = new Array(this.seatCount).fill(false);
      await this.persist(["readyForNext"]);
      await this.syncRegistry();
      await this.recordHandHistory(bundle.handId, bundle, payouts);
    }
  }

  // Arms (or clears) the per-action countdown alarm for whoever's currently
  // toAct. Called after every action (real or clock-triggered) and after a
  // hand deals - anywhere toAct changes. Safe to call liberally: a no-op
  // clock (actionClockSeconds === 0) or no one currently to act just clears
  // any stale deadline instead of arming one.
  private async armActionDeadline(): Promise<void> {
    // On a trustless table the engine advances to the next street before its
    // cards exist - they only appear once both parties publish partials.
    // Running the action clock through that window would auto-fold someone
    // for failing to act on a board they physically cannot see yet, so the
    // clock stays parked until the deal catches up. The protocol's own
    // stall timeout (armMpDeadline) covers that window instead.
    const awaitingDeal = this.isTrustless && this.mpState !== null && this.mpState.phase !== "betting";
    if (awaitingDeal || !this.hand || this.hand.street === "complete" || this.hand.toAct === null || this.actionClockSeconds <= 0) {
      if (this.actionDeadline !== null) {
        this.actionDeadline = null;
        await this.persist(["actionDeadline"]);
      }
      return;
    }
    this.actionDeadline = Date.now() + this.actionClockSeconds * 1000;
    await this.persist(["actionDeadline"]);
    await this.ctx.storage.setAlarm(this.actionDeadline);
  }

  // Best-effort - only records a hand if at least one seat was an
  // authenticated account (anonymous seats have no account to attach
  // history to, and a room of entirely anonymous seats has nobody who
  // could ever look this row up).
  private async recordHandHistory(handId: string, bundle: unknown, payouts: number[]): Promise<void> {
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
        handId,
        roomCode: this.roomCode,
        seatCount: this.seatCount,
        bundle: JSON.stringify(bundle),
      });
      await db.insert(handParticipants).values(
        participants.map((p) => ({ id: crypto.randomUUID(), handId, userId: p.userId, seat: p.seat, netResult: p.netResult })),
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
      await this.armHandStart();
    }
  }

  // Arms a fixed, content-independent delay before a hand is allowed to
  // start, the moment the ready condition is first met. This is what
  // actually closes the timing-discretion gap /fairness discloses: the
  // server commits to a deal time that can never be moved earlier (more
  // seeds arriving doesn't shorten it) or later (it can't wait past this
  // deadline to see how a set of seeds "looks") - there's no window left in
  // which "wait and see" is even possible, not just a smaller one.
  // Idempotent by design: if a start is already armed, sitting down or
  // readying up again does not reset or move the deadline.
  private async armHandStart(): Promise<void> {
    if (this.pendingHandStartAt !== null) return;
    const occupiedCount = this.seats.filter((seat, s) => seat?.connected && this.stacks[s] > 0).length;
    const noHandInProgress = !this.hand || this.hand.street === "complete";
    if (occupiedCount < 2 || !noHandInProgress) return;
    this.pendingHandStartAt = Date.now() + FAIR_START_WINDOW_MS;
    await this.persist(["pendingHandStartAt"]);
    await this.ctx.storage.setAlarm(this.pendingHandStartAt);
  }

  // Called automatically by the runtime when an armed alarm fires -
  // platform-guaranteed at-least-once, even across hibernation, which is
  // exactly the durability property a "the server MUST wait this long, no
  // exceptions" guarantee needs. A Durable Object only ever has ONE pending
  // alarm at a time (a later setAlarm call replaces an earlier one), so
  // this dispatches on which deadline is actually set - safe because the
  // two are mutually exclusive by construction: pendingHandStartAt is only
  // ever armed while no hand is in progress, actionDeadline only while one
  // is, so at most one is ever non-null at once.
  async alarm(): Promise<void> {
    await this.hydrate();
    if (this.pendingHandStartAt !== null) {
      this.pendingHandStartAt = null;
      await this.persist(["pendingHandStartAt"]);
      await this.startHandIfReady();
      return;
    }
    const dealPending = this.isTrustless && this.mpState !== null && this.mpState.phase !== "betting";
    if (!dealPending && this.actionDeadline !== null && this.hand && this.hand.toAct !== null && this.hand.street !== "complete") {
      const seat = this.hand.toAct;
      const auto: ActionType = legalActions(this.hand, seat).includes("check" as ActionType) ? "check" : "fold";
      this.actionDeadline = null;
      await this.applyEngineAction(seat, auto);
      return;
    }
    // A trustless hand can also stall outside anyone's betting turn - waiting
    // on a masking round, a partial, or a showdown reveal. There is no
    // auto-play substitute for those (they need a key only that browser
    // has), so the hand is abandoned and every chip goes back.
    if (this.isTrustless && this.mpDeadline !== null && Date.now() < this.mpDeadline) {
      // Woken early (a single DO holds one alarm, so these can overwrite each
      // other) - put the stall deadline back rather than losing it.
      await this.ctx.storage.setAlarm(this.mpDeadline);
      return;
    }
    if (this.isTrustless && this.mpDeadline !== null && Date.now() >= this.mpDeadline) {
      const stalled = this.mpState ? mp.waitingOn(this.mpState, this.contestingSeatsForMp()) : [];
      this.mpDeadline = null;
      await this.persist(["mpDeadline"]);
      await this.abortTrustlessHand(
        stalled.length > 0
          ? `seat ${stalled.join(" and ")} did not complete the dealing protocol in time`
          : "the dealing protocol did not complete in time",
      );
    }
  }

  /**
   * Arms a deadline for whatever the trustless protocol is currently waiting
   * on. Separate from actionDeadline because a stalled protocol step has no
   * legal auto-action to substitute - it can only be abandoned.
   */
  private async armMpDeadline(): Promise<void> {
    if (!this.isTrustless || !this.mpState) return;
    const active = this.mpState.phase !== "betting" && this.mpState.phase !== "complete" && this.mpState.phase !== "aborted";
    const next = active ? Date.now() + MP_STEP_TIMEOUT_MS : null;
    if (next === null) {
      if (this.mpDeadline !== null) {
        this.mpDeadline = null;
        await this.persist(["mpDeadline"]);
      }
      return;
    }
    this.mpDeadline = next;
    await this.persist(["mpDeadline"]);
    await this.ctx.storage.setAlarm(next);
  }

  // The actual dealing logic - unchanged in substance from before this
  // phase, except it's now only ever reached after armHandStart's fixed
  // window has fully elapsed, never called directly from a client message
  // handler. Re-checks readiness at fire time (not just at arm time) since
  // a seat may have left during the window - that naturally no-ops here
  // rather than needing the alarm itself to be cancelable.
  // Fixes the next hand's server entropy AND its hand id together, if they
  // aren't already fixed, so publicState() can publish the commitment
  // before any client seed for that hand is collected. Both have to be
  // pinned at the same moment: the hand id feeds the combined seed too, so
  // a server that committed a seed but still got to pick the hand id
  // afterwards could grind the shuffle through the id instead.
  //
  // Idempotent on purpose - it only generates when a slot is empty, so
  // calling it from several places (room creation, post-deal rotation,
  // hydration-after-hibernation) can never silently replace a commitment
  // that clients have already seen.
  private async ensureNextHandCommitment(): Promise<void> {
    if (this.nextServerSeed && this.nextHandId && this.nextServerSeedCommitment) return;
    this.nextServerSeed = randomHex();
    this.nextHandId = `river-table-${crypto.randomUUID()}`;
    this.nextServerSeedCommitment = await serverSeedCommitment(this.nextServerSeed);
    await this.persist(["nextServerSeed", "nextHandId", "nextServerSeedCommitment"]);
  }

  private async startHandIfReady(): Promise<void> {
    // A trustless room's hand begins with the two browsers' dealing
    // protocol, not a server-side shuffle. Betting starts once that
    // protocol reaches its betting phase (see maybeStartTrustlessBetting).
    if (this.isTrustless) {
      if (!this.mpState || this.mpState.phase === "complete" || this.mpState.phase === "aborted") {
        await this.beginTrustlessHand();
      }
      return;
    }
    const occupiedSeats: { seat: Seat; stack: number }[] = [];
    for (let s = 0; s < this.seatCount; s += 1) {
      if (this.seats[s]?.connected && this.stacks[s] > 0) occupiedSeats.push({ seat: s, stack: this.stacks[s] });
    }
    const noHandInProgress = !this.hand || this.hand.street === "complete";
    if (occupiedSeats.length < 2 || !noHandInProgress) return;

    // Both were committed to before any of this hand's client seeds were
    // collected (see ensureNextHandCommitment) - that ordering is the whole
    // basis of the fairness guarantee, so this consumes them rather than
    // generating anything fresh here.
    await this.ensureNextHandCommitment();
    const handId = this.nextHandId;
    const serverSeed = this.nextServerSeed;
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
    this.hand = await startHand(
      handId,
      this.seatCount,
      occupiedSeats,
      previousButton,
      this.smallBlind,
      this.bigBlind,
      clientSeeds,
      serverSeed,
    );
    this.stacks = this.mergedStacks(this.hand);
    this.rabbitHuntRevealed = false;
    // Rotate immediately, so the NEXT hand's commitment is already public
    // (via publicState) while this one is still being played - well before
    // any seat pre-supplies its seed for that next hand after hand-complete.
    this.nextServerSeed = "";
    this.nextHandId = "";
    this.nextServerSeedCommitment = "";
    await this.ensureNextHandCommitment();
    await this.persist(["hand", "stacks", "handStartStacks", "rabbitHuntRevealed"]);
    await this.armActionDeadline();

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
