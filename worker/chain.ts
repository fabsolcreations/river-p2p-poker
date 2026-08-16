import { createPublicClient, createWalletClient, http, getAddress, decodeEventLog, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, hardhat } from "viem/chains";
import { activeChainConfig, ERC20_ABI, VAULT_ABI, CHIPS_TO_BASE_UNITS } from "./chain-config.ts";

// Deliberately no `import { env } from "cloudflare:workers"` here - the
// operator private key is threaded in as a parameter (see
// submitWithdrawal below) instead of read from a hidden global. That
// keeps this whole module importable from plain Node (tests/chain.test.mjs
// runs outside the Workers runtime, same as every other tests/*.test.mjs
// in this project) - only the one call site that actually has real Workers
// `env` access (app/api/wallet/withdraw-request/route.ts) needs to know
// where the secret comes from.
const chain = activeChainConfig.chainId === base.id ? base : hardhat;

function getPublicClient() {
  return createPublicClient({ chain, transport: http(activeChainConfig.rpcUrl) });
}

function getOperatorWalletClient(operatorPrivateKey: string) {
  const account = privateKeyToAccount(operatorPrivateKey as `0x${string}`);
  return createWalletClient({ account, chain, transport: http(activeChainConfig.rpcUrl) });
}

export function chipsToBaseUnits(chips: number): bigint {
  return BigInt(chips) * CHIPS_TO_BASE_UNITS;
}

export function baseUnitsToChips(units: bigint): number {
  return Number(units / CHIPS_TO_BASE_UNITS);
}

// A UUID's 32 hex digits (with hyphens stripped) are 16 bytes - left-padded
// into a bytes32 so a withdrawal's on-chain `refId` is directly auditable
// against the exact db/schema.ts `ledgerEntries.id` row that authorized it,
// without needing database access.
export function ledgerEntryIdToRefId(ledgerEntryId: string): `0x${string}` {
  const hex = ledgerEntryId.replace(/-/g, "");
  return pad(`0x${hex}` as `0x${string}`, { size: 32 });
}

export type DepositVerification =
  | { ok: true; chips: number; depositor: `0x${string}` }
  | { ok: false; error: string };

// Reads the transaction receipt directly from the chain and confirms it's
// a real Deposited event from the escrow contract, sent by the expected
// address - never trusts anything the client claims about the deposit
// beyond the transaction hash itself.
export async function verifyDepositTx(txHash: `0x${string}`, expectedDepositor: `0x${string}`): Promise<DepositVerification> {
  const client = getPublicClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, error: "Transaction not found." };
  }
  if (receipt.status !== "success") {
    return { ok: false, error: "Transaction did not succeed on-chain." };
  }
  if (!receipt.to || getAddress(receipt.to) !== getAddress(activeChainConfig.escrowAddress)) {
    return { ok: false, error: "Transaction was not sent to the escrow contract." };
  }

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(activeChainConfig.escrowAddress)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics, eventName: "Deposited" });
    } catch {
      continue;
    }
    if (getAddress(decoded.args.depositor) !== getAddress(expectedDepositor)) {
      return { ok: false, error: "Deposit was made from a different address than your linked wallet." };
    }
    return { ok: true, chips: baseUnitsToChips(decoded.args.amount), depositor: decoded.args.depositor };
  }

  return { ok: false, error: "No Deposited event found in this transaction." };
}

// Operator-signed payout. Simulates first (surfaces a revert - e.g. an
// underfunded pool - before spending gas), then broadcasts, then waits for
// the receipt and throws if it actually reverted on-chain - the caller
// (app/api/wallet/withdraw-request/route.ts) relies on this throwing for
// any real failure so it can issue a compensating refund.
export async function submitWithdrawal(
  to: `0x${string}`,
  netChips: number,
  ledgerEntryId: string,
  operatorPrivateKey: string,
): Promise<`0x${string}`> {
  const wallet = getOperatorWalletClient(operatorPrivateKey);
  const publicClient = getPublicClient();
  const refId = ledgerEntryIdToRefId(ledgerEntryId);
  const amount = chipsToBaseUnits(netChips);

  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: activeChainConfig.escrowAddress,
    abi: VAULT_ABI,
    functionName: "withdraw",
    args: [to, amount, refId],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Withdrawal transaction reverted (${hash}).`);
  }
  return hash;
}

// EOA + ERC-1271 (smart contract wallet) signature verification - a
// challenge message signed by the claimed address proves control of it
// without ever touching a password or private key.
export async function verifyWalletLinkSignature(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean> {
  const client = getPublicClient();
  return client.verifyMessage({ address, message, signature });
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Stateless wallet-link challenge - no server-side nonce table needed.
// Verification just checks the recovered signer plus that this exact
// `user:`/`issuedAt:` pair is fresh and matches the caller's own session,
// so a signed message can't be replayed against a different account or
// after the freshness window closes.
export function buildWalletLinkChallenge(userId: string): string {
  return `RIVER wallet link\nuser:${userId}\nnonce:${crypto.randomUUID()}\nissuedAt:${Date.now()}`;
}

export function isWalletLinkChallengeValid(message: string, userId: string): boolean {
  const fields: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (fields.user !== userId) return false;
  const issuedAt = Number(fields.issuedAt);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  return age >= 0 && age <= CHALLENGE_TTL_MS;
}

export { ERC20_ABI, VAULT_ABI };
