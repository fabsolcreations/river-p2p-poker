import { and, eq, ne, sql } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { wallets } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";
import { isWalletLinkChallengeValid, verifyWalletLinkSignature } from "../../../../worker/chain";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const body = (await request.json()) as { address?: string; message?: string; signature?: string };
    const address = (body.address ?? "").toLowerCase();
    const message = body.message ?? "";
    const signature = body.signature ?? "";

    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return Response.json({ error: "Invalid wallet address." }, { status: 400 });
    }
    if (!isWalletLinkChallengeValid(message, user.id)) {
      return Response.json({ error: "This link request has expired - try again." }, { status: 400 });
    }
    if (!/^0x[0-9a-f]+$/i.test(signature)) {
      return Response.json({ error: "Invalid signature." }, { status: 400 });
    }

    const valid = await verifyWalletLinkSignature(address as `0x${string}`, message, signature as `0x${string}`);
    if (!valid) {
      return Response.json({ error: "Signature does not match the claimed address." }, { status: 400 });
    }

    const db = getDb();
    const takenByOther = await db
      .select({ userId: wallets.userId })
      .from(wallets)
      .where(and(eq(wallets.address, address), ne(wallets.userId, user.id)))
      .limit(1);
    if (takenByOther.length > 0) {
      return Response.json({ error: "That wallet is already linked to another account." }, { status: 409 });
    }

    await db
      .insert(wallets)
      .values({ id: crypto.randomUUID(), userId: user.id, address })
      .onConflictDoUpdate({ target: wallets.userId, set: { address, verifiedAt: sql`CURRENT_TIMESTAMP` } });

    return Response.json({ address });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
