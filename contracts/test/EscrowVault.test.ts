import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { pad, toHex } from "viem";

const REF = pad(toHex(1), { size: 32 });

type Viem = Awaited<ReturnType<typeof network.create>>["viem"];
type WalletClient = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

describe("EscrowVault", () => {
  let viem: Viem;
  let owner: WalletClient;
  let operator: WalletClient;
  let user: WalletClient;
  let outsider: WalletClient;

  before(async () => {
    ({ viem } = await network.create());
    [owner, operator, user, outsider] = await viem.getWalletClients();
  });

  async function deployVault() {
    const token = await viem.deployContract("MockUSDC");
    const vault = await viem.deployContract("EscrowVault", [
      token.address,
      operator.account.address,
      owner.account.address,
    ]);
    return { token, vault };
  }

  async function fundAndApprove(token: Awaited<ReturnType<typeof deployVault>>["token"], vault: Awaited<ReturnType<typeof deployVault>>["vault"], amount: bigint) {
    await token.write.faucet([amount], { account: user.account });
    await token.write.approve([vault.address, amount], { account: user.account });
  }

  describe("deposit", () => {
    it("pulls tokens in and emits Deposited", async () => {
      const { token, vault } = await deployVault();
      const amount = 500_000_000n; // 500 mUSDC (6 decimals)
      await fundAndApprove(token, vault, amount);

      const hash = await vault.write.deposit([amount], { account: user.account });

      await viem.assertions.emitWithArgs(hash, vault, "Deposited", [user.account.address, amount]);
      assert.equal(await token.read.balanceOf([vault.address]), amount);
      assert.equal(await token.read.balanceOf([user.account.address]), 0n);
      assert.equal(await vault.read.poolBalance(), amount);
    });

    it("reverts on a zero amount", async () => {
      const { vault } = await deployVault();
      await viem.assertions.revertWithCustomError(vault.write.deposit([0n], { account: user.account }), vault, "ZeroAmount");
    });

    it("reverts while paused", async () => {
      const { token, vault } = await deployVault();
      await fundAndApprove(token, vault, 100n);
      await vault.write.pause([], { account: owner.account });

      await viem.assertions.revertWithCustomError(vault.write.deposit([100n], { account: user.account }), vault, "EnforcedPause");
    });
  });

  describe("withdraw", () => {
    async function deployAndDeposit(amount: bigint) {
      const { token, vault } = await deployVault();
      await fundAndApprove(token, vault, amount);
      await vault.write.deposit([amount], { account: user.account });
      return { token, vault };
    }

    it("pays out and emits Withdrawn, operator-only", async () => {
      const amount = 500_000_000n;
      const { token, vault } = await deployAndDeposit(amount);

      const hash = await vault.write.withdraw([user.account.address, amount, REF], { account: operator.account });

      await viem.assertions.emitWithArgs(hash, vault, "Withdrawn", [user.account.address, amount, REF, operator.account.address]);
      assert.equal(await token.read.balanceOf([user.account.address]), amount);
      assert.equal(await vault.read.poolBalance(), 0n);
    });

    it("reverts for any non-operator caller", async () => {
      const { vault } = await deployAndDeposit(500_000_000n);

      await viem.assertions.revertWithCustomErrorWithArgs(
        vault.write.withdraw([user.account.address, 1n, REF], { account: outsider.account }),
        vault,
        "NotOperator",
        [outsider.account.address],
      );
      // The owner isn't the operator either - only the configured operator address can call this.
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([user.account.address, 1n, REF], { account: owner.account }),
        vault,
        "NotOperator",
      );
    });

    it("reverts while paused", async () => {
      const { vault } = await deployAndDeposit(500_000_000n);
      await vault.write.pause([], { account: owner.account });

      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([user.account.address, 1n, REF], { account: operator.account }),
        vault,
        "EnforcedPause",
      );
    });
  });

  describe("access control", () => {
    it("setOperator rotates the hot key, owner-only", async () => {
      const { vault } = await deployVault();

      await viem.assertions.revertWithCustomError(
        vault.write.setOperator([outsider.account.address], { account: user.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );

      const hash = await vault.write.setOperator([outsider.account.address], { account: owner.account });
      await viem.assertions.emitWithArgs(hash, vault, "OperatorUpdated", [operator.account.address, outsider.account.address]);
      const currentOperator = (await vault.read.operator()) as string;
      assert.equal(currentOperator.toLowerCase(), outsider.account.address.toLowerCase());

      // The old operator has lost access.
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([user.account.address, 1n, REF], { account: operator.account }),
        vault,
        "NotOperator",
      );
    });

    it("pause/unpause are owner-only", async () => {
      const { vault } = await deployVault();

      await viem.assertions.revertWithCustomError(vault.write.pause([], { account: user.account }), vault, "OwnableUnauthorizedAccount");

      await vault.write.pause([], { account: owner.account });
      await viem.assertions.revertWithCustomError(vault.write.unpause([], { account: user.account }), vault, "OwnableUnauthorizedAccount");
      await vault.write.unpause([], { account: owner.account });
    });
  });

  describe("reentrancy", () => {
    // ReentrantToken's transferFrom calls back into vault.deposit() before
    // returning - this is only reachable on `deposit` (no access-control
    // gate). `withdraw` is not independently testable this way: a
    // reentrant call arriving via a token callback always has the token
    // contract as msg.sender, which can never equal `operator`, so
    // `onlyOperator` already forecloses that path - see the contract's
    // NatSpec comment on ReentrantToken.
    it("deposit's nonReentrant guard blocks a hostile token's reentrant call", async () => {
      const hostileToken = await viem.deployContract("ReentrantToken");
      const vault = await viem.deployContract("EscrowVault", [
        hostileToken.address,
        operator.account.address,
        owner.account.address,
      ]);
      await hostileToken.write.mint([user.account.address, 1000n]);
      await hostileToken.write.approve([vault.address, 1000n], { account: user.account });
      await hostileToken.write.arm([vault.address]);

      await viem.assertions.revertWithCustomError(
        vault.write.deposit([100n], { account: user.account }),
        vault,
        "ReentrancyGuardReentrantCall",
      );
    });
  });
});
