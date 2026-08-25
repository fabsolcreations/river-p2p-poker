import {
  appendTranscript,
  evaluateSeven,
  sha256,
  shuffleDeck,
  transcriptGenesis,
  verifyTranscript,
  type Card,
  type TranscriptEntry,
} from "../app/play/proof.ts";

/**
 * Server-authoritative N-seat (2-10, live table defaults to 6) hold'em
 * engine. Framework-free (no Cloudflare APIs) - directly unit-testable.
 * `worker/poker-table.ts` is the only caller; it owns WebSocket/persistence
 * concerns, this file owns rules.
 *
 * This supersedes the earlier heads-up-only engine. Heads-up is now just
 * the seatCount === 2 case of the same general rules - notably this FIXES
 * a real simplification the old 2-seat-only engine had: postflop action
 * now correctly starts at the seat after the button (which reverses order
 * in heads-up - the big blind acts first postflop, the button/small blind
 * acts last), rather than always "seat 0 first every street." That old
 * rule only ever made sense because there was no button rotation; a real
 * button makes the correct rule necessary anyway, so heads-up gets it too.
 *
 * This does NOT reuse proof.ts's ProofBundle/verifyBundle/commitment()/
 * combinedSeed() - those are hardcoded to exactly two named parties
 * ("player"/"opponent") and a fixed deck-index convention, and stay
 * untouched, still backing the separate 2-party `/play` local demo. This
 * engine builds its own TableProofBundle/verifyTableBundle, reusing only
 * proof.ts's generic primitives (sha256, shuffleDeck, evaluateSeven,
 * appendTranscript, transcriptGenesis, verifyTranscript) - all of which
 * were already seat-count-agnostic (TranscriptEntry.actor was widened from
 * a 2-party literal union to plain `string` for this, the only proof.ts
 * change; see that file for why it's safe).
 *
 * Side pots: the standard layered algorithm (see computeSidePots) - sort
 * distinct contribution levels, each layer's eligible winners are the
 * non-folded seats that reached that level. A fold-to-one-seat isn't
 * special-cased; it flows through the same function and correctly comes
 * out as "sole contestant wins every layer," generalizing the two-party
 * engine's "one formula covers fold and all-in-for-less" to N layers.
 */

export type Seat = number;
// "showdown" only occurs in trustless (mental-poker) hands: betting is over
// but the engine is still waiting on each contesting seat to reveal the
// cards it alone can decrypt. Server-dealt hands go straight to "complete".
export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";
export type ActionType = "fold" | "call" | "check" | "raise" | "bet";

export type SidePot = { amount: number; eligibleSeats: Seat[]; winners: Seat[] };

export type EngineState = {
  handId: string;
  seatCount: number;
  buttonSeat: Seat;
  smallBlindSeat: Seat;
  bigBlindSeat: Seat;
  smallBlind: number;
  bigBlind: number;

  inHand: boolean[];
  seedCommitments: (string | null)[];
  seedReveals: (string | null)[];
  // Which party actually supplied each dealt seat's raw randomness before
  // it was hashed into the deck - "client" (that seat's own browser, via
  // crypto.getRandomValues) or "server" (this Durable Object, ONLY as a
  // fallback when a seat didn't supply its own in time). This is what
  // makes the commit-reveal scheme actually provably fair rather than
  // merely tamper-evident. Unlike earlier versions this is NOT merely
  // informational: verifyTableBundle re-derives every "server" seat's seed
  // from the pre-committed serverSeed and rejects the bundle if it doesn't
  // match, so the server can't quietly substitute a hand-picked value into
  // a fallback seat. The one thing this can't prove to a third party is
  // that a seat labelled "client" really carries the value that client
  // sent - but that seat's own browser generated it, so the player it
  // matters to can always check their own contribution survived.
  seedSources: ("client" | "server" | null)[];
  // Revealed after the hand. Its commitment (serverSeedCommitment) is
  // published to every seat BEFORE that hand's client seeds are collected,
  // which is what removes the server's ability to grind the shuffle.
  serverSeed: string;
  serverSeedCommitmentValue: string;
  combinedSeedValue: string;
  deck: Card[];
  holeCards: ([Card, Card] | null)[];
  holeCardIndices: ([number, number] | null)[];
  boardIndices: number[];
  board: Card[]; // always the full 5 - PublicHandState slices what's visible

  street: Street;
  // The last street actually played before the hand ended - distinct from
  // `street` itself, which becomes "complete" regardless of whether the
  // hand ended via a full showdown (river) or an early fold (preflop/flop/
  // turn). Used to show only the community cards that were really dealt by
  // default; a rabbit hunt request is what reveals the rest. Meaningless
  // (left at its initial value) until street === "complete".
  finalStreet: Street;
  contributed: number[]; // hand-total per seat
  streetContributed: number[]; // resets to 0 at the start of each street
  stacks: number[];
  folded: boolean[];
  allIn: boolean[];

  toAct: Seat | null;
  needsToAct: Seat[]; // seats still owed a decision this betting round
  minRaiseIncrement: number;

  transcript: TranscriptEntry[];
  sidePots: SidePot[] | null; // populated only once street === "complete"
  // Set for trustless tables, where the engine never holds the hole cards.
  // Makes a contested showdown park in street "showdown" until the Durable
  // Object supplies verified reveals via finishShowdown().
  deferShowdown?: boolean;
};

