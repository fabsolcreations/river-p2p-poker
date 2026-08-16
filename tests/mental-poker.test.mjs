import test from "node:test";
import assert from "node:assert/strict";

import { commitment, transcriptGenesis, verifyTranscript } from "../app/play/proof.ts";
import {
  appendProtocolEntry,
  applyMasking,
  buildInitialDeck,
  cardPointTable,
  dealCommunityCard,
  dealPrivateCard,
  decryptWithBothKeys,
  deriveMaskingRound,
  jointPublicKey,
  revealPartialDecryption,
  serializeCiphertext,
  verifyMentalPokerBundle,
} from "../app/play/mental-poker.ts";

const HOLE_POSITIONS = { player: [0, 2], opponent: [1, 3] };
const BOARD_POSITIONS = [5, 6, 7, 9, 11];

async function playFullHand(handId, playerMaskerSeed, opponentMaskerSeed) {
  const table = await cardPointTable();

  const playerCommitment = await commitment("player", handId, playerMaskerSeed);
  const opponentCommitment = await commitment("opponent", handId, opponentMaskerSeed);

  const playerRound = await deriveMaskingRound(handId, "player", playerMaskerSeed);
  const opponentRound = await deriveMaskingRound(handId, "opponent", opponentMaskerSeed);
  const jointPk = jointPublicKey(playerRound.publicKeyHex, opponentRound.publicKeyHex);

  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, jointPk, playerRound.randomizersHex, playerRound.permutation);
  deck = applyMasking(deck, jointPk, opponentRound.randomizersHex, opponentRound.permutation);

  let transcript = [];
  transcript = await appendProtocolEntry(transcript, "commit_player_masking", handId);
  transcript = await appendProtocolEntry(transcript, "commit_opponent_masking", handId);
  transcript = await appendProtocolEntry(transcript, "mask_round_player", handId);
  transcript = await appendProtocolEntry(transcript, "mask_round_opponent", handId);

  const deals = [];
  const resolved = { player: [], opponent: [], board: [] };

  for (const position of HOLE_POSITIONS.player) {
    const ciphertext = deck[position];
    const otherPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
    const code = dealPrivateCard(ciphertext, playerRound.secretKeyHex, otherPartial, table.byPointHex);
    deals.push({ position, recipients: ["player"], partials: { opponent: otherPartial }, cardCode: code });
    resolved.player.push(code);
    transcript = await appendProtocolEntry(transcript, `deal_hole_player_${position}`, handId);
  }

  for (const position of HOLE_POSITIONS.opponent) {
    const ciphertext = deck[position];
    const otherPartial = await revealPartialDecryption(playerRound.secretKeyHex, ciphertext);
    const code = dealPrivateCard(ciphertext, opponentRound.secretKeyHex, otherPartial, table.byPointHex);
    deals.push({ position, recipients: ["opponent"], partials: { player: otherPartial }, cardCode: code });
    resolved.opponent.push(code);
    transcript = await appendProtocolEntry(transcript, `deal_hole_opponent_${position}`, handId);
  }

  for (const position of BOARD_POSITIONS) {
    const ciphertext = deck[position];
    const playerPartial = await revealPartialDecryption(playerRound.secretKeyHex, ciphertext);
    const opponentPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
    const code = dealCommunityCard(ciphertext, playerPartial, opponentPartial, table.byPointHex);
    deals.push({
      position,
      recipients: ["player", "opponent"],
      partials: { player: playerPartial, opponent: opponentPartial },
      cardCode: code,
    });
    resolved.board.push(code);
    transcript = await appendProtocolEntry(transcript, `deal_board_${position}`, handId);
  }

  transcript = await appendProtocolEntry(transcript, "reveal_player_masking", handId);
  transcript = await appendProtocolEntry(transcript, "reveal_opponent_masking", handId);

  const bundle = {
    version: "RIVER_POC_V3",
    handId,
    commitments: { player: playerCommitment, opponent: opponentCommitment },
    reveals: { playerMaskerSeed, opponentMaskerSeed },
    maskingRounds: { player: playerRound, opponent: opponentRound },
    jointPublicKeyHex: jointPk,
    maskedDeck: deck.map(serializeCiphertext),
    deals,
    transcript,
    finalTranscriptHash: transcript.at(-1)?.hash ?? (await transcriptGenesis(handId)),
  };

  return { bundle, resolved, table, playerRound, opponentRound, deck };
}

