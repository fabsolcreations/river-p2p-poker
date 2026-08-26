// Non-secret, source-controlled chain config for EscrowVault.sol
// (contracts/contracts/EscrowVault.sol). Addresses and RPC URLs are
// ordinary config, not secrets - only OPERATOR_PRIVATE_KEY (see
// worker/chain.ts, .dev.vars.example) is sensitive. Plain module, safe to
// import from both server (worker/chain.ts) and client (React) code -
// mirrors the existing worker/ <-> app/ cross-import precedent already
// used by worker/auth.ts importing app/play/proof.ts.

export type ChainKey = "local" | "base";

export interface ChainNetworkConfig {
  chainId: number;
  rpcUrl: string;
  escrowAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  /** Confirmations required before a deposit is credited off-chain. */
  minConfirmations: number;
}

// Deterministic addresses from deploying contracts/scripts/deploy.ts
// against a fresh `npx hardhat node` with its default first account -
// same deployer + same deploy order always produces the same addresses.
// Re-deploy and update these two lines if EscrowVault.sol/MockUSDC.sol
// change, or if you redeploy for any other reason.
const LOCAL: ChainNetworkConfig = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  tokenAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  escrowAddress: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  // A local dev chain has no reorgs and mines instantly, so waiting would
  // just make testing slower for no safety gain.
  minConfirmations: 0,
};

// Real Base mainnet. Left as placeholders on purpose - fill these in
// yourself after a real `npx hardhat run scripts/deploy.ts --network base`
// (see contracts/.env.example). Do not trust a hardcoded USDC address
// pulled from memory for a fund-custody contract; verify it against
// Base's own docs/explorer before setting it here.
const BASE: ChainNetworkConfig = {
  chainId: 8453,
  rpcUrl: "", // e.g. an Alchemy/Infura/base.org RPC URL
  tokenAddress: "0x0000000000000000000000000000000000000000",
  escrowAddress: "0x0000000000000000000000000000000000000000",
  // Blocks to wait before treating a deposit as final. Crediting at depth 0
  // means a reorg can un-mine the deposit while the off-chain balance stays
  // credited - free chips. Base builds on Ethereum finality, so a handful of
  // blocks covers ordinary reorgs; raise it if you ever see one deeper.
  minConfirmations: 12,
};

export const NETWORKS: Record<ChainKey, ChainNetworkConfig> = { local: LOCAL, base: BASE };

// Which network worker/chain.ts and the frontend talk to. Flip to "base"
// once BASE's fields above are filled in with real, verified values -
// nothing else in this file needs to change to do that.
export const ACTIVE_NETWORK: ChainKey = "local";

export const activeChainConfig: ChainNetworkConfig = NETWORKS[ACTIVE_NETWORK];

// 1 chip (users.balance in db/schema.ts) = 1 whole token unit.
export const TOKEN_DECIMALS = 6;
export const CHIPS_TO_BASE_UNITS = 10n ** BigInt(TOKEN_DECIMALS);

// Withdrawal fee approximates the real gas cost of the operator's payout
// transaction (the "tiny fraction of the pot goes towards gas" detail this
// whole design is built around) - a plain off-chain percentage, not
// contract logic, so it's adjustable without a redeploy.
export const MIN_WITHDRAWAL_CHIPS = 10;
export const WITHDRAWAL_FEE_BPS = 100; // 1%
export const MIN_WITHDRAWAL_FEE_CHIPS = 1;

export type WithdrawalFeeMode = "gross" | "net";

// "gross": the amount typed is the total debited from the balance; the fee
// comes OUT of it (withdraw 100 -> pay 100, receive 99).
export function feeForGrossAmount(amount: number): number {
  return Math.max(MIN_WITHDRAWAL_FEE_CHIPS, Math.ceil((amount * WITHDRAWAL_FEE_BPS) / 10000));
}

// "net": the amount typed is what should land in the wallet; the fee is
// grossed up on top so the net received matches exactly (receive 100 ->
// pay 101.01..., debited/withdrawn rounds up to cover the fee in full).
// Standard "who eats the fee" gross-up: debited * (1 - rate) = net, so
// debited = net / (1 - rate) - this is the same math payment processors
// use for a "recipient gets exactly X" toggle.
export function debitForNetAmount(net: number): { debited: number; fee: number } {
  const rate = WITHDRAWAL_FEE_BPS / 10000;
  const proportionalDebited = Math.ceil(net / (1 - rate));
  const proportionalFee = proportionalDebited - net;
  if (proportionalFee >= MIN_WITHDRAWAL_FEE_CHIPS) return { debited: proportionalDebited, fee: proportionalFee };
  // Below the flat-fee floor, the proportional formula would undershoot it -
  // fall back to the flat minimum fee added on top instead.
  return { debited: net + MIN_WITHDRAWAL_FEE_CHIPS, fee: MIN_WITHDRAWAL_FEE_CHIPS };
}

export function computeWithdrawal(amount: number, mode: WithdrawalFeeMode): { debited: number; fee: number; net: number } {
  if (mode === "gross") {
    const fee = feeForGrossAmount(amount);
    return { debited: amount, fee, net: amount - fee };
  }
  const { debited, fee } = debitForNetAmount(amount);
  return { debited, fee, net: amount };
}

export const VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "refId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "poolBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Authoritative answer to "did this exact withdrawal already pay out?" -
    // what submitWithdrawal falls back to whenever waiting for a receipt
    // fails ambiguously. See EscrowVault.sol's usedRefIds.
    type: "function",
    name: "usedRefIds",
    stateMutability: "view",
    inputs: [{ name: "refId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "refId", type: "bytes32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;
