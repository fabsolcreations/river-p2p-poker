import test from "node:test";
import assert from "node:assert/strict";

import { randomHex } from "../app/play/proof.ts";
import {
  buildInitialDeck,
  cardPointTable,
  deriveMaskingRound,
  jointPublicKey,
  parseCiphertext,
  revealPartialDecryption,
  serializeCiphertext,
  applyMasking,
} from "../app/play/mental-poker.ts";
import {
  BOARD_POSITIONS,
  HOLE_POSITIONS,
  MpProtocolError,
  abort,
  applyBoardPartial,
  applyCommitment,
  applyHolePartial,
  applyMaskRound,
  applyShowdownReveal,
  beginShowdown,
  initialMpState,
  openBoardStreet,
  waitingOn,
} from "../worker/mental-poker-protocol.ts";
import { commitment } from "../app/play/proof.ts";

/**
 * Drives both browsers plus the relay in one process. The two "parties" only
 * ever touch their own secrets - anything crossing between them goes through
 * the protocol state machine, exactly as it would over the socket.
 */
async function setupThroughDealing(handId = "mp-hand-1") {
  const seeds = [randomHex(), randomHex()];
  const rounds = [
    await deriveMaskingRound(handId, "player", seeds[0]),
    await deriveMaskingRound(handId, "opponent", seeds[1]),
  ];
  const joint = jointPublicKey(rounds[0].publicKeyHex, rounds[1].publicKeyHex);
  const table = await cardPointTable();

  let state = initialMpState(handId);
  state = applyCommitment(state, 0, await commitment("player", handId, seeds[0]), rounds[0].publicKeyHex);
  state = applyCommitment(state, 1, await commitment("opponent", handId, seeds[1]), rounds[1].publicKeyHex);
  assert.equal(state.phase, "mask-seat-0");

  // Each party masks in turn, on top of what the previous party produced.
  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, joint, rounds[0].randomizersHex, rounds[0].permutation);
  state = applyMaskRound(state, 0, deck.map(serializeCiphertext));
  assert.equal(state.phase, "mask-seat-1");

  deck = applyMasking(deck, joint, rounds[1].randomizersHex, rounds[1].permutation);
  state = applyMaskRound(state, 1, deck.map(serializeCiphertext));
  assert.equal(state.phase, "hole-partials");

  // Each seat strips its own layer off the OTHER seat's hole cards.
  for (const seat of [0, 1]) {
    const opponent = seat === 0 ? 1 : 0;
    for (const position of HOLE_POSITIONS[opponent]) {
      const partial = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
      state = applyHolePartial(state, seat, position, partial);
    }
  }
  assert.equal(state.phase, "betting");
  return { state, rounds, seeds, table, handId };
}

test("a full trustless deal reaches betting with neither party able to read the other's cards", async () => {
  const { state } = await setupThroughDealing();
  assert.equal(state.phase, "betting");
  // The relay holds only ciphertexts and partials - no card codes at all.
  assert.equal(state.board.length, 0);
  assert.deepEqual(state.revealedHole, {});
  assert.equal(state.maskedDeck.length, 52);
});

test("masking is strictly ordered - seat 1 cannot mask before seat 0", async () => {
  const handId = "mp-order";
  const seeds = [randomHex(), randomHex()];
  let state = initialMpState(handId);
  state = applyCommitment(state, 0, await commitment("player", handId, seeds[0]), "02aa");
  state = applyCommitment(state, 1, await commitment("opponent", handId, seeds[1]), "02bb");

  const table = await cardPointTable();
  const deck = buildInitialDeck(table.byCode).map(serializeCiphertext);
  assert.throws(() => applyMaskRound(state, 1, deck), MpProtocolError);
});

test("a seat cannot supply the partial for its own hole card", async () => {
  const handId = "mp-selfpartial";
  const seeds = [randomHex(), randomHex()];
  const rounds = [
    await deriveMaskingRound(handId, "player", seeds[0]),
    await deriveMaskingRound(handId, "opponent", seeds[1]),
  ];
  const joint = jointPublicKey(rounds[0].publicKeyHex, rounds[1].publicKeyHex);
  const table = await cardPointTable();
  let state = initialMpState(handId);
  state = applyCommitment(state, 0, await commitment("player", handId, seeds[0]), rounds[0].publicKeyHex);
  state = applyCommitment(state, 1, await commitment("opponent", handId, seeds[1]), rounds[1].publicKeyHex);
  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, joint, rounds[0].randomizersHex, rounds[0].permutation);
  state = applyMaskRound(state, 0, deck.map(serializeCiphertext));
  deck = applyMasking(deck, joint, rounds[1].randomizersHex, rounds[1].permutation);
  state = applyMaskRound(state, 1, deck.map(serializeCiphertext));

  // Position 0 belongs to seat 0, so only seat 1 may strip a layer off it.
  const partial = await revealPartialDecryption(rounds[0].secretKeyHex, parseCiphertext(state.maskedDeck[0]));
  assert.throws(() => applyHolePartial(state, 0, 0, partial), MpProtocolError);
});

