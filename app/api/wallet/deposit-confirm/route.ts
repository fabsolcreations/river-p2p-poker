import { eq, sql } from "drizzle-orm";
import { friendlyDbError, getDb } from "../../../../db";
import { ledgerEntries, onchainTransactions, users, wallets } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";
import { chipsToBaseUnits, verifyDepositTx } from "../../../../worker/chain";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

    const body = (await request.json()) as { txHash?: string };
    const txHash = (body.txHash ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      return Response.json({ error: "Invalid transaction hash." }, { status: 400 });
    }

    const db = getDb();

    // Idempotency check - txHash is the primary key, so a retried/duplicate
    // confirmation of the same deposit is a safe no-op, not a double-credit.
    const existing = await db.select().from(onchainTransactions).where(eq(onchainTransactions.txHash, txHash)).limit(1);
    if (existing.length > 0) {
      return Response.json({ ok: true, chips: existing[0].chips, alreadyProcessed: true });
    }

    const walletRows = await db.select({ address: wallets.address }).from(wallets).where(eq(wallets.userId, user.id)).limit(1);
    const linkedAddress = walletRows[0]?.address;
    if (!linkedAddress) {
      return Response.json({ error: "Link a wallet before confirming a deposit." }, { status: 400 });
    }

    const verification = await verifyDepositTx(txHash as `0x${string}`, linkedAddress as `0x${string}`);
    if (!verification.ok) {
      return Response.json({ error: verification.error }, { status: 400 });
    }

    const ledgerEntryId = crypto.randomUUID();
    try {
      // All three writes land together (or not at all) via D1's batch -
      // sidesteps any ordering issue between the ledgerEntryId foreign key
      // and the row that references it.
      await db.batch([
        db.insert(ledgerEntries).values({ id: ledgerEntryId, userId: user.id, delta: verification.chips, reason: "crypto_deposit" }),
        db.insert(onchainTransactions).values({
          txHash,
          userId: user.id,
          direction: "deposit",
          chips: verification.chips,
          tokenBaseUnits: chipsToBaseUnits(verification.chips).toString(),
          ledgerEntryId,
          status: "confirmed",
        }),
        db.update(users).set({ balance: sql`${users.balance} + ${verification.chips}` }).where(eq(users.id, user.id)),
      ]);
    } catch {
      // Lost a race against a concurrent identical request - the other
      // request's insert already landed (txHash PK conflict), so this is a
      // safe no-op rather than a real failure.
      const raced = await db.select().from(onchainTransactions).where(eq(onchainTransactions.txHash, txHash)).limit(1);
      if (raced.length > 0) return Response.json({ ok: true, chips: raced[0].chips, alreadyProcessed: true });
      throw new Error("Deposit could not be recorded.");
    }

    return Response.json({ ok: true, chips: verification.chips });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
