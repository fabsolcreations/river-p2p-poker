import {
  appendProtocolEntry,
  cardPointTable,
  dealCommunityCard,
  deriveMaskingRound,
  jointPublicKey,
  parseCiphertext,
  type DealReveal,
  type PointHex,
  type ProofBundleV3,
  type Role,
} from "../app/play/mental-poker.ts";
import type { TranscriptEntry } from "../app/play/proof.ts";

/**
 * Phase machine for a trustless (mental-poker) heads-up hand.
 *
 * Pure and framework-free on purpose - same split as table-engine.ts vs
 * poker-table.ts: this file owns "what may happen next and is this message
 * legal", the Durable Object owns sockets, storage and timers. That keeps
 * the part with the security-relevant ordering rules unit-testable in plain
 * Node, without a Workers runtime.
 *
 * The server is a RELAY here, not a dealer. It never holds a secret key and
 * cannot decrypt a hole card at any point during play. Its jobs are:
 *   - enforce the order of the protocol so neither party can skip a step or
 *     act out of turn,
 *   - hold the artifacts both parties need to exchange,
 *   - and at showdown, verify a claimed hole card really is the card sitting
 *     at that deck position, using the revealer's own partial plus the
 *     opponent partial it already relayed. That check needs no secret key,
 *     which is exactly why the server can referee without ever seeing cards
 *     early.
 *
 * Deck position convention matches the Phase 1 demo (app/play/deal-lab):
 * seat 0 takes positions 0 and 2, seat 1 takes 1 and 3, and the board is
 * drawn from 5,6,7 (flop), 9 (turn), 11 (river) - the gaps are burn cards.
 */

export const HOLE_POSITIONS: Record<number, number[]> = { 0: [0, 2], 1: [1, 3] };
export const BOARD_POSITIONS = [5, 6, 7, 9, 11];
export const FLOP_POSITIONS = [5, 6, 7];
export const TURN_POSITIONS = [9];
export const RIVER_POSITIONS = [11];

export type MpPhase =
  | "commit"
  | "mask-seat-0"
  | "mask-seat-1"
  | "hole-partials"
  | "betting"
  | "board-partials"
  | "showdown"
  | "settle"
  | "complete"
  | "aborted";

export type MpState = {
  handId: string;
  phase: MpPhase;
  /** Masker-seed commitments, by seat. Both required before any masking. */
  commitments: (string | null)[];
  /**
   * ElGamal public keys, by seat. Published openly with the commitment -
   * masking requires the JOINT key, so both halves must be known before
   * anyone can mask. Safe to publish: the key reveals nothing about the
   * committed seed, which is what fixes the permutation and randomizers.
   */
  publicKeys: (string | null)[];
  /** Deck after seat 0's masking round, then after seat 1's. */
  deckAfterSeat0: string[] | null;
  maskedDeck: string[] | null;
  /** position -> partial supplied by the seat that is NOT the recipient. */
  holePartials: Record<number, string | undefined>;
  /** position -> { seat -> partial }. Both needed to reveal a board card. */
  boardPartials: Record<number, Record<number, string | undefined>>;
  /** Board card codes revealed so far, in BOARD_POSITIONS order. */
  board: string[];
  /** Which board positions have been released - drives street gating. */
  releasedBoardPositions: number[];
  /** seat -> its two hole card codes, only after a verified showdown reveal. */
  revealedHole: Record<number, [string, string] | undefined>;
  /** Masker seeds, revealed only after the hand is over. */
  maskerSeeds: (string | null)[];
  abortReason: string | null;
};

export function initialMpState(handId: string): MpState {
  return {
    handId,
    phase: "commit",
    commitments: [null, null],
    publicKeys: [null, null],
    deckAfterSeat0: null,
    maskedDeck: null,
    holePartials: {},
    boardPartials: {},
    board: [],
    releasedBoardPositions: [],
    revealedHole: {},
    maskerSeeds: [null, null],
    abortReason: null,
  };
}

export class MpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpProtocolError";
  }
}

const DECK_SIZE = 52;
const HEX_64 = /^[0-9a-f]{64}$/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MpProtocolError(message);
}

function isSerializedDeck(value: unknown): value is string[] {
  return Array.isArray(value) && value.length === DECK_SIZE && value.every((entry) => typeof entry === "string");
}

/** The seat that must supply the partial for a given hole position. */
export function holePartialProvider(position: number): number {
  return HOLE_POSITIONS[0].includes(position) ? 1 : 0;
}

