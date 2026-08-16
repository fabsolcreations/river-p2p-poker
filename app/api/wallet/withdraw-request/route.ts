import { and, eq, gte, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { friendlyDbError, getDb } from "../../../../db";
import { ledgerEntries, onchainTransactions, users, wallets } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";
import { chipsToBaseUnits, submitWithdrawal } from "../../../../worker/chain";
import { computeWithdrawalFee, MIN_WITHDRAWAL_CHIPS } from "../../../../worker/chain-config";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY;
    if (!operatorPrivateKey) {
      return Response.json({ error: "Withdrawals are not configured yet - OPERATOR_PRIVATE_KEY is unset." }, { status: 503 });
    }

    const body = (await request.json()) as { chips?: number };
    const chips = Math.trunc(body.chips ?? 0);
    if (!Number.isFinite(chips) || chips < MIN_WITHDRAWAL_CHIPS) {
      return Response.json({ error: `Minimum withdrawal is ${MIN_WITHDRAWAL_CHIPS} chips.` }, { status: 400 });
    }

    const db = getDb();
    const walletRows = await db.select({ address: wallets.address }).from(wallets).where(eq(wallets.userId, user.id)).limit(1);
    const address = walletRows[0]?.address;
    if (!address) {
      return Response.json({ error: "Link a wallet before withdrawing." }, { status: 400 });
    }

    // Debit first, atomically - the same conditional-update pattern
    // worker/poker-table.ts's buyIn() uses, so two concurrent withdrawal
    // requests can't double-spend one balance.
    const debited = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${chips}` })
      .where(and(eq(users.id, user.id), gte(users.balance, chips)))
      .returning({ balance: users.balance });
    if (debited.length === 0) {
      return Response.json({ error: "Insufficient balance." }, { status: 400 });
    }

    const ledgerEntryId = crypto.randomUUID();
    await db.insert(ledgerEntries).values({ id: ledgerEntryId, userId: user.id, delta: -chips, reason: "crypto_withdraw" });

    const fee = computeWithdrawalFee(chips);
    const netChips = chips - fee;

    let txHash: `0x${string}`;
    try {
      txHash = await submitWithdrawal(address as `0x${string}`, netChips, ledgerEntryId, operatorPrivateKey);
    } catch (error) {
      // The on-chain payout genuinely failed (RPC down, operator out of
      // gas, reverted). Unlike worker/poker-table.ts's best-effort
      // cashOut, this has a real external failure mode - silently eating
      // the user's chips here would be a real bug, so refund in full.
      await db.update(users).set({ balance: sql`${users.balance} + ${chips}` }).where(eq(users.id, user.id));
      await db.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId: user.id, delta: chips, reason: "crypto_withdraw_failed_refund" });
      const message = error instanceof Error ? error.message : "The on-chain payout failed.";
      return Response.json({ error: `Withdrawal failed and was refunded: ${message}` }, { status: 502 });
    }

    // The payout already succeeded on-chain by this point - recording it
    // is best-effort from here on (matching cashOut's convention). A
    // failure below must NOT trigger a refund; the money has genuinely
    // moved regardless of whether this bookkeeping write lands.
    try {
      await db.insert(onchainTransactions).values({
        txHash,
        userId: user.id,
        direction: "withdrawal",
        chips: netChips,
        tokenBaseUnits: chipsToBaseUnits(netChips).toString(),
        ledgerEntryId,
        status: "confirmed",
      });
    } catch {
      // Best-effort - the on-chain payout is the source of truth here.
    }

    return Response.json({ ok: true, txHash, chips, fee, netChips });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
