import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";

describe("MockUSDC", () => {
  let viem: Awaited<ReturnType<typeof network.create>>["viem"];

  before(async () => {
    ({ viem } = await network.create());
  });

  it("uses 6 decimals, matching real USDC", async () => {
    const token = await viem.deployContract("MockUSDC");
    assert.equal(await token.read.decimals(), 6);
  });

  it("faucet mints up to the cap to the caller", async () => {
    const token = await viem.deployContract("MockUSDC");
    const [wallet] = await viem.getWalletClients();
    const cap = (await token.read.FAUCET_CAP([])) as bigint;

    await token.write.faucet([cap], { account: wallet.account });

    assert.equal(await token.read.balanceOf([wallet.account.address]), cap);
  });

  it("faucet rejects amounts above the cap", async () => {
    const token = await viem.deployContract("MockUSDC");
    const cap = (await token.read.FAUCET_CAP([])) as bigint;

    await viem.assertions.revertWith(token.write.faucet([cap + 1n]), "exceeds faucet cap");
  });
});
