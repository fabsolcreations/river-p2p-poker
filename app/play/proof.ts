export type Suit = "s" | "h" | "d" | "c";

export type Card = {
  rank: number;
  suit: Suit;
  code: string;
};

export type TranscriptEntry = {
  sequence: number;
  street: string;
  // Widened from "player" | "opponent" | "protocol" to support the
  // multi-seat table engine's seat_${n} actors (worker/table-engine.ts).
  // Pure type change, zero runtime effect: appendTranscript/verifyTranscript
  // only ever hash this value opaquely, never branch on it. ProofBundle/
  // verifyBundle/expectedAwardWinner below are untouched and keep using the
  // original 2-party string literals.
  actor: string;
  action: string;
  amount: number;
  previousHash: string;
  hash: string;
};

export type ProofBundle = {
  version: "RIVER_POC_V2";
  handId: string;
  commitments: {
    player: string;
    opponent: string;
  };
  reveals: {
    playerSeed: string;
    opponentSeed: string;
  };
  combinedSeed: string;
  deck: string[];
  transcript: TranscriptEntry[];
  finalTranscriptHash: string;
};

export type VerificationResult = {
  valid: boolean;
  checks: {
    receiptVersion: boolean;
    playerCommitment: boolean;
    opponentCommitment: boolean;
    combinedSeed: boolean;
    deterministicDeck: boolean;
    uniqueDeck: boolean;
    transcriptChain: boolean;
    payoutAmount: boolean;
    outcomeMatchesDeck: boolean;
  };
};

export type HandValue = {
  score: number[];
  label: string;
};

const RANK_CODES = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS: Suit[] = ["s", "h", "d", "c"];
const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function commitment(role: "player" | "opponent", handId: string, seed: string) {
  return sha256(`RIVER_COMMIT_V1|${role}|${handId}|${seed}`);
}

export async function combinedSeed(handId: string, playerSeed: string, opponentSeed: string) {
  return sha256(`RIVER_DECK_V1|${handId}|${playerSeed}|${opponentSeed}`);
}

export function freshDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank += 1) {
      cards.push({ rank, suit, code: `${RANK_CODES[rank - 2]}${suit}` });
    }
  }
  return cards;
}

class HashStream {
  private pool: number[] = [];
  private counter = 0;
  private seed: string;

  constructor(seed: string) {
    this.seed = seed;
  }

  private async refill() {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`RIVER_STREAM_V1|${this.seed}|${this.counter}`),
    );
    this.counter += 1;
    this.pool.push(...new Uint8Array(digest));
  }

  private async uint32(): Promise<number> {
    while (this.pool.length < 4) await this.refill();
    const a = this.pool.shift() ?? 0;
    const b = this.pool.shift() ?? 0;
    const c = this.pool.shift() ?? 0;
    const d = this.pool.shift() ?? 0;
    return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }

  async integer(maxExclusive: number): Promise<number> {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer");
    }
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / maxExclusive) * maxExclusive;
    let value = await this.uint32();
    while (value >= limit) value = await this.uint32();
    return value % maxExclusive;
  }
}

