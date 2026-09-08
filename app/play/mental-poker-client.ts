import {
  applyMasking,
  buildInitialDeck,
  cardPointTable,
  dealPrivateCard,
  deriveMaskingRound,
  jointPublicKey,
  parseCiphertext,
  revealPartialDecryption,
  serializeCiphertext,
  type MaskingRound,
  type PointHex,
} from "./mental-poker.ts";
import { commitment, randomHex } from "./proof.ts";
import { BOARD_POSITIONS, HOLE_POSITIONS } from "../../worker/mental-poker-protocol.ts";

/**
 * Browser half of a trustless hand. This is where the secrets live: the
 * masking key derived here never leaves the tab, which is the whole reason
 * the server cannot read this seat's cards.
 *
 * The driver is deliberately reactive - it holds no timers and drives no
 * loop of its own. It responds to `mp-progress` from the relay, does the one
 * piece of curve work that phase requires, and hands back the messages to
 * send. That keeps the ordering rules in exactly one place (the server's
 * protocol machine) instead of duplicated in a client that could drift.
 */

export type MpOutbound =
  | { type: "mp-commit"; commitment: string; publicKey: string }
  | { type: "mp-mask"; deck: string[] }
  | { type: "mp-hole-partial"; position: number; partial: string }
  | { type: "mp-board-partial"; position: number; partial: string }
  | { type: "mp-showdown-reveal"; cards: [string, string]; partials: [string, string] }
  | { type: "mp-seed-reveal"; seed: string };

export type MpProgress = {
  phase: string;
  waitingOn: number[];
  handId: string;
  deckToMask: string[] | null;
  maskedDeck: string[] | null;
  openBoardPositions: number[];
  board: string[];
  publicKeys: (string | null)[];
};

export type MpSession = {
  handId: string;
  seat: number;
  maskerSeed: string;
  round: MaskingRound;
  /** Opponent partials for our own hole positions, as they arrive. */
  receivedHolePartials: Record<number, string>;
  /** Our resolved hole cards, once both halves are available. */
  holeCards: string[];
  /**
   * The deck this hand is committed to, pinned the first time a complete one
   * is seen. Every later partial decryption is checked against it, because
   * `maskedDeck` arrives from the relay on every update and a dishonest relay
   * could otherwise substitute chosen ciphertexts and use this browser as a
   * decryption oracle for its own key.
   */
  pinnedDeck: string | null;
  sentFor: Set<string>;
};

/** Phases in which the masked deck is final and may be pinned. */
const DECK_SETTLED_PHASES = new Set(["hole-partials", "betting", "board-partials", "showdown", "settle", "complete"]);

/**
 * Everything in an MpProgress comes from the relay, which in this design is
 * explicitly NOT trusted with cards. Before this browser will apply its secret
 * key to any ciphertext, the deck that ciphertext came from must be the same
 * deck this hand was dealt from - pinned on first sight and never allowed to
 * change. Without it a relay can hand over any ciphertext it likes (including
 * the opponent's hole card, or one it crafted) and have the browser decrypt a
 * layer of it.
 */
function deckIsTrusted(session: MpSession, progress: MpProgress): boolean {
  if (!progress.maskedDeck || progress.maskedDeck.length !== 52) return false;
  const seen = progress.maskedDeck.join("|");
  if (session.pinnedDeck === null) {
    if (!DECK_SETTLED_PHASES.has(progress.phase)) return false;
    session.pinnedDeck = seen;
    return true;
  }
  return session.pinnedDeck === seen;
}

// The crypto layer names the two parties rather than numbering them; seat 0
// is "player" and seat 1 "opponent" purely as a stable mapping.
const ROLE_FOR_SEAT: readonly ["player", "opponent"] = ["player", "opponent"];
function roleForSeat(seat: number): "player" | "opponent" {
  return seat === 0 ? ROLE_FOR_SEAT[0] : ROLE_FOR_SEAT[1];
}

/**
 * `maskerSeed` is normally minted fresh. Pass one to REBUILD a session after a
 * reload: deriveMaskingRound is deterministic in (handId, role, seed), so the
 * same three inputs reproduce the identical key, permutation and randomizers.
 * That is what makes a refresh mid-hand survivable - without it the key is
 * gone and the hand can only abort.
 *
 * `sentFor` deliberately starts empty on a rebuild. The relay is the authority
 * on what is still outstanding: it names the waiting seats in every progress
 * update, and rejects a duplicate submission with an error to that seat alone
 * rather than failing the hand. So re-sending is safe, and re-deriving what we
 * already sent is cheaper than persisting it.
 */
export async function createMpSession(handId: string, seat: number, maskerSeed = randomHex()): Promise<MpSession> {
  const round = await deriveMaskingRound(handId, roleForSeat(seat), maskerSeed);
  return { handId, seat, maskerSeed, round, receivedHolePartials: {}, holeCards: [], pinnedDeck: null, sentFor: new Set() };
}

export async function initialCommitment(session: MpSession): Promise<MpOutbound> {
  return {
    type: "mp-commit",
    commitment: await commitment(roleForSeat(session.seat), session.handId, session.maskerSeed),
    publicKey: session.round.publicKeyHex,
  };
}