export function holeOwner(position: number): number {
  return HOLE_POSITIONS[0].includes(position) ? 0 : 1;
}

export function positionsForStreet(street: string): number[] {
  if (street === "flop") return FLOP_POSITIONS;
  if (street === "turn") return TURN_POSITIONS;
  if (street === "river") return RIVER_POSITIONS;
  return [];
}

// ---- transitions ------------------------------------------------------

export function applyCommitment(state: MpState, seat: number, commitmentHex: string, publicKeyHex: string): MpState {
  assert(state.phase === "commit", `commitments are closed (phase ${state.phase})`);
  assert(seat === 0 || seat === 1, "unknown seat");
  assert(HEX_64.test(commitmentHex), "commitment must be a 64-char hex hash");
  assert(typeof publicKeyHex === "string" && publicKeyHex.length > 0, "missing public key");
  assert(state.commitments[seat] === null, "seat already committed");

  const commitments = state.commitments.slice();
  const publicKeys = state.publicKeys.slice();
  commitments[seat] = commitmentHex;
  publicKeys[seat] = publicKeyHex;
  const bothIn = commitments.every((entry) => entry !== null);
  return { ...state, commitments, publicKeys, phase: bothIn ? "mask-seat-0" : "commit" };
}

/**
 * Masking rounds are strictly sequential: seat 1 masks the deck seat 0
 * already masked. Order matters for the post-hand replay, so the phase - not
 * the message - decides whose turn it is.
 */
export function applyMaskRound(state: MpState, seat: number, deck: unknown): MpState {
  assert(state.phase === "mask-seat-0" || state.phase === "mask-seat-1", `not accepting masking (phase ${state.phase})`);
  const expectedSeat = state.phase === "mask-seat-0" ? 0 : 1;
  assert(seat === expectedSeat, `it is seat ${expectedSeat}'s turn to mask`);
  assert(isSerializedDeck(deck), `masked deck must be ${DECK_SIZE} serialized ciphertexts`);

  if (expectedSeat === 0) return { ...state, deckAfterSeat0: deck, phase: "mask-seat-1" };
  return { ...state, maskedDeck: deck, phase: "hole-partials" };
}

/**
 * A seat supplies the partial decryption for one of the OTHER seat's hole
 * positions. It learns nothing by doing so - stripping its own layer leaves
 * a value only the recipient's key can finish.
 */
export function applyHolePartial(state: MpState, seat: number, position: number, partial: string): MpState {
  assert(state.phase === "hole-partials", `not accepting hole partials (phase ${state.phase})`);
  const allHolePositions = [...HOLE_POSITIONS[0], ...HOLE_POSITIONS[1]];
  assert(allHolePositions.includes(position), "not a hole-card position");
  assert(seat === holePartialProvider(position), "only the non-recipient supplies this partial");
  assert(typeof partial === "string" && partial.length > 0, "missing partial");
  assert(state.holePartials[position] === undefined, "partial already supplied for this position");

  const holePartials = { ...state.holePartials, [position]: partial };
  const complete = allHolePositions.every((pos) => holePartials[pos] !== undefined);
  return { ...state, holePartials, phase: complete ? "betting" : "hole-partials" };
}

/**
 * Board partials are gated per street on purpose: releasing them all up
 * front would let either party combine partials and read the whole board
 * before betting, which is the same leak as a dealer showing the river early.
 */
export function openBoardStreet(state: MpState, street: string): MpState {
  const positions = positionsForStreet(street);
  assert(positions.length > 0, `no board cards for street ${street}`);
  assert(state.phase === "betting", `cannot open board cards from phase ${state.phase}`);
  const boardPartials = { ...state.boardPartials };
  for (const position of positions) boardPartials[position] ??= {};
  return { ...state, boardPartials, phase: "board-partials" };
}

export type BoardPartialResult = { state: MpState; revealedPositions: number[] };

