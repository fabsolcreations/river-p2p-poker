import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  appendTranscript,
  commitment,
  freshDeck,
  sha256,
  transcriptGenesis,
  verifyTranscript,
  type TranscriptEntry,
} from "./proof.ts";

/**
 * Two-party mental poker: neither browser needs a trusted dealer to learn
 * only its own hole cards. Each of the 52 cards is a fixed public curve
 * point; both players mask (ElGamal-encrypt under their combined public
 * key) and permute the deck in turn, so no single party can map ciphertexts
 * back to card identities. A card is dealt to a player by having the OTHER
 * player strip only their own masking layer and hand over the partial
 * result - the other player never learns the recipient's card.
 *
 * Soundness (catching a cheating shuffle, or a lie about a partial
 * decryption) follows the same "commit now, reveal after" pattern already
 * used by proof.ts's seed-based shuffle: after the hand, both players
 * reveal their masking keys and permutations, and verifyMentalPokerBundle
 * independently replays the entire masking/dealing history. This trades
 * real-time zero-knowledge shuffle proofs (a much larger cryptographic
 * lift) for post-hand transparency - post-hand, the verifier can decrypt
 * every position including cards that were never dealt/shown, exactly
 * mirroring proof.ts V2's full-deck-reveal tradeoff.
 */

export type Role = "player" | "opponent";
export type PointHex = string;

export type ElGamalCiphertext = { c1: PointHex; c2: PointHex };

export type MaskingRound = {
  secretKeyHex: string;
  publicKeyHex: PointHex;
  permutation: number[];
  randomizersHex: string[];
};

export type DealReveal = {
  position: number;
  recipients: Role[];
  partials: Partial<Record<Role, PointHex>>;
  cardCode: string;
};

export type ProofBundleV3 = {
  version: "RIVER_POC_V3";
  handId: string;
  commitments: { player: string; opponent: string };
  reveals: { playerMaskerSeed: string; opponentMaskerSeed: string };
  maskingRounds: { player: MaskingRound; opponent: MaskingRound };
  jointPublicKeyHex: PointHex;
  maskedDeck: string[];
  deals: DealReveal[];
  transcript: TranscriptEntry[];
  finalTranscriptHash: string;
};

export type MentalPokerVerificationResult = {
  valid: boolean;
  checks: {
    receiptVersion: boolean;
    playerKeyCommitment: boolean;
    opponentKeyCommitment: boolean;
    playerKeyDerivation: boolean;
    opponentKeyDerivation: boolean;
    jointPublicKey: boolean;
    playerPermutation: boolean;
    opponentPermutation: boolean;
    playerRandomizers: boolean;
    opponentRandomizers: boolean;
    maskedDeckReplay: boolean;
    dealsWellFormed: boolean;
    dealPartialsCorrect: boolean;
    dealPlaintextsCorrect: boolean;
    transcriptChain: boolean;
  };
};

const Point = secp256k1.Point;
const CURVE_ORDER = Point.Fn.ORDER;
type ECPoint = typeof Point.BASE;

// SEC1 compressed encoding has no representation for the point at
// infinity; noble's toHex() rejects it. It only ever appears transiently
// as buildInitialDeck()'s pre-round-1 c1 value, which this reserved
// sentinel lets us route through the same hex-based pipeline as every
// other ciphertext without special-casing callers.
const IDENTITY_HEX = "00";

function pointToHex(point: ECPoint): PointHex {
  return point.is0() ? IDENTITY_HEX : point.toHex();
}

function pointFromHex(hex: PointHex): ECPoint {
  return hex === IDENTITY_HEX ? Point.ZERO : Point.fromHex(hex);
}

function scalarToHex(scalar: bigint): string {
  return scalar.toString(16).padStart(64, "0");
}

