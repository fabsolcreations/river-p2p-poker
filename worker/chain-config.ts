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
export const WITHDRAWAL_FEE_BPS = 50; // 0.5%
export const MIN_WITHDRAWAL_FEE_CHIPS = 1;

export function computeWithdrawalFee(chips: number): number {
  return Math.max(MIN_WITHDRAWAL_FEE_CHIPS, Math.ceil((chips * WITHDRAWAL_FEE_BPS) / 10000));
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
