import test from "node:test";
import assert from "node:assert/strict";

import {
  appendTranscript,
  combinedSeed,
  commitment,
  compareHands,
  shuffleDeck,
  transcriptGenesis,
  verifyBundle,
} from "../app/play/proof.ts";

const blindAndFold = [
  { actor: "player", street: "preflop", action: "post_small_blind", amount: 1 },
  { actor: "opponent", street: "preflop", action: "post_big_blind", amount: 2 },
  { actor: "player", street: "preflop", action: "fold", amount: 0 },
  { actor: "protocol", street: "complete", action: "award_opponent", amount: 3 },
];

async function receipt(handId, entries = blindAndFold) {
  const playerSeed = `player-${handId}`;
  const opponentSeed = `opponent-${handId}`;
  const [playerCommitment, opponentCommitment] = await Promise.all([
    commitment("player", handId, playerSeed),
    commitment("opponent", handId, opponentSeed),
  ]);
  const seed = await combinedSeed(handId, playerSeed, opponentSeed);
  const deck = await shuffleDeck(seed);
  let transcript = [];
  for (const entry of entries) transcript = await appendTranscript(transcript, entry, handId);
  return {
    deck,
    bundle: {
      version: "RIVER_POC_V2",
      handId,
      commitments: { player: playerCommitment, opponent: opponentCommitment },
      reveals: { playerSeed, opponentSeed },
      combinedSeed: seed,
      deck: deck.map((card) => card.code),
      transcript,
      finalTranscriptHash: transcript.at(-1)?.hash ?? (await transcriptGenesis(handId)),
    },
  };
}

function cards(codes) {
  return codes.map((code) => ({
    rank: "23456789TJQKA".indexOf(code[0]) + 2,
    suit: code[1],
    code,
  }));
}

test("the same committed seed produces the same unique deck", async () => {
  const first = await shuffleDeck("river-test-seed");
  const second = await shuffleDeck("river-test-seed");
  assert.deepEqual(first, second);
  assert.equal(first.length, 52);
  assert.equal(new Set(first.map((card) => card.code)).size, 52);
});

test("the proof verifier accepts an intact completed receipt", async () => {
  const { bundle } = await receipt("hand-test-001");
  const result = await verifyBundle(bundle);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.checks).length, 9);
});

test("changing a wager invalidates the transcript chain", async () => {
  const { bundle } = await receipt("hand-test-wager-tamper");
  bundle.transcript[0].amount = 80;
  const result = await verifyBundle(bundle);
  assert.equal(result.valid, false);
  assert.equal(result.checks.transcriptChain, false);
});

test("the showdown evaluator recognizes a royal flush", () => {
  const result = compareHands(
    cards(["As", "Ks"]),
    cards(["9h", "9d"]),
    cards(["Qs", "Js", "Ts", "2c", "3d"]),
  );
  assert.equal(result.result > 0, true);
  assert.equal(result.playerValue.label, "Straight flush");
});

test("commitments bind the role and hand id as well as the secret", async () => {
  const seed = "same-secret";
  const player = await commitment("player", "hand-a", seed);
  const opponent = await commitment("opponent", "hand-a", seed);
  const anotherHand = await commitment("player", "hand-b", seed);
  assert.notEqual(player, opponent);
  assert.notEqual(player, anotherHand);
});

test("reordering one card invalidates an otherwise intact proof", async () => {
  const { bundle } = await receipt("hand-test-deck-tamper");
  [bundle.deck[0], bundle.deck[1]] = [bundle.deck[1], bundle.deck[0]];
  const result = await verifyBundle(bundle);
  assert.equal(result.valid, false);
  assert.equal(result.checks.deterministicDeck, false);
});

test("the evaluator uses kickers when both players pair the board", () => {
  const result = compareHands(
    cards(["As", "Qd"]),
    cards(["Ks", "Jd"]),
    cards(["9s", "9h", "4c", "3d", "2s"]),
  );
  assert.equal(result.result > 0, true);
  assert.equal(result.playerValue.label, "One pair");
});