test("card points are deterministic and unique across all 52 codes", async () => {
  const a = await cardPointTable();
  const b = await cardPointTable();
  assert.equal(a.byCode.size, 52);
  assert.equal(a.byPointHex.size, 52);
  assert.equal(new Set(a.byCode.values()).size, 52);
  for (const [code, hex] of a.byCode) assert.equal(b.byCode.get(code), hex);
});

test("masking key, permutation, and randomizer derivation is deterministic and well-formed", async () => {
  const handId = "river-mp-test-1";
  const roundA = await deriveMaskingRound(handId, "player", "seed-a");
  const roundB = await deriveMaskingRound(handId, "player", "seed-a");
  assert.deepEqual(roundA, roundB);

  const sortedPermutation = [...roundA.permutation].sort((x, y) => x - y);
  assert.deepEqual(sortedPermutation, Array.from({ length: 52 }, (_, index) => index));

  assert.equal(roundA.randomizersHex.length, 52);
  for (const randomizer of roundA.randomizersHex) {
    assert.equal(randomizer.length, 64);
    assert.notEqual(BigInt(`0x${randomizer}`), 0n);
  }
  assert.notEqual(BigInt(`0x${roundA.secretKeyHex}`), 0n);

  const differentSeed = await deriveMaskingRound(handId, "player", "seed-b");
  assert.notDeepEqual(differentSeed.permutation, roundA.permutation);
});

test("double masking and shuffling, then decrypting with both revealed keys, recovers all 52 cards exactly once", async () => {
  const { deck, playerRound, opponentRound, table } = await playFullHand("river-mp-complete", "p-seed", "o-seed");
  const codes = deck.map((ciphertext) =>
    decryptWithBothKeys(ciphertext, playerRound.secretKeyHex, opponentRound.secretKeyHex, table.byPointHex),
  );
  assert.equal(codes.filter((code) => code !== null).length, 52);
  assert.equal(new Set(codes).size, 52);
});

test("a recipient's own key alone cannot resolve a dealt card without the other player's partial", async () => {
  const handId = "river-mp-privacy";
  const table = await cardPointTable();
  const playerRound = await deriveMaskingRound(handId, "player", "p-seed");
  const opponentRound = await deriveMaskingRound(handId, "opponent", "o-seed");
  const jointPk = jointPublicKey(playerRound.publicKeyHex, opponentRound.publicKeyHex);
  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, jointPk, playerRound.randomizersHex, playerRound.permutation);
  deck = applyMasking(deck, jointPk, opponentRound.randomizersHex, opponentRound.permutation);

  const ciphertext = deck[0];
  const correctOtherPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
  const correctCard = dealPrivateCard(ciphertext, playerRound.secretKeyHex, correctOtherPartial, table.byPointHex);
  assert.notEqual(correctCard, null);

  // Stand-in for "the player never learned the real opponent key/partial."
  const impostorRound = await deriveMaskingRound(handId, "opponent", "a-seed-the-player-never-learns");
  const wrongOtherPartial = await revealPartialDecryption(impostorRound.secretKeyHex, ciphertext);
  const wrongGuess = dealPrivateCard(ciphertext, playerRound.secretKeyHex, wrongOtherPartial, table.byPointHex);

  assert.notEqual(wrongGuess, correctCard);
  assert.equal(wrongGuess, null);
});

test("community card decryption is independent of which partial is subtracted first", async () => {
  const handId = "river-mp-order";
  const table = await cardPointTable();
  const playerRound = await deriveMaskingRound(handId, "player", "p2");
  const opponentRound = await deriveMaskingRound(handId, "opponent", "o2");
  const jointPk = jointPublicKey(playerRound.publicKeyHex, opponentRound.publicKeyHex);
  let deck = buildInitialDeck(table.byCode);
  deck = applyMasking(deck, jointPk, playerRound.randomizersHex, playerRound.permutation);
  deck = applyMasking(deck, jointPk, opponentRound.randomizersHex, opponentRound.permutation);

  const ciphertext = deck[5];
  const playerPartial = await revealPartialDecryption(playerRound.secretKeyHex, ciphertext);
  const opponentPartial = await revealPartialDecryption(opponentRound.secretKeyHex, ciphertext);
  const first = dealCommunityCard(ciphertext, playerPartial, opponentPartial, table.byPointHex);
  const second = dealCommunityCard(ciphertext, opponentPartial, playerPartial, table.byPointHex);
  assert.equal(first, second);
  assert.notEqual(first, null);
});

