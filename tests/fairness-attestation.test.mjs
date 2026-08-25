import test from "node:test";
import assert from "node:assert/strict";

import { randomHex } from "../app/play/proof.ts";
import {
  auditSeedAck,
  generateSigningKeyPair,
  publicKeyFromPrivate,
  seedHashOf,
  signSeedAck,
  verifySeedAckSignature,
} from "../worker/fairness-attestation.ts";

test("an acknowledgement verifies against the operator's published public key", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const publicKey = await publicKeyFromPrivate(privateKey);

  const seed = randomHex();
  const ack = await signSeedAck("hand-1", 3, seed, privateKey);

  assert.equal(ack.seat, 3);
  assert.equal(ack.handId, "hand-1");
  assert.equal(ack.seedHash, await seedHashOf(seed));
  assert.equal(await verifySeedAckSignature(ack, publicKey), true);
});

test("a forged or tampered acknowledgement does not verify", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const publicKey = await publicKeyFromPrivate(privateKey);
  const ack = await signSeedAck("hand-2", 0, randomHex(), privateKey);

  // Every field is covered by the signature, so changing any of them breaks it.
  assert.equal(await verifySeedAckSignature({ ...ack, seat: 1 }, publicKey), false);
  assert.equal(await verifySeedAckSignature({ ...ack, handId: "hand-3" }, publicKey), false);
  assert.equal(await verifySeedAckSignature({ ...ack, seedHash: await seedHashOf("x") }, publicKey), false);

  // A different operator key can't produce an ack that passes.
  const other = await generateSigningKeyPair();
  const impostor = await signSeedAck("hand-2", 0, randomHex(), other.privateKey);
  assert.equal(await verifySeedAckSignature(impostor, publicKey), false);
});

test("an honest hand audits clean", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const publicKey = await publicKeyFromPrivate(privateKey);
  const seed = randomHex();
  const ack = await signSeedAck("hand-4", 1, seed, privateKey);

  const bundle = { handId: "hand-4", reveals: [randomHex(), seed] };
  assert.deepEqual(await auditSeedAck(ack, publicKey, bundle), { status: "ok" });
});

test("a substituted seat seed is caught, with the operator's own signature as the evidence", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const publicKey = await publicKeyFromPrivate(privateKey);

  // What the player actually sent, and what the server acknowledged holding.
  const sentSeed = randomHex();
  const ack = await signSeedAck("hand-5", 1, sentSeed, privateKey);

  // What the server then published for that seat instead - the substitution
  // the receipt alone cannot rule out.
  const substituted = randomHex();
  const bundle = { handId: "hand-5", reveals: [randomHex(), substituted] };

  const audit = await auditSeedAck(ack, publicKey, bundle);
  assert.equal(audit.status, "seed-substituted");
  assert.equal(audit.acknowledgedHash, await seedHashOf(sentSeed));
  assert.equal(audit.publishedHash, await seedHashOf(substituted));
  // The signature still verifies - that's the point. The operator can't
  // disown the statement that contradicts its own receipt.
  assert.equal(await verifySeedAckSignature(ack, publicKey), true);
});

test("an acknowledgement for a different hand is not treated as evidence about this one", async () => {
  const { privateKey } = await generateSigningKeyPair();
  const publicKey = await publicKeyFromPrivate(privateKey);
  const ack = await signSeedAck("hand-6", 0, randomHex(), privateKey);

  const audit = await auditSeedAck(ack, publicKey, { handId: "hand-7", reveals: [randomHex()] });
  assert.equal(audit.status, "not-this-hand");
});