test("a transcript cannot be spliced from one hand into another", async () => {
  const victim = await receipt("hand-victim-001");
  const attacker = await receipt("hand-attacker-002");
  assert.notEqual(victim.bundle.finalTranscriptHash, attacker.bundle.finalTranscriptHash);
  attacker.bundle.transcript = victim.bundle.transcript;
  attacker.bundle.finalTranscriptHash = victim.bundle.finalTranscriptHash;
  const result = await verifyBundle(attacker.bundle);
  assert.equal(result.valid, false);
  assert.equal(result.checks.transcriptChain, false);
});

test("a cryptographically valid receipt cannot award more than the contributed pot", async () => {
  const entries = blindAndFold.map((entry) =>
    entry.action === "award_opponent" ? { ...entry, amount: 30 } : entry,
  );
  const { bundle } = await receipt("hand-inflated-pot", entries);
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.transcriptChain, true);
  assert.equal(result.checks.payoutAmount, false);
  assert.equal(result.valid, false);
});

test("a cryptographically valid showdown cannot award the wrong player", async () => {
  const probe = await receipt("hand-wrong-showdown");
  const comparison = compareHands(
    [probe.deck[0], probe.deck[2]],
    [probe.deck[1], probe.deck[3]],
    [probe.deck[5], probe.deck[6], probe.deck[7], probe.deck[9], probe.deck[11]],
  );
  const correct = comparison.result > 0 ? "player" : comparison.result < 0 ? "opponent" : "split";
  const wrong = correct === "player" ? "opponent" : "player";
  const entries = [
    { actor: "player", street: "preflop", action: "post_small_blind", amount: 1 },
    { actor: "opponent", street: "preflop", action: "post_big_blind", amount: 2 },
    { actor: "protocol", street: "showdown", action: "reveal_hole_cards", amount: 0 },
    { actor: "protocol", street: "complete", action: `award_${wrong}`, amount: 3 },
  ];
  const { bundle } = await receipt("hand-wrong-showdown", entries);
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.transcriptChain, true);
  assert.equal(result.checks.payoutAmount, true);
  assert.equal(result.checks.outcomeMatchesDeck, false);
  assert.equal(result.valid, false);
});

test("a duplicated card is rejected even when the receipt still has 52 positions", async () => {
  const { bundle } = await receipt("hand-duplicate-card");
  bundle.deck[51] = bundle.deck[0];
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.uniqueDeck, false);
  assert.equal(result.valid, false);
});

test("changing the hand id invalidates commitments, seed, deck, and transcript", async () => {
  const { bundle } = await receipt("hand-original-id");
  bundle.handId = "hand-substituted-id";
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.playerCommitment, false);
  assert.equal(result.checks.opponentCommitment, false);
  assert.equal(result.checks.combinedSeed, false);
  assert.equal(result.checks.transcriptChain, false);
  assert.equal(result.valid, false);
});

test("a receipt with two award events is rejected", async () => {
  const entries = [
    ...blindAndFold,
    { actor: "protocol", street: "complete", action: "award_opponent", amount: 3 },
  ];
  const { bundle } = await receipt("hand-double-award", entries);
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.payoutAmount, false);
  assert.equal(result.checks.outcomeMatchesDeck, false);
  assert.equal(result.valid, false);
});

test("a negative contribution is rejected even when the attacker rehashes the transcript", async () => {
  const entries = [
    { actor: "player", street: "preflop", action: "post_small_blind", amount: -1 },
    { actor: "opponent", street: "preflop", action: "post_big_blind", amount: 2 },
    { actor: "player", street: "preflop", action: "fold", amount: 0 },
    { actor: "protocol", street: "complete", action: "award_opponent", amount: 1 },
  ];
  const { bundle } = await receipt("hand-negative-contribution", entries);
  const result = await verifyBundle(bundle);
  assert.equal(result.checks.transcriptChain, false);
  assert.equal(result.valid, false);
});