export async function shuffleDeck(seed: string): Promise<Card[]> {
  const deck = freshDeck();
  const stream = new HashStream(seed);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = await stream.integer(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

export async function botDecision(seed: string, street: string, threshold = 58): Promise<"call" | "fold"> {
  const hash = await sha256(`RIVER_BOT_V1|${seed}|${street}`);
  const roll = Number.parseInt(hash.slice(0, 8), 16) % 100;
  return roll < threshold ? "call" : "fold";
}

export async function transcriptGenesis(handId: string): Promise<string> {
  return sha256(`RIVER_GENESIS_V2|${handId}`);
}

export async function appendTranscript(
  transcript: TranscriptEntry[],
  entry: Omit<TranscriptEntry, "sequence" | "previousHash" | "hash">,
  handId: string,
): Promise<TranscriptEntry[]> {
  const sequence = transcript.length;
  const previousHash = transcript.at(-1)?.hash ?? (await transcriptGenesis(handId));
  const payload = [
    "RIVER_ACTION_V2",
    handId,
    previousHash,
    sequence,
    entry.street,
    entry.actor,
    entry.action,
    entry.amount,
  ].join("|");
  const hash = await sha256(payload);
  return [...transcript, { ...entry, sequence, previousHash, hash }];
}

export async function verifyTranscript(
  transcript: TranscriptEntry[],
  handId: string,
): Promise<boolean> {
  let previousHash = await transcriptGenesis(handId);
  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (!Number.isFinite(entry.amount) || entry.amount < 0) return false;
    if (entry.sequence !== index || entry.previousHash !== previousHash) return false;
    const expected = await sha256(
      [
        "RIVER_ACTION_V2",
        handId,
        previousHash,
        index,
        entry.street,
        entry.actor,
        entry.action,
        entry.amount,
      ].join("|"),
    );
    if (expected !== entry.hash) return false;
    previousHash = entry.hash;
  }
  return true;
}

function expectedAwardWinner(
  transcript: TranscriptEntry[],
  deck: Card[],
): "player" | "opponent" | "split" | null {
  const awardIndex = transcript.findIndex((entry) =>
    entry.actor === "protocol" &&
    entry.street === "complete" &&
    /^award_(player|opponent|split)$/.test(entry.action),
  );
  if (awardIndex < 0) return null;

  const priorEntries = transcript.slice(0, awardIndex);
  const lastFold = priorEntries.findLast((entry) => entry.action === "fold");
  if (lastFold?.actor === "player") return "opponent";
  if (lastFold?.actor === "opponent") return "player";

  const revealed = priorEntries.some((entry) => entry.action === "reveal_hole_cards");
  if (!revealed) return null;

  const result = compareHands(
    [deck[0], deck[2]],
    [deck[1], deck[3]],
    [deck[5], deck[6], deck[7], deck[9], deck[11]],
  ).result;
  return result > 0 ? "player" : result < 0 ? "opponent" : "split";
}

export async function verifyBundle(bundle: ProofBundle): Promise<VerificationResult> {
  const expectedPlayerCommitment = await commitment("player", bundle.handId, bundle.reveals.playerSeed);
  const expectedOpponentCommitment = await commitment("opponent", bundle.handId, bundle.reveals.opponentSeed);
  const expectedCombinedSeed = await combinedSeed(
    bundle.handId,
    bundle.reveals.playerSeed,
    bundle.reveals.opponentSeed,
  );
  const expectedDeck = await shuffleDeck(expectedCombinedSeed);
  const deckCodes = expectedDeck.map((card) => card.code);
  const awardEntries = bundle.transcript.filter((entry) =>
    entry.actor === "protocol" &&
    entry.street === "complete" &&
    /^award_(player|opponent|split)$/.test(entry.action),
  );
  const award = awardEntries[0];
  const contributedPot = bundle.transcript.reduce(
    (total, entry) => total + (entry.action.startsWith("award_") ? 0 : entry.amount),
    0,
  );
  const expectedWinner = expectedAwardWinner(bundle.transcript, expectedDeck);
  const awardedWinner = award?.action.replace("award_", "") ?? null;
  const checks = {
    receiptVersion: bundle.version === "RIVER_POC_V2",
    playerCommitment: expectedPlayerCommitment === bundle.commitments.player,
    opponentCommitment: expectedOpponentCommitment === bundle.commitments.opponent,
    combinedSeed: expectedCombinedSeed === bundle.combinedSeed,
    deterministicDeck: deckCodes.join("|") === bundle.deck.join("|"),
    uniqueDeck: new Set(bundle.deck).size === 52 && bundle.deck.length === 52,
    transcriptChain:
      (await verifyTranscript(bundle.transcript, bundle.handId)) &&
      (bundle.transcript.at(-1)?.hash ?? (await transcriptGenesis(bundle.handId))) ===
        bundle.finalTranscriptHash,
    payoutAmount:
      awardEntries.length === 1 &&
      bundle.transcript.at(-1) === award &&
      Number.isFinite(contributedPot) &&
      award.amount === contributedPot,
    outcomeMatchesDeck:
      awardEntries.length === 1 && expectedWinner !== null && awardedWinner === expectedWinner,
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}

function straightHigh(ranks: number[]): number {
  const unique = Array.from(new Set(ranks)).sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) return unique[index];
  }
  return 0;
}

function evaluateFive(cards: Card[]): HandValue {
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(ranks);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = Array.from(counts.entries()).sort(
    (a, b) => b[1] - a[1] || b[0] - a[0],
  );

  if (flush && straight) return { score: [8, straight], label: "Straight flush" };
  if (groups[0][1] === 4) {
    return { score: [7, groups[0][0], groups[1][0]], label: "Four of a kind" };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return { score: [6, groups[0][0], groups[1][0]], label: "Full house" };
  }
  if (flush) return { score: [5, ...ranks], label: "Flush" };
  if (straight) return { score: [4, straight], label: "Straight" };
  if (groups[0][1] === 3) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]);
    return { score: [3, groups[0][0], ...kickers], label: "Three of a kind" };
  }
  const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]);
  if (pairs.length >= 2) {
    const kicker = groups.find((group) => group[1] === 1)?.[0] ?? 0;
    return { score: [2, pairs[0], pairs[1], kicker], label: "Two pair" };
  }
  if (pairs.length === 1) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]);
    return { score: [1, pairs[0], ...kickers], label: "One pair" };
  }
  return { score: [0, ...ranks], label: "High card" };
}

function compareScores(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function evaluateSeven(cards: Card[]): HandValue {
  if (cards.length !== 7) throw new Error("evaluateSeven requires exactly seven cards");
  let best: HandValue | null = null;
  for (let a = 0; a < 3; a += 1) {
    for (let b = a + 1; b < 4; b += 1) {
      for (let c = b + 1; c < 5; c += 1) {
        for (let d = c + 1; d < 6; d += 1) {
          for (let e = d + 1; e < 7; e += 1) {
            const value = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScores(value.score, best.score) > 0) best = value;
          }
        }
      }
    }
  }
  if (!best) throw new Error("Unable to evaluate hand");
  return best;
}

export function compareHands(player: Card[], opponent: Card[], board: Card[]) {
  const playerValue = evaluateSeven([...player, ...board]);
  const opponentValue = evaluateSeven([...opponent, ...board]);
  return {
    playerValue,
    opponentValue,
    result: compareScores(playerValue.score, opponentValue.score),
  };
}

export function cardLabel(card: Card) {
  const rank = RANK_CODES[card.rank - 2];
  const suit = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" }[card.suit];
  return `${rank} of ${suit}`;
}