export type BetBounds = { action: "bet" | "raise"; min: number; max: number };

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

const BIG_BLIND = 2;
const SMALL_BLIND = 1;
const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];
const RANK_CODES = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

function codeToCard(code: string): Card {
  return { rank: RANK_CODES.indexOf(code[0]) + 2, suit: code[1] as Card["suit"], code };
}

// ---- seat-set helpers ------------------------------------------------

function contestingSeats(state: EngineState): Seat[] {
  const out: Seat[] = [];
  for (let s = 0; s < state.seatCount; s += 1) if (state.inHand[s] && !state.folded[s]) out.push(s);
  return out;
}

function seatsWithOption(state: EngineState): Seat[] {
  return contestingSeats(state).filter((s) => state.stacks[s] > 0);
}

function currentBet(state: EngineState): number {
  let max = 0;
  for (const s of contestingSeats(state)) if (state.streetContributed[s] > max) max = state.streetContributed[s];
  return max;
}

function facingBet(state: EngineState, seat: Seat): number {
  return currentBet(state) - state.streetContributed[seat];
}

function nextOccupiedSeat(seatCount: number, from: number, occupied: boolean[]): Seat {
  for (let i = 1; i <= seatCount; i += 1) {
    const candidate = (from + i) % seatCount;
    if (occupied[candidate]) return candidate;
  }
  throw new Error("no occupied seats");
}

function firstSeatWithOptionAfter(seatCount: number, anchor: Seat, withOption: Seat[]): Seat {
  for (let i = 1; i <= seatCount; i += 1) {
    const candidate = (anchor + i) % seatCount;
    if (withOption.includes(candidate)) return candidate;
  }
  throw new Error("unreachable: withOption is non-empty");
}

function nextInNeedsToAct(seatCount: number, from: Seat, needsToAct: Seat[]): Seat {
  for (let i = 1; i <= seatCount; i += 1) {
    const candidate = (from + i) % seatCount;
    if (needsToAct.includes(candidate)) return candidate;
  }
  throw new Error("no seat left to act - street should already be closed");
}

function dealOrder(seatCount: number, smallBlindSeat: Seat, occupied: boolean[], n: number): Seat[] {
  const order: Seat[] = [smallBlindSeat];
  let cursor = smallBlindSeat;
  while (order.length < n) {
    cursor = nextOccupiedSeat(seatCount, cursor, occupied);
    order.push(cursor);
  }
  return order;
}

function orderFromSeat(seats: Seat[], startSeat: Seat, seatCount: number): Seat[] {
  return seats.slice().sort((a, b) => {
    const da = (a - startSeat + seatCount) % seatCount;
    const db = (b - startSeat + seatCount) % seatCount;
    return da - db;
  });
}

// ---- legality / bounds -------------------------------------------------

export function legalActions(state: EngineState, seat: Seat): ActionType[] {
  if (state.toAct !== seat || state.street === "complete") return [];
  const owed = facingBet(state, seat);
  const stack = state.stacks[seat];
  if (owed > 0) return stack > owed ? ["fold", "call", "raise"] : ["fold", "call"];
  if (state.street === "preflop") return stack > 0 ? ["check", "raise"] : ["check"];
  return stack > 0 ? ["check", "bet"] : ["check"];
}

/** min collapses to max when a stack is too short for a "full" bet/raise - that's the all-in-for-less exception. */
export function betBounds(state: EngineState, seat: Seat): BetBounds | null {
  const actions = legalActions(state, seat);
  const stack = state.stacks[seat];
  if (actions.includes("bet")) return { action: "bet", min: Math.min(state.bigBlind, stack), max: stack };
  if (actions.includes("raise")) {
    const owed = facingBet(state, seat);
    return { action: "raise", min: Math.min(owed + state.minRaiseIncrement, stack), max: stack };
  }
  return null;
}

function assertLegal(state: EngineState, seat: Seat, action: ActionType): void {
  if (!legalActions(state, seat).includes(action)) {
    throw new IllegalActionError(`${action} is not legal for seat ${seat} on ${state.street}`);
  }
}

async function log(state: EngineState, actor: string, action: string, amount: number): Promise<EngineState> {
  const transcript = await appendTranscript(state.transcript, { actor, action, amount, street: state.street }, state.handId);
  return { ...state, transcript };
}