/**
 * Works out what this seat owes the protocol right now. Returns an empty
 * array when it's the opponent's move - the relay sends another progress
 * update when that changes, so there's no polling here.
 */
export async function stepsFor(session: MpSession, progress: MpProgress): Promise<MpOutbound[]> {
  const out: MpOutbound[] = [];
  const mine = progress.waitingOn.includes(session.seat);

  if (progress.phase === "mask-seat-0" || progress.phase === "mask-seat-1") {
    const [keyZero, keyOne] = progress.publicKeys;
    if (!mine || !keyZero || !keyOne) return out;
    const key = `mask:${progress.phase}`;
    if (session.sentFor.has(key)) return out;
    // Always (seat 0, seat 1) so both browsers derive an identical joint key.
    const joint = jointPublicKey(keyZero as PointHex, keyOne as PointHex);
    const table = await cardPointTable();
    // Seat 0 masks a fresh deck; seat 1 masks whatever seat 0 produced.
    const input = progress.deckToMask ? progress.deckToMask.map(parseCiphertext) : buildInitialDeck(table.byCode);
    const masked = applyMasking(input, joint, session.round.randomizersHex, session.round.permutation);
    session.sentFor.add(key);
    out.push({ type: "mp-mask", deck: masked.map(serializeCiphertext) });
    return out;
  }

  if (progress.phase === "hole-partials" && progress.maskedDeck) {
    if (!deckIsTrusted(session, progress)) return out;
    // Strip our layer off the OPPONENT's hole cards - never our own.
    const opponentSeat = session.seat === 0 ? 1 : 0;
    for (const position of HOLE_POSITIONS[opponentSeat]) {
      const key = `hole:${position}`;
      if (session.sentFor.has(key)) continue;
      const partial = await revealPartialDecryption(session.round.secretKeyHex, parseCiphertext(progress.maskedDeck[position]));
      session.sentFor.add(key);
      out.push({ type: "mp-hole-partial", position, partial });
    }
    return out;
  }

  if (progress.phase === "board-partials" && progress.maskedDeck) {
    if (!deckIsTrusted(session, progress)) return out;
    for (const position of progress.openBoardPositions) {
      // openBoardPositions is the relay's word for which cards are being
      // turned up. Taken at face value it is a request to decrypt ANY deck
      // position - naming the opponent's hole positions here made this
      // browser hand over a share of its own cards, which combined with the
      // share the relay already held from the hole-partials phase reveals the
      // card with no key at all. Only real board positions are ever unsealed.
      if (!BOARD_POSITIONS.includes(position)) continue;
      const key = `board:${position}`;
      if (session.sentFor.has(key)) continue;
      const partial = await revealPartialDecryption(session.round.secretKeyHex, parseCiphertext(progress.maskedDeck[position]));
      session.sentFor.add(key);
      out.push({ type: "mp-board-partial", position, partial });
    }
    return out;
  }

  if (progress.phase === "showdown" && mine && progress.maskedDeck) {
    if (!deckIsTrusted(session, progress)) return out;
    const key = "showdown";
    if (session.sentFor.has(key)) return out;
    const positions = HOLE_POSITIONS[session.seat];
    const partials: string[] = [];
    for (const position of positions) {
      partials.push(await revealPartialDecryption(session.round.secretKeyHex, parseCiphertext(progress.maskedDeck[position])));
    }
    if (session.holeCards.length !== 2) return out;
    session.sentFor.add(key);
    out.push({
      type: "mp-showdown-reveal",
      cards: [session.holeCards[0], session.holeCards[1]],
      partials: [partials[0], partials[1]],
    });
    return out;
  }

  if (progress.phase === "settle" && mine) {
    const key = "settle";
    if (session.sentFor.has(key)) return out;
    session.sentFor.add(key);
    out.push({ type: "mp-seed-reveal", seed: session.maskerSeed });
  }

  return out;
}

/**
 * Resolves one of our own hole cards, once the opponent's partial for it has
 * arrived. Only this browser can do this - it needs our secret key, which is
 * why the relay relaying the partial tells it nothing.
 */
export async function receiveHolePartial(
  session: MpSession,
  position: number,
  partial: string,
  maskedDeck: string[] | null,
): Promise<string | null> {
  if (!maskedDeck) return null;
  if (!HOLE_POSITIONS[session.seat].includes(position)) return null;
  // Same reasoning as deckIsTrusted: this applies our secret key to a
  // ciphertext the relay chose, so it must come from the pinned deck.
  if (session.pinnedDeck !== null && session.pinnedDeck !== maskedDeck.join("|")) return null;
  session.receivedHolePartials[position] = partial;
  const table = await cardPointTable();
  const code = dealPrivateCard(
    parseCiphertext(maskedDeck[position]),
    session.round.secretKeyHex,
    partial as PointHex,
    table.byPointHex,
  );
  if (code) {
    // Keep them in deck-position order so the pair is stable across renders.
    const ordered = HOLE_POSITIONS[session.seat];
    const bySlot: string[] = session.holeCards.slice();
    bySlot[ordered.indexOf(position)] = code;
    session.holeCards = bySlot.filter(Boolean);
  }
  return code;
}

export { BOARD_POSITIONS, HOLE_POSITIONS };
