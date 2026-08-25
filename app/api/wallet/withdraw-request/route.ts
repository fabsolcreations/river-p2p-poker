import { and, eq, gte, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { friendlyDbError, getDb } from "../../../../db";
import { ledgerEntries, onchainTransactions, users, wallets } from "../../../../db/schema";
import { getSessionUser } from "../../../../worker/auth";
import { chipsToBaseUnits, submitWithdrawal } from "../../../../worker/chain";
import { computeWithdrawal, MIN_WITHDRAWAL_CHIPS, type WithdrawalFeeMode } from "../../../../worker/chain-config";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
    const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY;
    if (!operatorPrivateKey) {
      return Response.json({ error: "Withdrawals are not configured yet - OPERATOR_PRIVATE_KEY is unset." }, { status: 503 });
    }

    const body = (await request.json()) as { amount?: number; feeMode?: WithdrawalFeeMode };
    const inputAmount = Math.trunc(body.amount ?? 0);
    const feeMode: WithdrawalFeeMode = body.feeMode === "net" ? "net" : "gross";
    if (!Number.isFinite(inputAmount) || inputAmount < MIN_WITHDRAWAL_CHIPS) {
      return Response.json({ error: `Minimum withdrawal is ${MIN_WITHDRAWAL_CHIPS} chips.` }, { status: 400 });
    }
    // "gross": chips = the amount typed (fee comes out of it).
    // "net": chips = the debited/gross-up total that makes the typed
    // amount land exactly, once the fee is taken - see computeWithdrawal.
    const { debited: chips, fee, net: netChips } = computeWithdrawal(inputAmount, feeMode);

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

    const outcome = await submitWithdrawal(address as `0x${string}`, netChips, ledgerEntryId, operatorPrivateKey);

    // Only refund when the chain says this refId definitively never paid.
    // Refunding on a mere error would double-spend the house every time an
    // RPC call times out on a transaction that actually landed - see
    // submitWithdrawal's WithdrawalOutcome for the full reasoning.
    if (outcome.status === "not-paid") {
      await db.update(users).set({ balance: sql`${users.balance} + ${chips}` }).where(eq(users.id, user.id));
      await db.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId: user.id, delta: chips, reason: "crypto_withdraw_failed_refund" });
      return Response.json({ error: `Withdrawal failed and was refunded: ${outcome.error}` }, { status: 502 });
    }

    // Broadcast but unresolved. The chips stay debited on purpose: the
    // payout may well have gone through, and the vault's usedRefIds makes
    // this recoverable later without ever risking a double payout (a retry
    // with the same ledgerEntryId reverts if it already paid).
    if (outcome.status === "unknown") {
      if (outcome.hash) {
        try {
          await db.insert(onchainTransactions).values({
            txHash: outcome.hash,
            userId: user.id,
            direction: "withdrawal",
            chips: netChips,
            tokenBaseUnits: chipsToBaseUnits(netChips).toString(),
            ledgerEntryId,
            status: "pending",
          });
        } catch {
          // Best-effort - the ledger entry above already records the debit.
        }
      }
      return Response.json(
        {
          pending: true,
          txHash: outcome.hash,
          ledgerEntryId,
          error:
            "Your withdrawal was submitted but couldn't be confirmed yet. It has not been refunded, because it may have already paid out - check the transaction before retrying.",
        },
        { status: 202 },
      );
    }

    const txHash = outcome.hash;

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