// ---- commitments / combined seed (local, not proof.ts's 2-party versions) ----

async function seatCommitment(seat: Seat, handId: string, seed: string): Promise<string> {
  return sha256(`RIVER_TABLE_COMMIT_V1|seat_${seat}|${handId}|${seed}`);
}

/**
 * The server's own per-hand entropy commitment. Deliberately binds ONLY the
 * seed - not the handId - because the commitment is published before the
 * hand it belongs to is dealt, and worker/poker-table.ts fixes the handId at
 * the same moment it fixes this seed (see armHandStart). Binding a handId
 * the server could still choose afterwards would hand back exactly the
 * grinding freedom this commitment exists to remove.
 */
export async function serverSeedCommitment(serverSeed: string): Promise<string> {
  return sha256(`RIVER_TABLE_SERVER_COMMIT_V1|${serverSeed}`);
}

/**
 * A seat that didn't supply its own randomness in time gets this instead of
 * a freshly-generated value. Deriving it deterministically from the
 * already-committed server seed is the whole point: a `randomHex()` call at
 * deal time would be generated AFTER the server has seen every client seed
 * that did arrive, letting it re-roll that one value until the resulting
 * deck suited it - and since the server also decides whether a seed
 * "arrived", it could force that fallback on any seat at will. Pinning the
 * fallback to the pre-commitment leaves the server no freedom in either
 * direction.
 */
async function fallbackSeatSeed(serverSeed: string, handId: string, seat: Seat): Promise<string> {
  return sha256(`RIVER_TABLE_FALLBACK_V1|${handId}|seat_${seat}|${serverSeed}`);
}

async function tableCombinedSeed(handId: string, serverSeed: string, seedsBySeatAsc: string[]): Promise<string> {
  return sha256(`RIVER_TABLE_DECK_V2|${handId}|${serverSeed}|${seedsBySeatAsc.join("|")}`);
}

// ---- hand comparison (local - proof.ts's compareScores isn't exported) ----

