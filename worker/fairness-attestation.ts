import { sha256 } from "../app/play/proof.ts";

/**
 * Signed pre-deal acknowledgements - the piece that turns "the player can
 * tell they were cheated" into "the player can prove it."
 *
 * The commit-reveal scheme in table-engine.ts already stops the server
 * grinding the shuffle: its own seed is committed before it sees any client
 * seed, and fallback seeds are pinned to that commitment. What it cannot do
 * on its own is stop the server *substituting* a seed for a seat that really
 * did send one. That seat's browser knows what it sent, so the player can
 * see their contribution missing from the receipt - but they hold no
 * evidence anyone else can check, so it comes down to their word.
 *
 * The fix is for the server to sign what it received, before the hand is
 * dealt: "for hand H, seat N, I hold a seed hashing to X." A player who
 * keeps that signature and later finds a receipt for hand H where seat N's
 * seed hashes to something else holds two mutually contradictory statements,
 * one of them signed by the operator. That's non-repudiable - it doesn't
 * depend on trusting the player, the operator, or this codebase.
 *
 * Deliberately no `cloudflare:workers` import: the signing key is threaded
 * in as a parameter (same convention as worker/chain.ts) so this module
 * stays importable by the plain-Node test runner.
 *
 * ECDSA P-256 rather than Ed25519 purely for reach - it's available in the
 * Workers runtime, in Node's webcrypto, and in every browser that would
 * verify one of these client-side.
 */

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

export type SeedAck = {
  version: "RIVER_SEED_ACK_V1";
  handId: string;
  seat: number;
  /** sha256 of the raw seed the server received for this seat. */
  seedHash: string;
  /** Base64 ECDSA P-256 / SHA-256 signature over the canonical payload. */
  signature: string;
};

export type PublicKeyJwk = JsonWebKey & { kty: string; crv: string; x: string; y: string };

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The exact bytes that get signed. Pipe-delimited and version-tagged, the
 * same convention the transcript and commitment hashes already use. Every
 * field is fixed-format (hex hash, integer seat, uuid-shaped hand id), so no
 * field can contain a delimiter and shift the meaning of another.
 */
function ackPayload(handId: string, seat: number, seedHash: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(`RIVER_SEED_ACK_V1|${handId}|seat_${seat}|${seedHash}`));
}

// crypto.subtle wants a BufferSource backed by a plain ArrayBuffer; a
// Uint8Array can be backed by a SharedArrayBuffer as far as the types are
// concerned, so copy into one that definitely isn't.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export async function seedHashOf(seed: string): Promise<string> {
  return sha256(`RIVER_SEED_ACK_HASH_V1|${seed}`);
}

/** Generates a fresh operator signing key. Run once; keep the private half secret. */
export async function generateSigningKeyPair(): Promise<{ privateKey: string; publicKey: PublicKeyJwk }> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as PublicKeyJwk;
  return { privateKey: base64Encode(new TextEncoder().encode(JSON.stringify(privateJwk))), publicKey: publicJwk };
}

async function importPrivateKey(encodedPrivateKey: string): Promise<CryptoKey> {
  const jwk = JSON.parse(new TextDecoder().decode(base64Decode(encodedPrivateKey))) as JsonWebKey;
  return crypto.subtle.importKey("jwk", jwk, ALGORITHM, false, ["sign"]);
}

/** Derives the shareable public half from the stored private key. */
export async function publicKeyFromPrivate(encodedPrivateKey: string): Promise<PublicKeyJwk> {
  const jwk = JSON.parse(new TextDecoder().decode(base64Decode(encodedPrivateKey))) as JsonWebKey;
  // A JWK private key already carries the public coordinates; dropping the
  // secret scalar leaves exactly the public key.
  const publicJwk: JsonWebKey = { ...jwk };
  delete publicJwk.d;
  publicJwk.key_ops = ["verify"];
  return publicJwk as PublicKeyJwk;
}

export async function signSeedAck(
  handId: string,
  seat: number,
  seed: string,
  encodedPrivateKey: string,
): Promise<SeedAck> {
  const seedHash = await seedHashOf(seed);
  const key = await importPrivateKey(encodedPrivateKey);
  const signature = await crypto.subtle.sign(SIGN_PARAMS, key, ackPayload(handId, seat, seedHash));
  return { version: "RIVER_SEED_ACK_V1", handId, seat, seedHash, signature: base64Encode(new Uint8Array(signature)) };
}

/** True only if this ack was really issued by the holder of the private key. */
export async function verifySeedAckSignature(ack: SeedAck, publicKey: PublicKeyJwk): Promise<boolean> {
  if (ack?.version !== "RIVER_SEED_ACK_V1") return false;
  try {
    const key = await crypto.subtle.importKey("jwk", publicKey, ALGORITHM, false, ["verify"]);
    return await crypto.subtle.verify(
      SIGN_PARAMS,
      key,
      toArrayBuffer(base64Decode(ack.signature)),
      ackPayload(ack.handId, ack.seat, ack.seedHash),
    );
  } catch {
    return false;
  }
}

export type AckAudit =
  | { status: "ok" }
  | { status: "not-this-hand" }
  | { status: "bad-signature" }
  | { status: "no-reveal" }
  /** The signed statement and the published receipt disagree - proof of substitution. */
  | { status: "seed-substituted"; acknowledgedHash: string; publishedHash: string };

/**
 * Audits one kept acknowledgement against the receipt for the hand it names.
 * A "seed-substituted" result is the operator's own signature contradicting
 * the operator's own receipt.
 */
export async function auditSeedAck(
  ack: SeedAck,
  publicKey: PublicKeyJwk,
  bundle: { handId: string; reveals: (string | null)[] },
): Promise<AckAudit> {
  if (!(await verifySeedAckSignature(ack, publicKey))) return { status: "bad-signature" };
  if (bundle.handId !== ack.handId) return { status: "not-this-hand" };
  const reveal = bundle.reveals[ack.seat];
  if (typeof reveal !== "string") return { status: "no-reveal" };
  const publishedHash = await seedHashOf(reveal);
  if (publishedHash !== ack.seedHash) {
    return { status: "seed-substituted", acknowledgedHash: ack.seedHash, publishedHash };
  }
  return { status: "ok" };
}
