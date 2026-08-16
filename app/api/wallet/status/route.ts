import { desc, eq } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { onchainTransactions, wallets } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const db = getDb();
    const walletRows = await db
      .select({ address: wallets.address, verifiedAt: wallets.verifiedAt })
      .from(wallets)
      .where(eq(wallets.userId, user.id))
      .limit(1);
    const transactions = await db
      .select()
      .from(onchainTransactions)
      .where(eq(onchainTransactions.userId, user.id))
      .orderBy(desc(onchainTransactions.createdAt))
      .limit(20);

    return Response.json({ wallet: walletRows[0] ?? null, transactions });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