function compareScoresLocal(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHandSeats(seats: Seat[], holeCards: EngineState["holeCards"], board: Card[]): Seat[] {
  let bestScore: number[] | null = null;
  let winners: Seat[] = [];
  for (const seat of seats) {
    const hole = holeCards[seat];
    if (!hole) continue;
    const value = evaluateSeven([...hole, ...board]);
    const cmp = bestScore ? compareScoresLocal(value.score, bestScore) : 1;
    if (cmp > 0) {
      bestScore = value.score;
      winners = [seat];
    } else if (cmp === 0) {
      winners.push(seat);
    }
  }
  return winners;
}

/**
 * Standard layered side-pot algorithm. A layer with zero eligible seats
 * cannot occur in a valid terminal state: either the hand already ended
 * via fold-to-one (that seat is eligible at every layer up to its own
 * contribution), or it reached showdown, where the final aggressor - by
 * construction never folded - anchors the top layer, and induction downward
 * guarantees every lower layer keeps at least one non-folded contributor.
 */
export function computeSidePots(
  seatCount: number,
  contributed: number[],
  folded: boolean[],
  holeCards: EngineState["holeCards"],
  board: Card[],
): SidePot[] {
  const contributors: Seat[] = [];
  for (let s = 0; s < seatCount; s += 1) if (contributed[s] > 0) contributors.push(s);

  const levels = Array.from(new Set(contributors.map((s) => contributed[s]))).sort((a, b) => a - b);
  const pots: SidePot[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const atLevel = contributors.filter((s) => contributed[s] >= level);
    const amount = (level - previousLevel) * atLevel.length;
    const eligibleSeats = atLevel.filter((s) => !folded[s]);
    if (eligibleSeats.length === 0) {
      throw new Error("engine invariant violated: side-pot layer with no eligible seat");
    }
    // Adjacent layers with identical eligibility (the common case: a fold,
    // or any pot nobody contested unevenly) get merged below into one pot -
    // the winners a layer resolves to are a pure function of its eligible
    // set, so two layers with the same eligibility always agree on winners
    // and can safely share one amount.
    const last = pots[pots.length - 1];
    if (last && sameSeatSetLocal(last.eligibleSeats, eligibleSeats)) {
      last.amount += amount;
    } else {
      const winners = eligibleSeats.length === 1 ? eligibleSeats : bestHandSeats(eligibleSeats, holeCards, board);
      pots.push({ amount, eligibleSeats, winners });
    }
    previousLevel = level;
  }
  return pots;
}

function sameSeatSetLocal(a: Seat[], b: Seat[]): boolean {
  return a.length === b.length && new Set(a).size === new Set(b).size && a.every((v) => b.includes(v));
}

// ---- hand lifecycle ------------------------------------------------------

export async function startHand(
  handId: string,
  seatCount: number,
  occupiedSeats: { seat: Seat; stack: number }[],
  previousButton: Seat | null,
  smallBlind: number = SMALL_BLIND,
  bigBlind: number = BIG_BLIND,
  // A seat missing here (didn't supply its own randomness in time - a slow
  // connection, a very fast first hand, an older client) falls back to a
  // value derived deterministically from serverSeed. That fallback is
  // tracked in seedSources and never hidden - see EngineState's comment.
  clientSeeds: Partial<Record<Seat, string>> = {},
  // The server's own entropy for this hand. Must already have been
  // committed to (and that commitment published to every seat) BEFORE any
  // of the clientSeeds above were collected - see serverSeedCommitment and
  // worker/poker-table.ts's armHandStart, which is what makes this whole
  // scheme grind-proof rather than merely tamper-evident.
  serverSeed: string,
): Promise<EngineState> {
  if (occupiedSeats.length < 2) throw new Error("need at least 2 seats to start a hand");
  const n = occupiedSeats.length;
  const occupied = new Array(seatCount).fill(false);
  const stackBySeat = new Array(seatCount).fill(0);
  for (const { seat, stack } of occupiedSeats) {
    occupied[seat] = true;
    stackBySeat[seat] = stack;
  }

  const buttonSeat = nextOccupiedSeat(seatCount, previousButton ?? -1, occupied);
  const isHeadsUp = n === 2;
  const smallBlindSeat = isHeadsUp ? buttonSeat : nextOccupiedSeat(seatCount, buttonSeat, occupied);
  const bigBlindSeat = nextOccupiedSeat(seatCount, smallBlindSeat, occupied);
  const dealtSeats = dealOrder(seatCount, smallBlindSeat, occupied, n);

  const seedsBySeat: (string | null)[] = new Array(seatCount).fill(null);
  const commitmentsBySeat: (string | null)[] = new Array(seatCount).fill(null);
  const seedSources: ("client" | "server" | null)[] = new Array(seatCount).fill(null);
  for (const seat of dealtSeats) {
    const clientSeed = clientSeeds[seat];
    const seed = clientSeed ?? (await fallbackSeatSeed(serverSeed, handId, seat));
    seedsBySeat[seat] = seed;
    seedSources[seat] = clientSeed ? "client" : "server";
    commitmentsBySeat[seat] = await seatCommitment(seat, handId, seed);
  }
  const seedsBySeatAsc = dealtSeats
    .slice()
    .sort((a, b) => a - b)
    .map((s) => seedsBySeat[s]!);
  const combinedSeedValue = await tableCombinedSeed(handId, serverSeed, seedsBySeatAsc);
  const deck = await shuffleDeck(combinedSeedValue);

  const holeCards: ([Card, Card] | null)[] = new Array(seatCount).fill(null);
  const holeCardIndices: ([number, number] | null)[] = new Array(seatCount).fill(null);
  dealtSeats.forEach((seat, i) => {
    const first = i;
    const second = n + i;
    holeCards[seat] = [deck[first], deck[second]];
    holeCardIndices[seat] = [first, second];
  });
  const boardStart = 2 * n;
  const boardIndices = [boardStart + 1, boardStart + 2, boardStart + 3, boardStart + 5, boardStart + 7];
  const board = boardIndices.map((i) => deck[i]);

  const inHand = new Array(seatCount).fill(false);
  for (const seat of dealtSeats) inHand[seat] = true;

  let state: EngineState = {
    handId,
    seatCount,
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    smallBlind,
    bigBlind,
    inHand,
    seedCommitments: commitmentsBySeat,
    seedReveals: seedsBySeat,
    seedSources,
    serverSeed,
    serverSeedCommitmentValue: await serverSeedCommitment(serverSeed),
    combinedSeedValue,
    deck,
    holeCards,
    holeCardIndices,
    boardIndices,
    board,
    street: "preflop",
    finalStreet: "preflop",
    contributed: new Array(seatCount).fill(0),
    streetContributed: new Array(seatCount).fill(0),
    stacks: stackBySeat,
    folded: new Array(seatCount).fill(false),
    allIn: new Array(seatCount).fill(false),
    toAct: null,
    needsToAct: [],
    minRaiseIncrement: bigBlind,
    transcript: [],
    sidePots: null,
  };

  for (const seat of dealtSeats) state = await log(state, "protocol", `commit_seat_${seat}`, 0);

  {
    const { state: next, posted } = postBlind(state, smallBlindSeat, smallBlind);
    state = await log(next, `seat_${smallBlindSeat}`, "post_small_blind", posted);
  }
  {
    const { state: next, posted } = postBlind(state, bigBlindSeat, bigBlind);
    state = await log(next, `seat_${bigBlindSeat}`, "post_big_blind", posted);
  }

  return beginStreet(state);
}

function postBlind(state: EngineState, seat: Seat, blind: number): { state: EngineState; posted: number } {
  const posted = Math.min(blind, state.stacks[seat]);
  return { state: applyContribution(state, seat, posted), posted };
}

function applyContribution(state: EngineState, seat: Seat, amount: number): EngineState {
  const contributed = state.contributed.slice();
  contributed[seat] += amount;
  const streetContributed = state.streetContributed.slice();
  streetContributed[seat] += amount;
  const stacks = state.stacks.slice();
  stacks[seat] -= amount;
  const allIn = state.allIn.slice();
  allIn[seat] = stacks[seat] === 0;
  return { ...state, contributed, streetContributed, stacks, allIn };
}

function setAt(arr: boolean[], index: number, value: boolean): boolean[] {
  const next = arr.slice();
  next[index] = value;
  return next;
}

function dealNextStreet(state: EngineState): EngineState {
  const next = STREET_ORDER[STREET_ORDER.indexOf(state.street) + 1];
  return { ...state, street: next, streetContributed: state.streetContributed.map(() => 0), minRaiseIncrement: state.bigBlind, toAct: null, needsToAct: [] };
}

async function closeStreet(state: EngineState): Promise<EngineState> {
  if (state.street === "river") return resolveHandEnd(state);
  return beginStreet(dealNextStreet(state));
}

async function beginStreet(state: EngineState): Promise<EngineState> {
  if (contestingSeats(state).length === 1) return resolveHandEnd(state);
  const withOption = seatsWithOption(state);
  if (withOption.length < 2) return closeStreet(state);
  const anchor = state.street === "preflop" ? state.bigBlindSeat : state.buttonSeat;
  const toAct = firstSeatWithOptionAfter(state.seatCount, anchor, withOption);
  return { ...state, toAct, needsToAct: withOption };
}

/**
 * Starts a hand the engine holds no cards for - the trustless (mental-poker)
 * path, where the two browsers deal to each other and this process only
 * referees betting. Seating, blinds and the transcript are identical to
 * startHand; everything card-shaped is left empty and arrives later:
 * the board via finishShowdown, hole cards via verified reveals.
 *
 * Kept as its own entry point rather than a flag on startHand so there is no
 * code path where a trustless table quietly generates a real deck the server
 * could read.
 */
export async function startTrustlessHand(
  handId: string,
  seatCount: number,
  occupiedSeats: { seat: Seat; stack: number }[],
  previousButton: Seat | null,
  smallBlind: number = SMALL_BLIND,
  bigBlind: number = BIG_BLIND,
): Promise<EngineState> {
  if (occupiedSeats.length !== 2) throw new Error("trustless hands are heads-up only");
  const occupied = new Array(seatCount).fill(false);
  const stackBySeat = new Array(seatCount).fill(0);
  for (const { seat, stack } of occupiedSeats) {
    occupied[seat] = true;
    stackBySeat[seat] = stack;
  }

  const buttonSeat = nextOccupiedSeat(seatCount, previousButton ?? -1, occupied);
  const smallBlindSeat = buttonSeat; // heads-up: button posts the small blind
  const bigBlindSeat = nextOccupiedSeat(seatCount, smallBlindSeat, occupied);
  const dealtSeats = dealOrder(seatCount, smallBlindSeat, occupied, occupiedSeats.length);

  const inHand = new Array(seatCount).fill(false);
  for (const seat of dealtSeats) inHand[seat] = true;

  let state: EngineState = {
    handId,
    seatCount,
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    smallBlind,
    bigBlind,
    inHand,
    // The seed/commit fields belong to the server-dealt scheme. A trustless
    // hand's cryptographic record is the ProofBundleV3 the two parties build
    // instead, so these stay empty rather than carrying misleading values.
    seedCommitments: new Array(seatCount).fill(null),
    seedReveals: new Array(seatCount).fill(null),
    seedSources: new Array(seatCount).fill(null),
    serverSeed: "",
    serverSeedCommitmentValue: "",
    combinedSeedValue: "",
    deck: [],
    holeCards: new Array(seatCount).fill(null),
    holeCardIndices: new Array(seatCount).fill(null),
    boardIndices: [],
    board: [],
    street: "preflop",
    finalStreet: "preflop",
    contributed: new Array(seatCount).fill(0),
    streetContributed: new Array(seatCount).fill(0),
    stacks: stackBySeat,
    folded: new Array(seatCount).fill(false),
    allIn: new Array(seatCount).fill(false),
    toAct: null,
    needsToAct: [],
    minRaiseIncrement: bigBlind,
    transcript: [],
    sidePots: null,
    deferShowdown: true,
  };

  {
    const { state: next, posted } = postBlind(state, smallBlindSeat, smallBlind);
    state = await log(next, `seat_${smallBlindSeat}`, "post_small_blind", posted);
  }
  {
    const { state: next, posted } = postBlind(state, bigBlindSeat, bigBlind);
    state = await log(next, `seat_${bigBlindSeat}`, "post_big_blind", posted);
  }

  return beginStreet(state);
}

/**
 * In a trustless (mental-poker) hand the engine genuinely does not have the
 * hole cards - only the two browsers do - so a contested showdown can't be
 * resolved inline the way a server-dealt one is. Parking the hand in
 * "showdown" lets the Durable Object collect and verify each seat's reveal
 * first, then call finishShowdown with real cards.
 *
 * A hand that ends with a single contestant needs no cards at all (nobody's
 * hand is compared to anything), so it still resolves immediately - which
 * keeps the common fold-out case free of an extra round trip.
 */
function needsRevealBeforeResolve(state: EngineState): boolean {
  return state.deferShowdown === true && contestingSeats(state).length > 1;
}

async function resolveHandEnd(state: EngineState): Promise<EngineState> {
  if (needsRevealBeforeResolve(state)) {
    return { ...state, street: "showdown", toAct: null, needsToAct: [] };
  }
  return awardAndComplete(state);
}

/**
 * Completes a trustless hand once every contesting seat's hole cards have
 * been revealed and checked against the committed deck by the caller. The
 * cards are dropped straight into state.holeCards, so the award logic below
 * is the exact same code path a server-dealt hand takes.
 */
export async function finishShowdown(
  state: EngineState,
  holeCards: EngineState["holeCards"],
  board: Card[],
): Promise<EngineState> {
  if (state.street !== "showdown") throw new IllegalActionError("hand is not awaiting a showdown reveal");
  if (board.length !== 5) throw new IllegalActionError("a showdown needs the full five-card board");
  return awardAndComplete({ ...state, holeCards, board, finalStreet: "river" });
}

/** Turns the protocol's card codes ("As") into the engine's Card shape. */
export function cardsFromCodes(codes: string[]): Card[] {
  return codes.map(codeToCard);
}

async function awardAndComplete(state: EngineState): Promise<EngineState> {
  let next = state;
  const contesting = contestingSeats(state);
  if (contesting.length > 1) {
    next = await log(next, "protocol", "reveal_seeds", 0);
    for (const seat of contesting) next = await log(next, `seat_${seat}`, "reveal_hole_cards", 0);
  }

  const sidePots = computeSidePots(next.seatCount, next.contributed, next.folded, next.holeCards, next.board);
  const stacks = next.stacks.slice();
  for (const sp of sidePots) {
    const share = Math.floor(sp.amount / sp.winners.length);
    let remainder = sp.amount - share * sp.winners.length;
    for (const seat of orderFromSeat(sp.winners, (next.buttonSeat + 1) % next.seatCount, next.seatCount)) {
      stacks[seat] += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    next = await log(next, "protocol", "award_pot", sp.amount);
  }

  // state.street is "showdown" when we came via finishShowdown, which isn't
  // a street anyone played - the caller set the real one already.
  const finalStreet = state.street === "showdown" ? state.finalStreet : state.street;
  return { ...next, stacks, street: "complete", finalStreet, toAct: null, needsToAct: [], sidePots };
}

export async function applyAction(state: EngineState, seat: Seat, action: ActionType, amount?: number): Promise<EngineState> {
  assertLegal(state, seat, action);
  const actor = `seat_${seat}`;

  if (action === "fold") {
    let next: EngineState = { ...state, folded: setAt(state.folded, seat, true) };
    next = await log(next, actor, "fold", 0);
    if (contestingSeats(next).length === 1) return resolveHandEnd(next);
    return advanceOrClose(next, seat, next.needsToAct.filter((s) => s !== seat));
  }

  if (action === "call") {
    const owed = Math.min(facingBet(state, seat), state.stacks[seat]);
    let next = applyContribution(state, seat, owed);
    next = await log(next, actor, "call", owed);
    return advanceOrClose(next, seat, next.needsToAct.filter((s) => s !== seat));
  }

  if (action === "check") {
    const next = await log(state, actor, "check", 0);
    return advanceOrClose(next, seat, next.needsToAct.filter((s) => s !== seat));
  }

  // "raise" or "bet" - both require a validated amount.
  const bounds = betBounds(state, seat);
  if (!bounds || amount === undefined || !Number.isInteger(amount) || amount < bounds.min || amount > bounds.max) {
    throw new IllegalActionError(`invalid ${action} amount${amount === undefined ? " (none given)" : `: ${amount}`}`);
  }
  const priorFacingBet = facingBet(state, seat);
  let next = applyContribution(state, seat, amount);
  if (action === "bet") {
    next = { ...next, minRaiseIncrement: Math.max(next.minRaiseIncrement, amount) };
    next = await log(next, actor, "bet", amount);
  } else {
    const increment = amount - priorFacingBet;
    next = { ...next, minRaiseIncrement: Math.max(next.minRaiseIncrement, increment) };
    next = await log(next, actor, `raise_to_${next.streetContributed[seat]}`, amount);
  }
  // A bet/raise reopens the action for every other seat that still has
  // chips - this single line replaces the old 2-party isOpeningLimp/
  // isOpeningCheck special cases.
  return advanceOrClose(next, seat, seatsWithOption(next).filter((s) => s !== seat));
}

function advanceOrClose(state: EngineState, actingSeat: Seat, needsToAct: Seat[]): EngineState | Promise<EngineState> {
  if (needsToAct.length === 0) return closeStreet({ ...state, needsToAct });
  return { ...state, needsToAct, toAct: nextInNeedsToAct(state.seatCount, actingSeat, needsToAct) };
}

// ---- proof bundle / verifier ---------------------------------------------

export type TableProofBundle = {
  version: "RIVER_TABLE_V2";
  handId: string;
  seatCount: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  inHand: boolean[];
  commitments: (string | null)[];
  reveals: (string | null)[];
  // Cryptographically checked for every seat marked "server" - see
  // EngineState.seedSources and verifyTableBundle's fallbackSeeds check.
  entropySource: ("client" | "server" | null)[];
  // The server's revealed entropy plus the commitment that was published
  // before this hand's client seeds were collected. verifyTableBundle
  // re-hashes the seed and rejects any mismatch.
  serverSeed: string;
  serverSeedCommitment: string;
  combinedSeed: string;
  deck: string[];
  holeCardDeckIndices: ([number, number] | null)[];
  boardDeckIndices: number[];
  transcript: TranscriptEntry[];
  finalTranscriptHash: string;
  sidePots: { amount: number; eligibleSeats: number[]; winners: number[] }[];
};

export type TableVerificationResult = {
  valid: boolean;
  checks: {
    version: boolean;
    commitments: boolean;
    serverCommitment: boolean;
    fallbackSeeds: boolean;
    combinedSeed: boolean;
    deterministicDeck: boolean;
    uniqueDeck: boolean;
    transcriptChain: boolean;
    contributionsConserved: boolean;
    sidePotsMatch: boolean;
    showdownRevealed: boolean;
  };
};

export function buildProofBundle(state: EngineState): TableProofBundle {
  return {
    version: "RIVER_TABLE_V2",
    handId: state.handId,
    seatCount: state.seatCount,
    buttonSeat: state.buttonSeat,
    smallBlindSeat: state.smallBlindSeat,
    bigBlindSeat: state.bigBlindSeat,
    inHand: state.inHand,
    commitments: state.seedCommitments,
    reveals: state.seedReveals,
    entropySource: state.seedSources,
    serverSeed: state.serverSeed,
    serverSeedCommitment: state.serverSeedCommitmentValue,
    combinedSeed: state.combinedSeedValue,
    deck: state.deck.map((c) => c.code),
    holeCardDeckIndices: state.holeCardIndices,
    boardDeckIndices: state.boardIndices,
    transcript: state.transcript,
    finalTranscriptHash: state.transcript.at(-1)?.hash ?? "",
    sidePots: (state.sidePots ?? []).map((sp) => ({ amount: sp.amount, eligibleSeats: sp.eligibleSeats, winners: sp.winners })),
  };
}

function replayTranscript(seatCount: number, transcript: TranscriptEntry[]): { contributed: number[]; folded: boolean[] } {
  const contributed = new Array(seatCount).fill(0);
  const folded = new Array(seatCount).fill(false);
  const contributionActions = new Set(["post_small_blind", "post_big_blind", "call", "bet"]);
  for (const entry of transcript) {
    const match = /^seat_(\d+)$/.exec(entry.actor);
    if (!match) continue;
    const seat = Number(match[1]);
    if (seat < 0 || seat >= seatCount) continue;
    if (entry.action === "fold") {
      folded[seat] = true;
    } else if (contributionActions.has(entry.action) || entry.action.startsWith("raise_to_")) {
      if (Number.isFinite(entry.amount) && entry.amount >= 0) contributed[seat] += entry.amount;
    }
  }
  return { contributed, folded };
}

function sameSeatSet(a: number[], b: number[]): boolean {
  return a.length === b.length && new Set(a).size === new Set(b).size && a.every((v) => b.includes(v));
}

function sidePotsEqual(a: SidePot[], b: TableProofBundle["sidePots"]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].amount !== b[i].amount) return false;
    if (!sameSeatSet(a[i].eligibleSeats, b[i].eligibleSeats)) return false;
    if (!sameSeatSet(a[i].winners, b[i].winners)) return false;
  }
  return true;
}