export async function applyBoardPartial(
  state: MpState,
  seat: number,
  position: number,
  partial: string,
): Promise<BoardPartialResult> {
  assert(state.phase === "board-partials", `not accepting board partials (phase ${state.phase})`);
  assert(seat === 0 || seat === 1, "unknown seat");
  assert(BOARD_POSITIONS.includes(position), "not a board position");
  const pending = state.boardPartials[position];
  assert(pending !== undefined, "that board card is not open yet");
  assert(pending[seat] === undefined, "partial already supplied");

  const boardPartials = { ...state.boardPartials, [position]: { ...pending, [seat]: partial } };
  const table = await cardPointTable();
  const board = state.board.slice();
  const released = state.releasedBoardPositions.slice();

  // Any position that now has both partials can be turned into a real card.
  const openPositions = Object.keys(boardPartials).map(Number).sort((a, b) => a - b);
  const revealedPositions: number[] = [];
  for (const pos of openPositions) {
    const partials = boardPartials[pos];
    if (partials[0] === undefined || partials[1] === undefined) continue;
    if (released.includes(pos)) continue;
    const ciphertext = parseCiphertext(state.maskedDeck![pos]);
    const code = dealCommunityCard(ciphertext, partials[0] as PointHex, partials[1] as PointHex, table.byPointHex);
    assert(code !== null, `board partials at position ${pos} do not decrypt to a real card`);
    released.push(pos);
    revealedPositions.push(pos);
    board.push(code);
  }

  const everyOpenPositionResolved = openPositions.every((pos) => released.includes(pos));
  return {
    state: {
      ...state,
      boardPartials,
      board,
      releasedBoardPositions: released,
      phase: everyOpenPositionResolved ? "betting" : "board-partials",
    },
    revealedPositions,
  };
}

export function beginShowdown(state: MpState): MpState {
  assert(state.phase === "betting" || state.phase === "board-partials", `cannot start showdown from ${state.phase}`);
  return { ...state, phase: "showdown" };
}

/**
 * Verifies a claimed pair of hole cards without ever needing a secret key:
 * the revealer supplies its own partials, the opponent's partials were
 * already relayed during dealing, and together they decrypt the committed
 * ciphertext. A lie about which cards were held simply fails to decrypt.
 */
export async function applyShowdownReveal(
  state: MpState,
  seat: number,
  cards: [string, string],
  ownPartials: [string, string],
): Promise<MpState> {
  assert(state.phase === "showdown", `not accepting reveals (phase ${state.phase})`);
  assert(seat === 0 || seat === 1, "unknown seat");
  assert(state.revealedHole[seat] === undefined, "seat already revealed");
  assert(Array.isArray(cards) && cards.length === 2, "expected exactly two hole cards");

  const table = await cardPointTable();
  const positions = HOLE_POSITIONS[seat];
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    const opponentPartial = state.holePartials[position];
    assert(opponentPartial !== undefined, `missing relayed partial for position ${position}`);
    const ciphertext = parseCiphertext(state.maskedDeck![position]);
    const code = dealCommunityCard(ciphertext, ownPartials[i] as PointHex, opponentPartial as PointHex, table.byPointHex);
    assert(code !== null, `reveal for position ${position} does not decrypt to a real card`);
    assert(code === cards[i], `revealed card does not match the committed deck at position ${position}`);
  }

  return { ...state, revealedHole: { ...state.revealedHole, [seat]: cards } };
}

export function allRequiredRevealsIn(state: MpState, contestingSeats: number[]): boolean {
  return contestingSeats.every((seat) => state.revealedHole[seat] !== undefined);
}

/** Betting is settled; ask both parties for the seeds that unlock replay. */
export function beginSettle(state: MpState): MpState {
  assert(state.phase !== "aborted", "hand was aborted");
  return { ...state, phase: "settle" };
}

export function applyMaskerSeedReveal(state: MpState, seat: number, seed: string): MpState {
  assert(state.phase === "settle" || state.phase === "showdown", `not accepting seed reveals (phase ${state.phase})`);
  assert(seat === 0 || seat === 1, "unknown seat");
  assert(HEX_64.test(seed), "masker seed must be 64-char hex");
  const maskerSeeds = state.maskerSeeds.slice();
  maskerSeeds[seat] = seed;
  const bothIn = maskerSeeds.every((entry) => entry !== null);
  return { ...state, maskerSeeds, phase: bothIn ? "complete" : "settle" };
}

/**
 * A hand nobody could finish. Contributions are returned by the caller
 * rather than awarded: with the protocol incomplete there is no honest way
 * to decide a winner, and letting a stalled party take the pot would make
 * stalling a strategy.
 */
export function abort(state: MpState, reason: string): MpState {
  return { ...state, phase: "aborted", abortReason: reason };
}