test("board cards are gated per street, so the river cannot be read during the flop", async () => {
  let { state, rounds } = await setupThroughDealing("mp-board");

  // Nothing is open until the street actually starts.
  await assert.rejects(() => applyBoardPartial(state, 0, BOARD_POSITIONS[0], "deadbeef"), MpProtocolError);

  state = openBoardStreet(state, "flop");
  for (const position of [5, 6, 7]) {
    for (const seat of [0, 1]) {
      const partial = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
      ({ state } = await applyBoardPartial(state, seat, position, partial));
    }
  }
  assert.equal(state.board.length, 3);
  assert.equal(state.phase, "betting");

  // The turn is still sealed - a partial for it is refused until its street opens.
  const turnPartial = await revealPartialDecryption(rounds[0].secretKeyHex, parseCiphertext(state.maskedDeck[9]));
  await assert.rejects(() => applyBoardPartial(state, 0, 9, turnPartial), MpProtocolError);

  state = openBoardStreet(state, "turn");
  for (const seat of [0, 1]) {
    const partial = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[9]));
    ({ state } = await applyBoardPartial(state, seat, 9, partial));
  }
  assert.equal(state.board.length, 4);
  assert.equal(new Set(state.board).size, 4, "every board card is distinct");
});

test("a showdown reveal is checked against the committed deck, so a claimed hand cannot be faked", async () => {
  let { state, rounds } = await setupThroughDealing("mp-showdown");
  state = beginShowdown(state);

  // Seat 0 reveals honestly: its own partials plus the relayed opponent ones.
  const ownPartials = [];
  const trueCards = [];
  const table = await cardPointTable();
  for (const position of HOLE_POSITIONS[0]) {
    const own = await revealPartialDecryption(rounds[0].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
    ownPartials.push(own);
    const { dealCommunityCard } = await import("../app/play/mental-poker.ts");
    trueCards.push(dealCommunityCard(parseCiphertext(state.maskedDeck[position]), own, state.holePartials[position], table.byPointHex));
  }

  const honest = await applyShowdownReveal(state, 0, trueCards, ownPartials);
  assert.deepEqual(honest.revealedHole[0], trueCards);

  // Claiming a better hand than was actually dealt is rejected - the cards
  // simply don't decrypt to what was committed.
  const lie = trueCards[0] === "As" ? ["Ks", "Kd"] : ["As", "Ad"];
  await assert.rejects(() => applyShowdownReveal(state, 0, lie, ownPartials), MpProtocolError);
});

test("waitingOn names the seat that is stalling, which is what the timeout acts on", async () => {
  const handId = "mp-waiting";
  const seeds = [randomHex(), randomHex()];
  let state = initialMpState(handId);
  assert.deepEqual(waitingOn(state).sort(), [0, 1]);

  state = applyCommitment(state, 0, await commitment("player", handId, seeds[0]), "02aa");
  assert.deepEqual(waitingOn(state), [1], "only the seat that hasn't committed is blocking");

  state = applyCommitment(state, 1, await commitment("opponent", handId, seeds[1]), "02bb");
  assert.deepEqual(waitingOn(state), [0], "masking starts with seat 0");
});

test("an aborted hand records why and stops accepting protocol messages", async () => {
  const { state } = await setupThroughDealing("mp-abort");
  const dead = abort(state, "seat 1 stopped responding");
  assert.equal(dead.phase, "aborted");
  assert.equal(dead.abortReason, "seat 1 stopped responding");
  assert.deepEqual(waitingOn(dead), []);
  assert.throws(() => openBoardStreet(dead, "flop"), MpProtocolError);
});

// ---- engine integration: betting without cards ---------------------------

test("a trustless hand bets normally and parks at showdown instead of resolving blind", async () => {
  const { applyAction, startTrustlessHand, finishShowdown, cardsFromCodes } = await import("../worker/table-engine.ts");

  let state = await startTrustlessHand("mp-engine-1", 2, [
    { seat: 0, stack: 100 },
    { seat: 1, stack: 100 },
  ], null);

  // The engine has no cards at all - it is refereeing blind.
  assert.deepEqual(state.holeCards, [null, null]);
  assert.deepEqual(state.deck, []);
  assert.equal(state.deferShowdown, true);

  // Play a full check-down to the river.
  state = await applyAction(state, 0, "call");
  state = await applyAction(state, 1, "check");
  for (const street of ["flop", "turn", "river"]) {
    assert.equal(state.street, street);
    state = await applyAction(state, 1, "check");
    state = await applyAction(state, 0, "check");
  }

  // Contested, so it must wait for reveals rather than guess a winner.
  assert.equal(state.street, "showdown");
  assert.equal(state.sidePots, null);

  // Supplying the verified cards finishes it through the normal award path.
  const board = cardsFromCodes(["2c", "7d", "9h", "Jc", "4s"]);
  const holeCards = [
    cardsFromCodes(["As", "Ad"]),
    cardsFromCodes(["Ks", "Kd"]),
  ];
  const done = await finishShowdown(state, holeCards, board);
  assert.equal(done.street, "complete");
  assert.equal(done.finalStreet, "river");
  assert.deepEqual(done.sidePots[0].winners, [0], "aces beat kings");
  assert.equal(done.stacks[0] + done.stacks[1], 200, "chips are conserved");
});

test("a trustless hand that folds out never needs a reveal at all", async () => {
  const { applyAction, startTrustlessHand } = await import("../worker/table-engine.ts");

  let state = await startTrustlessHand("mp-engine-2", 2, [
    { seat: 0, stack: 100 },
    { seat: 1, stack: 100 },
  ], null);

  state = await applyAction(state, 0, "fold");

  // One contestant left - no cards are needed to know who takes it, so the
  // hand completes inline with no extra round trip.
  assert.equal(state.street, "complete");
  assert.deepEqual(state.sidePots[0].winners, [1]);
  assert.equal(state.stacks[0], 99);
  assert.equal(state.stacks[1], 101);
});

test("a completed trustless hand produces a receipt the independent verifier accepts", async () => {
  const { verifyMentalPokerBundle, dealCommunityCard } = await import("../app/play/mental-poker.ts");
  const { buildMentalPokerBundle, applyMaskerSeedReveal } = await import("../worker/mental-poker-protocol.ts");

  let { state, rounds, seeds } = await setupThroughDealing("mp-bundle");
  const table = await cardPointTable();

  // Deal the whole board, street by street, exactly as the relay would.
  for (const [street, positions] of [["flop", [5, 6, 7]], ["turn", [9]], ["river", [11]]]) {
    state = openBoardStreet(state, street);
    for (const position of positions) {
      for (const seat of [0, 1]) {
        const partial = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
        ({ state } = await applyBoardPartial(state, seat, position, partial));
      }
    }
  }
  assert.equal(state.board.length, 5);

  // Both seats show down honestly.
  state = beginShowdown(state);
  for (const seat of [0, 1]) {
    const partials = [];
    const cards = [];
    for (const position of HOLE_POSITIONS[seat]) {
      const own = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
      partials.push(own);
      cards.push(dealCommunityCard(parseCiphertext(state.maskedDeck[position]), own, state.holePartials[position], table.byPointHex));
    }
    state = await applyShowdownReveal(state, seat, cards, partials);
  }

  // Masker seeds go last - only now can anyone replay the shuffle.
  state = await applyMaskerSeedReveal(state, 0, seeds[0]);
  state = await applyMaskerSeedReveal(state, 1, seeds[1]);
  assert.equal(state.phase, "complete");

  const bundle = await buildMentalPokerBundle(state);
  const result = await verifyMentalPokerBundle(bundle);
  assert.equal(result.valid, true, `failed checks: ${JSON.stringify(result.checks)}`);

  // Nine cards accounted for: four hole cards plus the five board cards.
  assert.equal(bundle.deals.length, 9);
});

test("a folded trustless hand still verifies, without exposing the hand that folded", async () => {
  const { verifyMentalPokerBundle } = await import("../app/play/mental-poker.ts");
  const { buildMentalPokerBundle, applyMaskerSeedReveal } = await import("../worker/mental-poker-protocol.ts");

  let { state, rounds, seeds } = await setupThroughDealing("mp-bundle-fold");

  state = openBoardStreet(state, "flop");
  for (const position of [5, 6, 7]) {
    for (const seat of [0, 1]) {
      const partial = await revealPartialDecryption(rounds[seat].secretKeyHex, parseCiphertext(state.maskedDeck[position]));
      ({ state } = await applyBoardPartial(state, seat, position, partial));
    }
  }

  // Seat 1 takes it uncontested, so only seat 0 ever shows - or in a real
  // fold, nobody does. Reveal nothing and settle.
  state = beginShowdown(state);
  state = await applyMaskerSeedReveal(state, 0, seeds[0]);
  state = await applyMaskerSeedReveal(state, 1, seeds[1]);

  const bundle = await buildMentalPokerBundle(state);
  const result = await verifyMentalPokerBundle(bundle);
  assert.equal(result.valid, true, `failed checks: ${JSON.stringify(result.checks)}`);

  // Only the three community cards are in the receipt - no hole cards leaked.
  assert.equal(bundle.deals.length, 3);
  assert.ok(bundle.deals.every((deal) => deal.recipients.length === 2));
});

test("a hand folded before any card was turned up produces no attestable receipt", async () => {
  const { buildMentalPokerBundle, applyMaskerSeedReveal, beginSettle } = await import("../worker/mental-poker-protocol.ts");
  const { verifyMentalPokerBundle } = await import("../app/play/mental-poker.ts");

  // Deal, then fold preflop: no board opened, nobody shows down.
  let { state, seeds } = await setupThroughDealing("mp-preflop-fold");
  state = beginSettle(state);
  state = await applyMaskerSeedReveal(state, 0, seeds[0]);
  state = await applyMaskerSeedReveal(state, 1, seeds[1]);

  const bundle = await buildMentalPokerBundle(state);
  assert.equal(bundle.deals.length, 0, "nothing was turned up, so nothing is attested");

  // The verifier rejects a zero-deal bundle by design. That is exactly why
  // the Durable Object must not publish one - a PROOF REJECTED banner on an
  // honest hand would discredit the verifier itself.
  const result = await verifyMentalPokerBundle(bundle);
  assert.equal(result.valid, false);
  assert.equal(result.checks.dealsWellFormed, false);
});

test("a masking key rebuilt from a stored seed is byte-identical", async () => {
  // Surviving a refresh rests entirely on this: the key is a pure function of
  // (handId, role, seed). If derivation ever picked up fresh entropy, a
  // rebuilt session would hold a DIFFERENT key, the cards already dealt to
  // that seat would stop decrypting, and the hand could only abort - the exact
  // failure the reconnect path exists to prevent.
  //
  // This exercises deriveMaskingRound rather than createMpSession because
  // mental-poker-client.ts uses extensionless imports, which the Node test
  // runner cannot resolve. createMpSession is a thin wrapper whose only job is
  // to pass the seed through to this function.
  const seed = randomHex();
  const original = await deriveMaskingRound("mp-reconnect", "opponent", seed);
  const rebuilt = await deriveMaskingRound("mp-reconnect", "opponent", seed);

  assert.equal(rebuilt.publicKeyHex, original.publicKeyHex);
  assert.equal(rebuilt.secretKeyHex, original.secretKeyHex);
  assert.deepEqual(rebuilt.permutation, original.permutation);
  assert.deepEqual(rebuilt.randomizersHex, original.randomizersHex);

  // The role is part of the derivation, so the same seed at the other seat is
  // a different key - a restored session cannot be replayed into the opponent.
  const otherRole = await deriveMaskingRound("mp-reconnect", "player", seed);
  assert.notEqual(otherRole.publicKeyHex, original.publicKeyHex);

  // And so is the hand id, so a seed stored for one hand cannot revive a later
  // one - which is why the storage key includes the hand id.
  const otherHand = await deriveMaskingRound("mp-reconnect-2", "opponent", seed);
  assert.notEqual(otherHand.publicKeyHex, original.publicKeyHex);
});

test("a seed that does not open its commitment is refused at the relay", async () => {
  const { applyMaskerSeedReveal, beginSettle } = await import("../worker/mental-poker-protocol.ts");

  let { state, seeds } = await setupThroughDealing("mp-bad-seed");
  state = beginSettle(state);

  // A player who dislikes the result reveals a well-formed but WRONG seed.
  // Accepting it would write a seed into the receipt that fails verification,
  // making an entirely honest hand read as PROOF REJECTED - the griefer's
  // action, blamed on the table. The relay holds the commitment, so it can
  // and must refuse.
  const wrong = "f".repeat(64);
  await assert.rejects(() => applyMaskerSeedReveal(state, 0, wrong), MpProtocolError);

  // The other seat's real seed must not open this seat's commitment either -
  // the role is bound into the commitment.
  await assert.rejects(() => applyMaskerSeedReveal(state, 0, seeds[1]), MpProtocolError);

  // The honest seed still works, so the check does not break the normal path.
  const settled = await applyMaskerSeedReveal(state, 0, seeds[0]);
  assert.equal(settled.maskerSeeds[0], seeds[0]);
});
