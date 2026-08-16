import test from "node:test";
import assert from "node:assert/strict";

import { randomHex } from "../app/play/proof.ts";
import {
  IllegalActionError,
  applyAction,
  betBounds,
  buildProofBundle,
  computeSidePots,
  legalActions,
  startHand,
  verifyTableBundle,
} from "../worker/table-engine.ts";

const HU_STACKS = [
  { seat: 0, stack: 100 },
  { seat: 1, stack: 100 },
];

function cards(codes) {
  return codes.map((code) => ({ rank: "23456789TJQKA".indexOf(code[0]) + 2, suit: code[1], code }));
}

/** Drives a hand forward by always checking/calling - never folding or betting. */
async function playPassively(state) {
  while (state.street !== "complete") {
    const seat = state.toAct;
    const actions = legalActions(state, seat);
    const action = actions.includes("check") ? "check" : "call";
    state = await applyAction(state, seat, action);
  }
  return state;
}

// ---- heads-up regression (seatCount = 2) ---------------------------------

test("a preflop fold line produces a verifyTableBundle-valid bundle and pays the right seat", async () => {
  let state = await startHand("t-fold", 2, HU_STACKS, null);
  assert.equal(state.toAct, 0); // small blind / button acts first preflop
  state = await applyAction(state, 0, "fold");

  assert.equal(state.street, "complete");
  assert.equal(state.sidePots.length, 1);
  assert.deepEqual(state.sidePots[0].winners, [1]);
  assert.equal(state.stacks[0], 99);
  assert.equal(state.stacks[1], 101);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("a full check-through showdown line reaches showdown with the corrected heads-up postflop order", async () => {
  let state = await startHand("t-showdown", 2, HU_STACKS, null);

  state = await applyAction(state, 0, "call"); // SB limps
  assert.equal(state.toAct, 1);
  assert.deepEqual(legalActions(state, 1), ["check", "raise"]);
  state = await applyAction(state, 1, "check"); // BB option closes preflop
  assert.equal(state.street, "flop");

  for (const street of ["flop", "turn", "river"]) {
    assert.equal(state.street, street);
    // Postflop, action starts left of the button - in heads-up that's the
    // big blind, NOT seat 0 - this is a real correctness fix over the old
    // 2-seat-only engine, which always asked seat 0 first every street.
    assert.equal(state.toAct, 1);
    state = await applyAction(state, 1, "check");
    assert.equal(state.toAct, 0);
    state = await applyAction(state, 0, "check");
  }

  assert.equal(state.street, "complete");
  assert.equal(state.stacks[0] + state.stacks[1], 200);
  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("a preflop raise that gets folded to produces a valid bundle", async () => {
  let state = await startHand("t-raise-fold", 2, HU_STACKS, null);
  state = await applyAction(state, 0, "raise", 5);
  assert.equal(state.contributed[0], 6);
  assert.equal(state.toAct, 1);
  assert.deepEqual(legalActions(state, 1), ["fold", "call", "raise"]);

  state = await applyAction(state, 1, "fold");
  assert.equal(state.stacks[0], 102);
  assert.equal(state.stacks[1], 98);
  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("a postflop bet-then-fold line closes correctly with the corrected order", async () => {
  let state = await startHand("t-postflop-fold", 2, HU_STACKS, null);
  state = await applyAction(state, 0, "call");
  state = await applyAction(state, 1, "check");
  assert.equal(state.street, "flop");
  assert.equal(state.toAct, 1);

  state = await applyAction(state, 1, "bet", 4);
  assert.deepEqual(legalActions(state, 0), ["fold", "call", "raise"]);
  state = await applyAction(state, 0, "fold");
  assert.deepEqual(state.sidePots[0].winners, [1]);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("acting out of turn is rejected", async () => {
  const state = await startHand("t-illegal-seat", 2, HU_STACKS, null);
  await assert.rejects(() => applyAction(state, 1, "fold"), IllegalActionError);
});

test("bet/raise amounts outside legal bounds are rejected", async () => {
  let state = await startHand("t-illegal-amount", 2, HU_STACKS, null);
  await assert.rejects(() => applyAction(state, 0, "check"), IllegalActionError);

  const bounds = betBounds(state, 0);
  assert.deepEqual(bounds, { action: "raise", min: 3, max: 99 });
  await assert.rejects(() => applyAction(state, 0, "raise"), IllegalActionError);
  await assert.rejects(() => applyAction(state, 0, "raise", 2), IllegalActionError);
  await assert.rejects(() => applyAction(state, 0, "raise", 100), IllegalActionError);

  state = await applyAction(state, 0, "raise", 3);
  assert.equal(state.contributed[0], 4);
});

test("a re-raise war reaches showdown with correct pot math and a valid bundle", async () => {
  let state = await startHand("t-reraise-war", 2, HU_STACKS, null);

  state = await applyAction(state, 0, "raise", 5);
  assert.deepEqual(state.contributed, [6, 2]);
  assert.equal(state.minRaiseIncrement, 4);

  state = await applyAction(state, 1, "raise", 10);
  assert.deepEqual(state.contributed, [6, 12]);
  assert.equal(state.minRaiseIncrement, 6);

  state = await applyAction(state, 0, "raise", 15);
  assert.deepEqual(state.contributed, [21, 12]);
  assert.equal(state.minRaiseIncrement, 9);

  state = await applyAction(state, 1, "call");
  assert.deepEqual(state.contributed, [21, 21]);
  assert.equal(state.street, "flop");
  assert.equal(state.stacks[0] + state.stacks[1] + state.contributed[0] + state.contributed[1], 200);

  for (const street of ["flop", "turn", "river"]) {
    assert.equal(state.street, street);
    assert.equal(state.toAct, 1);
    state = await applyAction(state, 1, "check");
    state = await applyAction(state, 0, "check");
  }

  assert.equal(state.street, "complete");
  assert.equal(state.stacks[0] + state.stacks[1], 200);
  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("re-raising below the minimum raise increment is rejected", async () => {
  let state = await startHand("t-min-raise", 2, HU_STACKS, null);
  state = await applyAction(state, 0, "raise", 5);

  const bounds = betBounds(state, 1);
  assert.deepEqual(bounds, { action: "raise", min: 8, max: 98 });
  await assert.rejects(() => applyAction(state, 1, "raise", 5), IllegalActionError);

  state = await applyAction(state, 1, "raise", 8);
  assert.deepEqual(state.contributed, [6, 10]);
});

test("an all-in call for less refunds the uncalled excess, auto-runs the board, and stays conserved", async () => {
  let state = await startHand("t-allin", 2, [{ seat: 0, stack: 100 }, { seat: 1, stack: 15 }], null);
  state = await applyAction(state, 0, "raise", 50);
  assert.deepEqual(legalActions(state, 1), ["fold", "call"]);

  // Only one seat has a real option left once this call lands - no more
  // betting is possible, so applyAction auto-runs all the way to showdown
  // within this single call, rather than stopping at an intermediate
  // "stack is 0" state to ask anyone to check through dead streets. So by
  // the time this returns, stacks[1] already reflects the showdown result,
  // not the momentary post-call value - only allIn and the contributed/
  // conservation math are observable as asserted below.
  state = await applyAction(state, 1, "call");
  assert.deepEqual(state.contributed, [51, 15]);
  assert.equal(state.allIn[1], true);
  assert.equal(state.street, "complete");
  assert.equal(state.stacks[0] + state.stacks[1], 115);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("a stack short of a full raise can still go all-in for less as a raise", async () => {
  let state = await startHand("t-allin-raise", 2, [{ seat: 0, stack: 100 }, { seat: 1, stack: 5 }], null);
  state = await applyAction(state, 0, "raise", 3);

  assert.deepEqual(betBounds(state, 1), { action: "raise", min: 3, max: 3 });
  await assert.rejects(() => applyAction(state, 1, "raise", 2), IllegalActionError);

  state = await applyAction(state, 1, "raise", 3);
  assert.equal(state.stacks[1], 0);
  assert.equal(state.allIn[1], true);
});

// ---- multi-way (3+ seats) --------------------------------------------------

test("a 3-way hand with a fold keeps the remaining two seats playing to a checked-down showdown", async () => {
  let state = await startHand("t-3way-fold", 6, [{ seat: 0, stack: 100 }, { seat: 2, stack: 100 }, { seat: 4, stack: 100 }], null);
  assert.equal(state.buttonSeat, 0);
  assert.equal(state.smallBlindSeat, 2);
  assert.equal(state.bigBlindSeat, 4);
  assert.equal(state.toAct, 0);

  state = await applyAction(state, 0, "fold");
  assert.equal(state.street, "preflop"); // 2 contestants remain - hand continues
  assert.equal(state.folded[0], true);

  state = await applyAction(state, 2, "call");
  assert.equal(state.toAct, 4);
  state = await applyAction(state, 4, "check");
  assert.equal(state.street, "flop");

  state = await playPassively(state);
  assert.equal(state.street, "complete");
  for (const sp of state.sidePots) assert.ok(!sp.eligibleSeats.includes(0));
  assert.equal(state.stacks[0] + state.stacks[2] + state.stacks[4], 300);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("a 4-way hand checks down to showdown with a single contested pot", async () => {
  let state = await startHand(
    "t-4way",
    6,
    [{ seat: 0, stack: 100 }, { seat: 1, stack: 100 }, { seat: 2, stack: 100 }, { seat: 3, stack: 100 }],
    null,
  );
  state = await playPassively(state);

  assert.equal(state.street, "complete");
  assert.equal(state.sidePots.length, 1);
  assert.deepEqual(state.sidePots[0].eligibleSeats.slice().sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(state.stacks.reduce((a, b) => a + b, 0), 400);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

test("computeSidePots awards each layer to the correct seat with hand-crafted cards", () => {
  const board = cards(["2h", "7d", "9c", "3s", "4h"]);
  const holeCards = [
    cards(["9s", "9h"]), // seat 0: trips nines - best of all three
    cards(["7s", "7h"]), // seat 1: trips sevens - beats seat 2, loses to seat 0
    cards(["2s", "3h"]), // seat 2: two pair - weakest
  ];
  const contributed = [10, 30, 150];
  const folded = [false, false, false];

  const pots = computeSidePots(3, contributed, folded, holeCards, board);

  assert.equal(pots.length, 3);
  assert.deepEqual(pots[0], { amount: 30, eligibleSeats: [0, 1, 2], winners: [0] });
  assert.deepEqual(pots[1], { amount: 40, eligibleSeats: [1, 2], winners: [1] });
  assert.deepEqual(pots[2], { amount: 120, eligibleSeats: [2], winners: [2] });
  assert.equal(pots.reduce((sum, p) => sum + p.amount, 0), 190);
});

test("a 3-way hand with two distinct all-in amounts produces layered side pots that satisfy engine invariants", async () => {
  let state = await startHand(
    "t-3way-allin",
    6,
    [{ seat: 0, stack: 100 }, { seat: 1, stack: 100 }, { seat: 2, stack: 20 }],
    null,
  );
  // button=0, SB=1, BB=2, UTG(=button, 3-handed)=0 acts first preflop.
  state = await applyAction(state, 0, "raise", 30); // contributed [30,1,2]
  state = await applyAction(state, 1, "call"); // contributed [30,30,2]
  assert.deepEqual(legalActions(state, 2), ["fold", "call"]); // 18 left, can't cover 28 owed - no raise offered
  state = await applyAction(state, 2, "call"); // all-in for less: contributed [30,30,20]
  assert.equal(state.stacks[2], 0);
  assert.equal(state.allIn[2], true);

  state = await playPassively(state);
  assert.equal(state.street, "complete");

  const totalContributed = state.contributed.reduce((a, b) => a + b, 0);
  const totalSidePots = state.sidePots.reduce((a, sp) => a + sp.amount, 0);
  assert.equal(totalContributed, totalSidePots);
  assert.equal(state.sidePots.length, 2);
  for (const sp of state.sidePots) {
    for (const seat of sp.eligibleSeats) assert.equal(state.folded[seat], false);
  }
  assert.equal(state.stacks.reduce((a, b) => a + b, 0), 220);

  const result = await verifyTableBundle(buildProofBundle(state));
  assert.equal(result.valid, true);
});

// ---- turn-order edge cases -------------------------------------------------

test("button rotation skips a seat no longer occupied", async () => {
  let state = await startHand("t-button-1", 6, [{ seat: 0, stack: 100 }, { seat: 2, stack: 100 }, { seat: 4, stack: 100 }], null);
  assert.equal(state.buttonSeat, 0);
  state = await applyAction(state, 0, "fold");
  state = await applyAction(state, 2, "fold");
  assert.equal(state.street, "complete");

  // seat 2 has left the room by the next hand.
  const nextState = await startHand("t-button-2", 6, [{ seat: 0, stack: 99 }, { seat: 4, stack: 103 }], state.buttonSeat);
  assert.equal(nextState.buttonSeat, 4);
});

// ---- configurable blinds + rabbit-hunt support ------------------------------

test("startHand accepts custom blinds and posts/tracks them correctly", async () => {
  let state = await startHand("t-blinds", 2, [{ seat: 0, stack: 1000 }, { seat: 1, stack: 1000 }], null, 5, 10);
  assert.equal(state.smallBlind, 5);
  assert.equal(state.bigBlind, 10);
  assert.equal(state.stacks[0], 995); // SB posted 5
  assert.equal(state.stacks[1], 990); // BB posted 10
  assert.equal(state.minRaiseIncrement, 10);

  // An opening bet's minimum should track the custom big blind, not the
  // module default of 2.
  state = await applyAction(state, 0, "call");
  state = await applyAction(state, 1, "check");
  const bounds = betBounds(state, 1);
  assert.equal(bounds.min, 10);
});

test("startHand falls back to the standard 1/2 blinds when none are given", async () => {
  const state = await startHand("t-default-blinds", 2, HU_STACKS, null);
  assert.equal(state.smallBlind, 1);
  assert.equal(state.bigBlind, 2);
});

test("finalStreet records where the hand actually ended, independent of the completion marker", async () => {
  // A preflop fold never deals any community cards - finalStreet should
  // say "preflop" even though `street` itself becomes "complete".
  let folded = await startHand("t-final-street-fold", 2, HU_STACKS, null);
  folded = await applyAction(folded, 0, "fold");
  assert.equal(folded.street, "complete");
  assert.equal(folded.finalStreet, "preflop");

  // A full showdown plays every street for real.
  let showdown = await startHand("t-final-street-showdown", 2, HU_STACKS, null);
  showdown = await playPassively(showdown);
  assert.equal(showdown.street, "complete");
  assert.equal(showdown.finalStreet, "river");
});

// ---- provably-fair entropy sourcing ---------------------------------------
// The whole point of the commit-reveal scheme is that no single party
// unilaterally controls the shuffle. If the server generated every seat's
// seed itself, the "commitment" would only prove the server didn't lie
// about what it already privately decided - not that it couldn't have
// tried many candidate shuffles before committing to one. These tests
// confirm a caller-supplied (i.e. that seat's own browser-generated)
// seed is what actually gets used, not silently discarded in favor of
// server randomness.

test("a supplied client seed is the exact value used - not silently replaced by server randomness", async () => {
  const seat0Seed = randomHex();
  const seat1Seed = randomHex();
  const state = await startHand("t-client-seeds", 2, HU_STACKS, null, 1, 2, { 0: seat0Seed, 1: seat1Seed });
  assert.equal(state.seedReveals[0], seat0Seed);
  assert.equal(state.seedReveals[1], seat1Seed);
  assert.deepEqual(state.seedSources.filter((s) => s !== null), ["client", "client"]);

  const bundle = buildProofBundle(await playPassively(state));
  const result = await verifyTableBundle(bundle);
  assert.equal(result.valid, true);
  assert.deepEqual(bundle.entropySource.filter((s) => s !== null), ["client", "client"]);
});

test("a seat that doesn't supply a seed falls back to server-generated randomness, tracked honestly", async () => {
  const seat0Seed = randomHex();
  const state = await startHand("t-mixed-seeds", 2, HU_STACKS, null, 1, 2, { 0: seat0Seed });
  assert.equal(state.seedReveals[0], seat0Seed);
  assert.equal(state.seedSources[0], "client");
  assert.equal(state.seedSources[1], "server");
  // The fallback is still real, unpredictable randomness - just not
  // player-supplied. It should look like randomHex()'s own output (64 hex
  // chars) and obviously shouldn't just be empty or a fixed placeholder.
  assert.match(state.seedReveals[1], /^[0-9a-f]{64}$/);

  const bundle = buildProofBundle(await playPassively(state));
  const result = await verifyTableBundle(bundle);
  assert.equal(result.valid, true);
});

test("with no client seeds supplied at all, every seat falls back to the server and the bundle still verifies", async () => {
  const state = await startHand("t-no-client-seeds", 2, HU_STACKS, null);
  assert.deepEqual(state.seedSources.filter((s) => s !== null), ["server", "server"]);
  const bundle = buildProofBundle(await playPassively(state));
  assert.deepEqual(bundle.entropySource.filter((s) => s !== null), ["server", "server"]);
  assert.equal((await verifyTableBundle(bundle)).valid, true);
});