/**
 * Assembles the hand's real receipt once both masker seeds are revealed.
 *
 * Everything here is re-derived from the two revealed seeds rather than
 * trusted from the relay's own records, which is the point: a verifier
 * replays the masking from scratch and compares. The relay contributes no
 * secret to this bundle, so it has nothing it could bias.
 *
 * Hole deals are only included for seats that actually revealed at showdown.
 * A folded hand stays private, and the receipt still verifies - the verifier
 * only checks the deals that are present.
 */
export async function buildMentalPokerBundle(state: MpState): Promise<ProofBundleV3> {
  assert(state.maskedDeck !== null, "no masked deck to build a receipt from");
  const [seedZero, seedOne] = state.maskerSeeds;
  assert(typeof seedZero === "string" && typeof seedOne === "string", "both masker seeds must be revealed first");

  const playerRound = await deriveMaskingRound(state.handId, "player", seedZero);
  const opponentRound = await deriveMaskingRound(state.handId, "opponent", seedOne);
  const table = await cardPointTable();

  const deals: DealReveal[] = [];
  for (const [seatKey, cards] of Object.entries(state.revealedHole)) {
    const seat = Number(seatKey);
    if (!cards) continue;
    HOLE_POSITIONS[seat].forEach((position, index) => {
      const otherRole: Role = seat === 0 ? "opponent" : "player";
      deals.push({
        position,
        recipients: [seat === 0 ? "player" : "opponent"],
        partials: { [otherRole]: state.holePartials[position] } as DealReveal["partials"],
        cardCode: cards[index],
      });
    });
  }
  state.releasedBoardPositions
    .slice()
    .sort((a, b) => a - b)
    .forEach((position) => {
      const partials = state.boardPartials[position] ?? {};
      const code = dealCommunityCard(
        parseCiphertext(state.maskedDeck![position]),
        partials[0] as PointHex,
        partials[1] as PointHex,
        table.byPointHex,
      );
      if (!code) return;
      deals.push({
        position,
        recipients: ["player", "opponent"],
        partials: { player: partials[0] as PointHex, opponent: partials[1] as PointHex },
        cardCode: code,
      });
    });

  let transcript: TranscriptEntry[] = [];
  transcript = await appendProtocolEntry(transcript, "commit_masking_keys", state.handId);
  transcript = await appendProtocolEntry(transcript, "mask_round_player", state.handId);
  transcript = await appendProtocolEntry(transcript, "mask_round_opponent", state.handId);
  for (const deal of deals) {
    transcript = await appendProtocolEntry(transcript, `deal_position_${deal.position}`, state.handId);
  }
  transcript = await appendProtocolEntry(transcript, "reveal_masking_keys", state.handId);

  return {
    version: "RIVER_POC_V3",
    handId: state.handId,
    commitments: { player: state.commitments[0]!, opponent: state.commitments[1]! },
    reveals: { playerMaskerSeed: seedZero, opponentMaskerSeed: seedOne },
    maskingRounds: { player: playerRound, opponent: opponentRound },
    jointPublicKeyHex: jointPublicKey(playerRound.publicKeyHex, opponentRound.publicKeyHex),
    maskedDeck: state.maskedDeck!,
    deals,
    transcript,
    finalTranscriptHash: transcript.at(-1)?.hash ?? "",
  };
}

/** Which seats the protocol is currently waiting on, for timeout handling. */
export function waitingOn(state: MpState, contestingSeats: number[] = [0, 1]): number[] {
  switch (state.phase) {
    case "commit":
      return [0, 1].filter((seat) => state.commitments[seat] === null);
    case "mask-seat-0":
      return [0];
    case "mask-seat-1":
      return [1];
    case "hole-partials":
      return [...new Set(
        [...HOLE_POSITIONS[0], ...HOLE_POSITIONS[1]]
          .filter((position) => state.holePartials[position] === undefined)
          .map((position) => holePartialProvider(position)),
      )];
    case "board-partials": {
      const pendingSeats = new Set<number>();
      for (const [position, partials] of Object.entries(state.boardPartials)) {
        if (state.releasedBoardPositions.includes(Number(position))) continue;
        for (const seat of [0, 1]) if (partials[seat] === undefined) pendingSeats.add(seat);
      }
      return [...pendingSeats];
    }
    case "showdown":
      return contestingSeats.filter((seat) => state.revealedHole[seat] === undefined);
    case "settle":
      return [0, 1].filter((seat) => state.maskerSeeds[seat] === null);
    default:
      return [];
  }
}
