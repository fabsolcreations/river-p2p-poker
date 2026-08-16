import test from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, createPublicClient, http, bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

import { activeChainConfig, ERC20_ABI, VAULT_ABI } from "../worker/chain-config.ts";
import { verifyDepositTx, submitWithdrawal, chipsToBaseUnits } from "../worker/chain.ts";

// Requires a local Hardhat node running with contracts/scripts/deploy.ts
// already applied (see contracts/README-equivalent notes in the plan) -
// `npx hardhat node` in one terminal, `npm run chain:deploy:local` in
// another, both from contracts/. worker/chain-config.ts's LOCAL addresses
// must match that deployment (they're deterministic for the default
// deployer/order, so a fresh `npx hardhat node` + deploy reproduces them
// exactly - see the comment above LOCAL in chain-config.ts).
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const OPERATOR_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat account #0, well-known/public

const userAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
const recipientAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });

const publicClient = createPublicClient({ chain: hardhat, transport: http(activeChainConfig.rpcUrl) });
const userWallet = createWalletClient({ account: userAccount, chain: hardhat, transport: http(activeChainConfig.rpcUrl) });

test("verifyDepositTx parses a real deposit transaction correctly", async () => {
  const amountChips = 250;
  const amountBaseUnits = chipsToBaseUnits(amountChips);

  const faucetHash = await userWallet.writeContract({
    address: activeChainConfig.tokenAddress,
    abi: ERC20_ABI,
    functionName: "faucet",
    args: [amountBaseUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: faucetHash });

  const approveHash = await userWallet.writeContract({
    address: activeChainConfig.tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [activeChainConfig.escrowAddress, amountBaseUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const depositHash = await userWallet.writeContract({
    address: activeChainConfig.escrowAddress,
    abi: VAULT_ABI,
    functionName: "deposit",
    args: [amountBaseUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });

  const result = await verifyDepositTx(depositHash, userAccount.address);
  assert.equal(result.ok, true);
  assert.equal(result.chips, amountChips);
  assert.equal(result.depositor.toLowerCase(), userAccount.address.toLowerCase());
});

test("verifyDepositTx rejects a deposit from a different address than expected", async () => {
  const amountChips = 50;
  const amountBaseUnits = chipsToBaseUnits(amountChips);

  await publicClient.waitForTransactionReceipt({
    hash: await userWallet.writeContract({ address: activeChainConfig.tokenAddress, abi: ERC20_ABI, functionName: "faucet", args: [amountBaseUnits] }),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await userWallet.writeContract({
      address: activeChainConfig.tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [activeChainConfig.escrowAddress, amountBaseUnits],
    }),
  });
  const depositHash = await userWallet.writeContract({
    address: activeChainConfig.escrowAddress,
    abi: VAULT_ABI,
    functionName: "deposit",
    args: [amountBaseUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });

  const result = await verifyDepositTx(depositHash, recipientAccount.address);
  assert.equal(result.ok, false);
});

test("submitWithdrawal pays out on-chain and the recipient's balance actually increases", async () => {
  const before = await publicClient.readContract({
    address: activeChainConfig.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [recipientAccount.address],
  });

  const netChips = 40;
  const ledgerEntryId = crypto.randomUUID();
  const txHash = await submitWithdrawal(recipientAccount.address, netChips, ledgerEntryId, OPERATOR_PRIVATE_KEY);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  assert.equal(receipt.status, "success");

  const after = await publicClient.readContract({
    address: activeChainConfig.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [recipientAccount.address],
  });

  assert.equal(after - before, chipsToBaseUnits(netChips));
});

test("submitWithdrawal rejects a non-operator key", async () => {
  // Hardhat account #1 - not the operator this vault was deployed with
  // (that's account #0, OPERATOR_PRIVATE_KEY above).
  const nonOperatorKey = bytesToHex(userAccount.getHdKey().privateKey);
  await assert.rejects(() => submitWithdrawal(recipientAccount.address, 1, crypto.randomUUID(), nonOperatorKey));
});
