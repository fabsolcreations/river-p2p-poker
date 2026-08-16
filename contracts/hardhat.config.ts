import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

// Local Hardhat network (`npx hardhat node`) needs no secrets - used for all
// automated contract tests and the sandboxed-browser verification pass.
// `base`/`baseSepolia` read real values from env vars via configVariable so
// nothing sensitive (an RPC URL, and especially a private key) ever lands in
// this committed file - fill in contracts/.env (gitignored) from
// contracts/.env.example before running anything against a real network.
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: "0.8.28",
  networks: {
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    baseSepolia: {
      type: "http",
      chainType: "l1",
      chainId: 84532,
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    base: {
      type: "http",
      chainType: "l1",
      chainId: 8453,
      url: configVariable("BASE_MAINNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
