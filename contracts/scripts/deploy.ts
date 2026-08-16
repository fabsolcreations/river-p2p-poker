import { network } from "hardhat";

// Deploys MockUSDC + EscrowVault to a local Hardhat node ("localhost" or
// the default in-process network), or EscrowVault against a real USDC
// address on baseSepolia/base. Run with:
//   npx hardhat run scripts/deploy.ts --network localhost
//   npx hardhat run scripts/deploy.ts --network baseSepolia
//   npx hardhat run scripts/deploy.ts --network base
async function main() {
  const { viem, networkName } = await network.connect();
  const [deployer] = await viem.getWalletClients();

  const isLocal = networkName !== "baseSepolia" && networkName !== "base";

  let tokenAddress: `0x${string}`;
  if (isLocal) {
    const mockUsdc = await viem.deployContract("MockUSDC");
    tokenAddress = mockUsdc.address;
    console.log(`MockUSDC deployed: ${mockUsdc.address}`);
  } else {
    const envToken = process.env.USDC_ADDRESS;
    if (!envToken) {
      throw new Error(
        "Set USDC_ADDRESS to the real USDC contract address on this network before deploying " +
          "(verify it yourself from Base's own docs/explorer - do not trust a hardcoded guess for a fund-custody contract).",
      );
    }
    tokenAddress = envToken as `0x${string}`;
  }

  // Defaults to the deployer for a quick local smoke test. For a real
  // network, set these explicitly - the operator is the hot key
  // worker/chain.ts will hold, which should NOT be the same key that
  // deployed/owns the contract.
  const operatorAddress = (process.env.OPERATOR_ADDRESS ?? deployer.account.address) as `0x${string}`;
  const ownerAddress = (process.env.OWNER_ADDRESS ?? deployer.account.address) as `0x${string}`;

  const vault = await viem.deployContract("EscrowVault", [tokenAddress, operatorAddress, ownerAddress]);

  console.log("---");
  console.log(`Network:  ${networkName}`);
  console.log(`Token:    ${tokenAddress}`);
  console.log(`Operator: ${operatorAddress}`);
  console.log(`Owner:    ${ownerAddress}`);
  console.log(`Vault:    ${vault.address}`);
  console.log("---");
  console.log("Copy the Token/Vault addresses into worker/chain-config.ts.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
