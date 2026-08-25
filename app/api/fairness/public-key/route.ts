import { env } from "cloudflare:workers";
import { publicKeyFromPrivate } from "../../../../worker/fairness-attestation";

/**
 * The operator's public signing key, for checking the seed acknowledgements
 * handed out at the table (see worker/fairness-attestation.ts).
 *
 * Worth pinning rather than fetching fresh at audit time: an operator that
 * could swap this key at will could also disown any acknowledgement it had
 * signed, which is exactly the deniability the signatures exist to remove.
 * Save the key the first time you see it and compare later.
 */
export async function GET() {
  const signingKey = env.FAIRNESS_SIGNING_KEY;
  if (!signingKey) {
    return Response.json(
      {
        configured: false,
        error:
          "No operator signing key is configured, so seed acknowledgements aren't being issued. Hands are still committed and independently verifiable - only the extra proof-of-substitution step is unavailable.",
      },
      { status: 503 },
    );
  }
  try {
    return Response.json({
      configured: true,
      algorithm: "ECDSA P-256 / SHA-256",
      publicKey: await publicKeyFromPrivate(signingKey),
      payloadFormat: "RIVER_SEED_ACK_V1|{handId}|seat_{seat}|{seedHash}",
      seedHashFormat: "sha256('RIVER_SEED_ACK_HASH_V1|' + seed)",
    });
  } catch {
    return Response.json({ configured: false, error: "The configured signing key could not be read." }, { status: 500 });
  }
}
