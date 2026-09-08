import test from "node:test";
import assert from "node:assert/strict";

import { createMpSession, stepsFor, receiveHolePartial } from "../app/play/mental-poker-client.ts";
import {
  applyMasking, buildInitialDeck, cardPointTable, dealCommunityCard, dealPrivateCard,
  jointPublicKey, parseCiphertext, revealPartialDecryption, serializeCiphertext,
} from "../app/play/mental-poker.ts";
import { BOARD_POSITIONS, HOLE_POSITIONS } from "../worker/mental-poker-protocol.ts";

/**
 * The relay is explicitly NOT trusted with cards, so every field of an
 * MpProgress is adversarial input. These tests drive the browser driver with
 * frames a dishonest relay could send.
 *
 * The attack these exist to prevent, which DID work: the board-partials branch
 * iterated `openBoardPositions` verbatim. Naming the victim's own hole
 * positions there made the browser hand back a share of its own cards, and
 * combined with the share the relay already held from the hole-partials phase
 * that reveals the card with NO key - while the published receipt still
 * verifies clean, so nothing about the proof shows the leak.
 */
async function dealtHand(handId = "oracle") {
  const victimSeat = 1;
  const honest = await createMpSession(handId, 0);
  const victim = await createMpSession(handId, victimSeat);
  const table = await cardPointTable();
  const joint = jointPublicKey(honest.round.publicKeyHex, victim.round.publicKeyHex);

  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, joint, honest.round.randomizersHex, honest.round.permutation);
  deck = applyMasking(deck, joint, victim.round.randomizersHex, victim.round.permutation);
  const maskedDeck = deck.map(serializeCiphertext);

  // What the relay legitimately holds after the hole-partials phase: seat 0's
  // shares of seat 1's two hole ciphertexts.
  const relayHeld = {};
  for (const position of HOLE_POSITIONS[victimSeat]) {
    relayHeld[position] = await revealPartialDecryption(honest.round.secretKeyHex, parseCiphertext(maskedDeck[position]));
  }
  const base = {
    waitingOn: [victimSeat], handId, deckToMask: null, board: [],
    publicKeys: [honest.round.publicKeyHex, victim.round.publicKeyHex],
  };
  const freshVictim = async () => {
    const s = await createMpSession(handId, victimSeat, victim.maskerSeed);
    await stepsFor(s, { ...base, phase: "hole-partials", maskedDeck });   // pins the real deck
    return s;
  };
  return { victim, victimSeat, maskedDeck, relayHeld, base, table, freshVictim };
}

test("the relay cannot get a hole-card share by calling it a board position", async () => {
  const { victimSeat, maskedDeck, relayHeld, base, table, freshVictim } = await dealtHand("oracle-1");
  const session = await freshVictim();

  const emitted = await stepsFor(session, {
    ...base, phase: "board-partials", maskedDeck,
    openBoardPositions: HOLE_POSITIONS[victimSeat],   // not board positions at all
  });
  assert.deepEqual(emitted, [], "the browser must refuse to unseal its own hole positions");

  // And the relay therefore cannot combine anything into a card.
  for (const position of HOLE_POSITIONS[victimSeat]) {
    const leaked = emitted.find((m) => m.position === position);
    assert.equal(leaked, undefined);
    assert.equal(
      dealCommunityCard(parseCiphertext(maskedDeck[position]), relayHeld[position], relayHeld[position], table.byPointHex),
      null,
      "one share twice must not decrypt a card",
    );
  }
});

test("the relay cannot swap a hole ciphertext onto a legitimate board index", async () => {
  // Position validation alone would miss this: the index IS a board position.
  // Only pinning the deck catches it.
  const { victimSeat, maskedDeck, base, freshVictim } = await dealtHand("oracle-2");
  const session = await freshVictim();

  const swapped = maskedDeck.slice();
  swapped[BOARD_POSITIONS[0]] = maskedDeck[HOLE_POSITIONS[victimSeat][0]];

  const emitted = await stepsFor(session, {
    ...base, phase: "board-partials", maskedDeck: swapped, openBoardPositions: [BOARD_POSITIONS[0]],
  });
  assert.deepEqual(emitted, [], "a deck that is not the pinned one must be refused outright");
});

test("an honest board request is still answered", async () => {
  const { maskedDeck, base, freshVictim } = await dealtHand("oracle-3");
  const session = await freshVictim();
  const emitted = await stepsFor(session, {
    ...base, phase: "board-partials", maskedDeck, openBoardPositions: [BOARD_POSITIONS[0]],
  });
  assert.equal(emitted.length, 1, "the guards must not break normal play");
  assert.equal(emitted[0].type, "mp-board-partial");
  assert.equal(emitted[0].position, BOARD_POSITIONS[0]);
});

test("a hole partial against a substituted deck is ignored", async () => {
  const { victim, victimSeat, maskedDeck, relayHeld, table, base } = await dealtHand("oracle-4");
  const session = await createMpSession("oracle-4", victimSeat, victim.maskerSeed);
  await stepsFor(session, { ...base, phase: "hole-partials", maskedDeck });

  const position = HOLE_POSITIONS[victimSeat][0];
  const real = dealPrivateCard(parseCiphertext(maskedDeck[position]), session.round.secretKeyHex,
    relayHeld[position], table.byPointHex);
  assert.ok(real, "the honest deal resolves a real card");

  const swapped = maskedDeck.slice();
  swapped[position] = maskedDeck[HOLE_POSITIONS[0][0]];   // someone else's ciphertext
  const got = await receiveHolePartial(session, position, relayHeld[position], swapped);
  assert.equal(got, null, "a partial against a deck that is not the pinned one must be dropped");
});