test("the verifier accepts a full honestly-played hand", async () => {
  const { bundle } = await playFullHand("river-mp-accept", "player-seed-x", "opponent-seed-x");
  const result = await verifyMentalPokerBundle(bundle);
  for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, `expected ${name} to pass`);
  assert.equal(result.valid, true);
});

test("a falsified masker-seed reveal is caught", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-seed", "s1", "s2");
  const tampered = { ...bundle, reveals: { ...bundle.reveals, playerMaskerSeed: "not-the-real-seed" } };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.playerKeyCommitment, false);
  assert.equal(result.valid, false);
});

test("a falsified permutation inconsistent with the committed seed is caught", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-perm", "s3", "s4");
  const reversedPermutation = [...bundle.maskingRounds.player.permutation].reverse();
  const tampered = {
    ...bundle,
    maskingRounds: { ...bundle.maskingRounds, player: { ...bundle.maskingRounds.player, permutation: reversedPermutation } },
  };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.playerPermutation, false);
  assert.equal(result.valid, false);
});

test("falsified randomizers inconsistent with the committed seed are caught", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-rand", "s5", "s6");
  const tamperedRandomizers = [...bundle.maskingRounds.player.randomizersHex];
  tamperedRandomizers[0] = tamperedRandomizers[1];
  const tampered = {
    ...bundle,
    maskingRounds: {
      ...bundle.maskingRounds,
      player: { ...bundle.maskingRounds.player, randomizersHex: tamperedRandomizers },
    },
  };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.playerRandomizers, false);
  assert.equal(result.valid, false);
});

test("a tampered masked-deck ciphertext after both masking rounds is caught", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-deck", "s7", "s8");
  const tamperedDeck = [...bundle.maskedDeck];
  tamperedDeck[10] = tamperedDeck[20];
  const tampered = { ...bundle, maskedDeck: tamperedDeck };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.maskedDeckReplay, false);
  assert.equal(result.valid, false);
});

test("a falsified recorded partial decryption is caught", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-partial", "s9", "s10");
  const communityDeal = bundle.deals.find((deal) => deal.recipients.length === 2);
  const tamperedDeals = bundle.deals.map((deal) =>
    deal.recipients.length === 1 && deal.recipients[0] === "player"
      ? { ...deal, partials: { ...deal.partials, opponent: communityDeal.partials.opponent } }
      : deal,
  );
  const tampered = { ...bundle, deals: tamperedDeals };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.dealPartialsCorrect, false);
  assert.equal(result.valid, false);
});

test("a card code inconsistent with its ciphertext is caught", async () => {
  const { bundle, table } = await playFullHand("river-mp-tamper-code", "s11", "s12");
  const usedCodes = new Set(bundle.deals.map((deal) => deal.cardCode));
  const unusedCode = [...table.byCode.keys()].find((code) => !usedCodes.has(code));
  const tamperedDeals = bundle.deals.map((deal, index) => (index === 0 ? { ...deal, cardCode: unusedCode } : deal));
  const tampered = { ...bundle, deals: tamperedDeals };
  const result = await verifyMentalPokerBundle(tampered);
  assert.equal(result.checks.dealPlaintextsCorrect, false);
  assert.equal(result.checks.dealsWellFormed, true);
  assert.equal(result.valid, false);
});

test("duplicate or out-of-range deal positions are rejected", async () => {
  const { bundle } = await playFullHand("river-mp-tamper-position", "s13", "s14");

  const duplicated = bundle.deals.map((deal, index) => (index === 1 ? { ...deal, position: bundle.deals[0].position } : deal));
  const duplicateResult = await verifyMentalPokerBundle({ ...bundle, deals: duplicated });
  assert.equal(duplicateResult.checks.dealsWellFormed, false);
  assert.equal(duplicateResult.valid, false);

  const outOfRange = bundle.deals.map((deal, index) => (index === 0 ? { ...deal, position: 999 } : deal));
  const outOfRangeResult = await verifyMentalPokerBundle({ ...bundle, deals: outOfRange });
  assert.equal(outOfRangeResult.checks.dealsWellFormed, false);
  assert.equal(outOfRangeResult.valid, false);
});

test("proof.ts primitives remain usable alongside mental-poker.ts in the same process", async () => {
  const valid = await verifyTranscript([], "river-mp-coexist");
  assert.equal(valid, true);
});