export async function verifyTableBundle(bundle: TableProofBundle): Promise<TableVerificationResult> {
  const dealtSeats: number[] = [];
  for (let s = 0; s < bundle.seatCount; s += 1) if (bundle.inHand[s]) dealtSeats.push(s);

  let commitmentsOk = dealtSeats.length > 0;
  for (const seat of dealtSeats) {
    const reveal = bundle.reveals[seat];
    const commit = bundle.commitments[seat];
    if (reveal === null || commit === null || (await seatCommitment(seat, bundle.handId, reveal)) !== commit) {
      commitmentsOk = false;
    }
  }

  // The server's own entropy has to hash to the commitment it published
  // before this hand's client seeds were collected. Without this, every
  // other seed check below is still satisfiable by a server that simply
  // re-rolled its own contribution until it liked the resulting deck.
  const serverCommitmentOk =
    typeof bundle.serverSeed === "string" &&
    bundle.serverSeed.length > 0 &&
    (await serverSeedCommitment(bundle.serverSeed)) === bundle.serverSeedCommitment;

  // Every seat that fell back to server randomness must carry exactly the
  // value derived from that committed seed - so "this seat didn't send one
  // in time" can never be a cover story for a hand-picked seed.
  let fallbackSeedsOk = serverCommitmentOk;
  for (const seat of dealtSeats) {
    if (bundle.entropySource[seat] !== "server") continue;
    const expected = await fallbackSeatSeed(bundle.serverSeed, bundle.handId, seat);
    if (bundle.reveals[seat] !== expected) fallbackSeedsOk = false;
  }

  const seedsAsc = dealtSeats
    .slice()
    .sort((a, b) => a - b)
    .map((s) => bundle.reveals[s]);
  const allSeedsRevealed = seedsAsc.every((s): s is string => s !== null);
  const expectedCombinedSeed = allSeedsRevealed
    ? await tableCombinedSeed(bundle.handId, bundle.serverSeed, seedsAsc as string[])
    : null;
  const combinedSeedOk = expectedCombinedSeed !== null && expectedCombinedSeed === bundle.combinedSeed;

  const expectedDeck = combinedSeedOk ? (await shuffleDeck(bundle.combinedSeed)).map((c) => c.code) : [];
  const deterministicDeckOk = combinedSeedOk && expectedDeck.length === bundle.deck.length && expectedDeck.every((c, i) => c === bundle.deck[i]);
  const uniqueDeckOk = bundle.deck.length === 52 && new Set(bundle.deck).size === 52;

  const transcriptChainOk =
    (await verifyTranscript(bundle.transcript, bundle.handId)) &&
    (bundle.transcript.at(-1)?.hash ?? (await transcriptGenesis(bundle.handId))) === bundle.finalTranscriptHash;

  const { contributed, folded } = replayTranscript(bundle.seatCount, bundle.transcript);
  const totalContributed = contributed.reduce((a, b) => a + b, 0);
  const totalSidePots = bundle.sidePots.reduce((a, sp) => a + sp.amount, 0);
  const contributionsConservedOk = totalContributed === totalSidePots;

  const deckCards = bundle.deck.map(codeToCard);
  const holeCards: EngineState["holeCards"] = new Array(bundle.seatCount).fill(null);
  for (const seat of dealtSeats) {
    const indices = bundle.holeCardDeckIndices[seat];
    if (indices) holeCards[seat] = [deckCards[indices[0]], deckCards[indices[1]]];
  }
  const board = bundle.boardDeckIndices.map((i) => deckCards[i]);
  let sidePotsMatchOk: boolean;
  try {
    const expectedSidePots = computeSidePots(bundle.seatCount, contributed, folded, holeCards, board);
    sidePotsMatchOk = sidePotsEqual(expectedSidePots, bundle.sidePots);
  } catch {
    sidePotsMatchOk = false;
  }

  const revealedSeats = new Set<number>();
  for (const entry of bundle.transcript) {
    if (entry.action === "reveal_hole_cards") {
      const match = /^seat_(\d+)$/.exec(entry.actor);
      if (match) revealedSeats.add(Number(match[1]));
    }
  }
  let showdownRevealedOk = true;
  for (const sp of bundle.sidePots) {
    if (sp.eligibleSeats.length > 1) {
      for (const seat of sp.eligibleSeats) if (!revealedSeats.has(seat)) showdownRevealedOk = false;
    }
  }

  const checks = {
    version: bundle.version === "RIVER_TABLE_V2",
    commitments: commitmentsOk,
    serverCommitment: serverCommitmentOk,
    fallbackSeeds: fallbackSeedsOk,
    combinedSeed: combinedSeedOk,
    deterministicDeck: deterministicDeckOk,
    uniqueDeck: uniqueDeckOk,
    transcriptChain: transcriptChainOk,
    contributionsConserved: contributionsConservedOk,
    sidePotsMatch: sidePotsMatchOk,
    showdownRevealed: showdownRevealedOk,
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}