function hexToScalar(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/** Uniform scalar in [1, n-1] via rejection sampling against a labeled hash stream. */
async function hashToScalar(label: string): Promise<bigint> {
  const range = 1n << 256n;
  const limit = range - (range % CURVE_ORDER);
  let counter = 0;
  for (;;) {
    const hex = await sha256(`RIVER_SCALAR_V1|${label}|${counter}`);
    counter += 1;
    const raw = BigInt(`0x${hex}`);
    if (raw >= limit) continue;
    const scalar = raw % CURVE_ORDER;
    if (scalar === 0n) continue;
    return scalar;
  }
}

/** Uniform integer in [0, maxExclusive) via rejection sampling, used for Fisher-Yates. */
async function hashToIndex(label: string, maxExclusive: number): Promise<number> {
  const range = 1n << 256n;
  const bound = BigInt(maxExclusive);
  const limit = range - (range % bound);
  let counter = 0;
  for (;;) {
    const hex = await sha256(`RIVER_INT_V1|${label}|${counter}`);
    counter += 1;
    const raw = BigInt(`0x${hex}`);
    if (raw >= limit) continue;
    return Number(raw % bound);
  }
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

let cachedCardPointTable: { byCode: Map<string, PointHex>; byPointHex: Map<PointHex, string> } | null = null;

/** Fixed, public deterministic mapping between the 52 card codes and curve points. Memoized. */
export async function cardPointTable(): Promise<{ byCode: Map<string, PointHex>; byPointHex: Map<PointHex, string> }> {
  if (cachedCardPointTable) return cachedCardPointTable;
  const byCode = new Map<string, PointHex>();
  const byPointHex = new Map<PointHex, string>();
  for (const card of freshDeck()) {
    const scalar = await hashToScalar(`RIVER_CARD_V1|${card.code}`);
    const hex = pointToHex(Point.BASE.multiply(scalar));
    byCode.set(card.code, hex);
    byPointHex.set(hex, card.code);
  }
  cachedCardPointTable = { byCode, byPointHex };
  return cachedCardPointTable;
}

export async function deriveMaskingKeyPair(
  handId: string,
  role: Role,
  maskerSeed: string,
): Promise<{ secretKeyHex: string; publicKeyHex: PointHex }> {
  const secretKey = await hashToScalar(`RIVER_MASK_KEY_V1|${handId}|${role}|${maskerSeed}`);
  return { secretKeyHex: scalarToHex(secretKey), publicKeyHex: pointToHex(Point.BASE.multiply(secretKey)) };
}

export async function derivePermutation(
  handId: string,
  role: Role,
  maskerSeed: string,
  size = 52,
): Promise<number[]> {
  const permutation = Array.from({ length: size }, (_, index) => index);
  for (let i = permutation.length - 1; i > 0; i -= 1) {
    const j = await hashToIndex(`RIVER_PERM_V1|${handId}|${role}|${maskerSeed}|${i}`, i + 1);
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  return permutation;
}

export async function deriveRandomizers(
  handId: string,
  role: Role,
  maskerSeed: string,
  count = 52,
): Promise<string[]> {
  const randomizers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const scalar = await hashToScalar(`RIVER_MASK_R_V1|${handId}|${role}|${maskerSeed}|${index}`);
    randomizers.push(scalarToHex(scalar));
  }
  return randomizers;
}

export async function deriveMaskingRound(handId: string, role: Role, maskerSeed: string): Promise<MaskingRound> {
  const [{ secretKeyHex, publicKeyHex }, permutation, randomizersHex] = await Promise.all([
    deriveMaskingKeyPair(handId, role, maskerSeed),
    derivePermutation(handId, role, maskerSeed),
    deriveRandomizers(handId, role, maskerSeed),
  ]);
  return { secretKeyHex, publicKeyHex, permutation, randomizersHex };
}

export function jointPublicKey(playerPublicKeyHex: PointHex, opponentPublicKeyHex: PointHex): PointHex {
  return pointToHex(pointFromHex(playerPublicKeyHex).add(pointFromHex(opponentPublicKeyHex)));
}

/** The 52 cards, unmasked, in freshDeck() order - never stored or transmitted as-is. */
export function buildInitialDeck(byCode: Map<string, PointHex>): ElGamalCiphertext[] {
  return freshDeck().map((card) => ({ c1: IDENTITY_HEX, c2: byCode.get(card.code)! }));
}

/**
 * Re-randomizes every position under the joint public key with a fresh
 * randomizer, then permutes: outputDeck[k] = reRandomized[permutation[k]].
 */
export function applyMasking(
  deck: ElGamalCiphertext[],
  jointPublicKeyHexValue: PointHex,
  randomizersHex: string[],
  permutation: number[],
): ElGamalCiphertext[] {
  if (deck.length !== 52 || randomizersHex.length !== 52 || permutation.length !== 52) {
    throw new Error("applyMasking requires a 52-length deck, randomizers, and permutation");
  }
  const jointKey = pointFromHex(jointPublicKeyHexValue);
  const reRandomized = deck.map((ciphertext, index) => {
    const r = hexToScalar(randomizersHex[index]);
    const c1 = pointFromHex(ciphertext.c1).add(Point.BASE.multiply(r));
    const c2 = pointFromHex(ciphertext.c2).add(jointKey.multiply(r));
    return { c1: pointToHex(c1), c2: pointToHex(c2) };
  });
  return permutation.map((sourceIndex) => reRandomized[sourceIndex]);
}

export async function maskAndShuffleRound(
  handId: string,
  role: Role,
  maskerSeed: string,
  jointPublicKeyHexValue: PointHex,
  inputDeck: ElGamalCiphertext[],
): Promise<{ round: MaskingRound; outputDeck: ElGamalCiphertext[] }> {
  const round = await deriveMaskingRound(handId, role, maskerSeed);
  const outputDeck = applyMasking(inputDeck, jointPublicKeyHexValue, round.randomizersHex, round.permutation);
  return { round, outputDeck };
}

export async function revealPartialDecryption(secretKeyHex: string, ciphertext: ElGamalCiphertext): Promise<PointHex> {
  const c1 = pointFromHex(ciphertext.c1);
  return pointToHex(c1.multiply(hexToScalar(secretKeyHex)));
}

export function identifyCard(plaintextPointHex: PointHex, byPointHex: Map<PointHex, string>): string | null {
  return byPointHex.get(plaintextPointHex) ?? null;
}

function unmask(ciphertext: ElGamalCiphertext, partials: PointHex[]): ECPoint {
  return partials.reduce((point, partialHex) => point.subtract(pointFromHex(partialHex)), pointFromHex(ciphertext.c2));
}

/** Only the recipient can resolve this - it needs the recipient's own secret key AND the other party's partial. */
export function dealPrivateCard(
  ciphertext: ElGamalCiphertext,
  recipientSecretKeyHex: string,
  otherPartialHex: PointHex,
  byPointHex: Map<PointHex, string>,
): string | null {
  const c1 = pointFromHex(ciphertext.c1);
  const selfPartialHex = pointToHex(c1.multiply(hexToScalar(recipientSecretKeyHex)));
  const plaintext = unmask(ciphertext, [selfPartialHex, otherPartialHex]);
  return identifyCard(pointToHex(plaintext), byPointHex);
}

/** Both partials together recover the plaintext; order does not matter (group subtraction commutes). */
export function dealCommunityCard(
  ciphertext: ElGamalCiphertext,
  playerPartialHex: PointHex,
  opponentPartialHex: PointHex,
  byPointHex: Map<PointHex, string>,
): string | null {
  const plaintext = unmask(ciphertext, [playerPartialHex, opponentPartialHex]);
  return identifyCard(pointToHex(plaintext), byPointHex);
}

/** Post-hand verifier recompute: both secret keys are known once revealed, so every position is decryptable. */
export function decryptWithBothKeys(
  ciphertext: ElGamalCiphertext,
  secretKeyAHex: string,
  secretKeyBHex: string,
  byPointHex: Map<PointHex, string>,
): string | null {
  const c1 = pointFromHex(ciphertext.c1);
  const partialA = pointToHex(c1.multiply(hexToScalar(secretKeyAHex)));
  const partialB = pointToHex(c1.multiply(hexToScalar(secretKeyBHex)));
  const plaintext = unmask(ciphertext, [partialA, partialB]);
  return identifyCard(pointToHex(plaintext), byPointHex);
}

export function serializeCiphertext(ciphertext: ElGamalCiphertext): string {
  return `${ciphertext.c1}:${ciphertext.c2}`;
}

export function parseCiphertext(entry: string): ElGamalCiphertext {
  const [c1, c2] = entry.split(":");
  if (!c1 || !c2) throw new Error("malformed masked-deck entry");
  return { c1, c2 };
}

/** Convenience wrapper matching proof.ts's appendTranscript signature for protocol-only entries. */
export async function appendProtocolEntry(
  transcript: TranscriptEntry[],
  action: string,
  handId: string,
): Promise<TranscriptEntry[]> {
  return appendTranscript(transcript, { actor: "protocol", street: "deal", action, amount: 0 }, handId);
}

export async function verifyMentalPokerBundle(bundle: ProofBundleV3): Promise<MentalPokerVerificationResult> {
  const table = await cardPointTable();

  const expectedPlayerCommitment = await commitment("player", bundle.handId, bundle.reveals.playerMaskerSeed);
  const expectedOpponentCommitment = await commitment("opponent", bundle.handId, bundle.reveals.opponentMaskerSeed);

  const expectedPlayerRound = await deriveMaskingRound(bundle.handId, "player", bundle.reveals.playerMaskerSeed);
  const expectedOpponentRound = await deriveMaskingRound(bundle.handId, "opponent", bundle.reveals.opponentMaskerSeed);
  const expectedJointPublicKey = jointPublicKey(expectedPlayerRound.publicKeyHex, expectedOpponentRound.publicKeyHex);

  let replayedDeck = buildInitialDeck(table.byCode);
  replayedDeck = applyMasking(
    replayedDeck,
    expectedJointPublicKey,
    expectedPlayerRound.randomizersHex,
    expectedPlayerRound.permutation,
  );
  replayedDeck = applyMasking(
    replayedDeck,
    expectedJointPublicKey,
    expectedOpponentRound.randomizersHex,
    expectedOpponentRound.permutation,
  );
  const replayedHex = replayedDeck.map(serializeCiphertext);
  const maskedDeckReplay =
    replayedHex.length === bundle.maskedDeck.length && replayedHex.every((entry, index) => entry === bundle.maskedDeck[index]);

  const seenPositions = new Set<number>();
  const seenCodes = new Set<string>();
  let dealsWellFormed = bundle.deals.length > 0;
  for (const deal of bundle.deals) {
    const inRange = Number.isInteger(deal.position) && deal.position >= 0 && deal.position < bundle.maskedDeck.length;
    if (!inRange || seenPositions.has(deal.position)) dealsWellFormed = false;
    else seenPositions.add(deal.position);
    if (seenCodes.has(deal.cardCode)) dealsWellFormed = false;
    else seenCodes.add(deal.cardCode);
    if (!table.byCode.has(deal.cardCode)) dealsWellFormed = false;
    if (deal.recipients.length === 0) dealsWellFormed = false;
  }

  let dealPartialsCorrect = true;
  let dealPlaintextsCorrect = true;
  for (const deal of bundle.deals) {
    if (deal.position < 0 || deal.position >= bundle.maskedDeck.length) continue;
    const ciphertext = parseCiphertext(bundle.maskedDeck[deal.position]);
    if (deal.recipients.includes("player")) {
      const expectedPartial = await revealPartialDecryption(expectedOpponentRound.secretKeyHex, ciphertext);
      if (deal.partials.opponent !== expectedPartial) dealPartialsCorrect = false;
    }
    if (deal.recipients.includes("opponent")) {
      const expectedPartial = await revealPartialDecryption(expectedPlayerRound.secretKeyHex, ciphertext);
      if (deal.partials.player !== expectedPartial) dealPartialsCorrect = false;
    }
    const code = decryptWithBothKeys(
      ciphertext,
      expectedPlayerRound.secretKeyHex,
      expectedOpponentRound.secretKeyHex,
      table.byPointHex,
    );
    if (code !== deal.cardCode) dealPlaintextsCorrect = false;
  }

  const transcriptChain =
    (await verifyTranscript(bundle.transcript, bundle.handId)) &&
    (bundle.transcript.at(-1)?.hash ?? (await transcriptGenesis(bundle.handId))) === bundle.finalTranscriptHash;

  const checks = {
    receiptVersion: bundle.version === "RIVER_POC_V3",
    playerKeyCommitment: expectedPlayerCommitment === bundle.commitments.player,
    opponentKeyCommitment: expectedOpponentCommitment === bundle.commitments.opponent,
    playerKeyDerivation:
      expectedPlayerRound.secretKeyHex === bundle.maskingRounds.player.secretKeyHex &&
      expectedPlayerRound.publicKeyHex === bundle.maskingRounds.player.publicKeyHex,
    opponentKeyDerivation:
      expectedOpponentRound.secretKeyHex === bundle.maskingRounds.opponent.secretKeyHex &&
      expectedOpponentRound.publicKeyHex === bundle.maskingRounds.opponent.publicKeyHex,
    jointPublicKey: expectedJointPublicKey === bundle.jointPublicKeyHex,
    playerPermutation: arraysEqual(expectedPlayerRound.permutation, bundle.maskingRounds.player.permutation),
    opponentPermutation: arraysEqual(expectedOpponentRound.permutation, bundle.maskingRounds.opponent.permutation),
    playerRandomizers: arraysEqual(expectedPlayerRound.randomizersHex, bundle.maskingRounds.player.randomizersHex),
    opponentRandomizers: arraysEqual(expectedOpponentRound.randomizersHex, bundle.maskingRounds.opponent.randomizersHex),
    maskedDeckReplay,
    dealsWellFormed,
    dealPartialsCorrect,
    dealPlaintextsCorrect,
    transcriptChain,
  };

  return { valid: Object.values(checks).every(Boolean), checks };
}
