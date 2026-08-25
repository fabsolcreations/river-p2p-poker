import test from "node:test";
import assert from "node:assert/strict";

import { buildReplay } from "../app/receipts/hand-replay.ts";

const RANKS = "23456789TJQKA";
const SUITS = "shdc";
function deckOf52() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

function entry(sequence, street, actor, action, amount) {
  return { sequence, street, actor, action, amount, previousHash: `h${sequence - 1}`, hash: `h${sequence}` };
}

function bundle(overrides) {
  return {
    version: "RIVER_TABLE_V1",
    handId: "test-hand",
    seatCount: 2,
    buttonSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    inHand: [true, true],
    commitments: [null, null],
    reveals: [null, null],
    entropySource: ["client", "client"],
    combinedSeed: "seed",
    deck: deckOf52(),
    holeCardDeckIndices: [[0, 1], [2, 3]],
    boardDeckIndices: [10, 11, 12, 13, 14],
    transcript: [],
    finalTranscriptHash: "",
    sidePots: [],
    ...overrides,
  };
}

test("buildReplay steps pot/contributed/folded forward correctly through a preflop fold", () => {
  const b = bundle({
    transcript: [
      entry(0, "preflop", "protocol", "commit_seat_0", 0),
      entry(1, "preflop", "protocol", "commit_seat_1", 0),
      entry(2, "preflop", "seat_0", "post_small_blind", 1),
      entry(3, "preflop", "seat_1", "post_big_blind", 2),
      entry(4, "preflop", "seat_0", "fold", 0),
      entry(5, "preflop", "protocol", "award_pot", 3),
    ],
  });

  const replay = buildReplay(b);
  assert.equal(replay.seatCount, 2);
  assert.equal(replay.steps.length, 6);

  // Protocol-only steps don't move contribution/pot.
  assert.deepEqual(replay.steps[0].contributed, [0, 0]);
  assert.equal(replay.steps[0].pot, 0);

  const sbStep = replay.steps[2];
  assert.deepEqual(sbStep.contributed, [1, 0]);
  assert.equal(sbStep.pot, 1);

  const bbStep = replay.steps[3];
  assert.deepEqual(bbStep.contributed, [1, 2]);
  assert.equal(bbStep.pot, 3);

  const foldStep = replay.steps[4];
  assert.deepEqual(foldStep.folded, [true, false]);
  // Folding doesn't change contribution or pot.
  assert.deepEqual(foldStep.contributed, [1, 2]);
  assert.equal(foldStep.pot, 3);

  // award_pot is a "protocol" actor, not seat_N - never mutates contributed/folded.
  const awardStep = replay.steps[5];
  assert.deepEqual(awardStep.contributed, [1, 2]);
  assert.equal(awardStep.pot, 3);
});

test("buildReplay reveals the board progressively as street advances", () => {
  const b = bundle({
    transcript: [
      entry(0, "preflop", "seat_0", "call", 2),
      entry(1, "flop", "seat_0", "check", 0),
      entry(2, "turn", "seat_0", "check", 0),
      entry(3, "river", "seat_0", "check", 0),
    ],
  });

  const replay = buildReplay(b);
  const boardCodes = b.boardDeckIndices.map((i) => b.deck[i]);

  assert.deepEqual(replay.steps[0].board, []);
  assert.deepEqual(replay.steps[1].board, boardCodes.slice(0, 3));
  assert.deepEqual(replay.steps[2].board, boardCodes.slice(0, 4));
  assert.deepEqual(replay.steps[3].board, boardCodes.slice(0, 5));
});

test("buildReplay derives hole cards from deck + holeCardDeckIndices, null for undealt seats", () => {
  const b = bundle({ holeCardDeckIndices: [[0, 1], null], transcript: [] });
  const replay = buildReplay(b);
  assert.deepEqual(replay.holeCards[0], [b.deck[0], b.deck[1]]);
  assert.equal(replay.holeCards[1], null);
});
