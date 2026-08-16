"use client";

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { base, hardhat } from "viem/chains";
import { activeChainConfig } from "../../worker/chain-config";

// wagmi over hand-rolled `window.ethereum` calls: multiple simultaneously-
// injected wallets (MetaMask, Coinbase Wallet, etc.) are a real, well-known
// footgun for naive `window.ethereum` access (whichever extension loaded
// last silently wins) - wagmi's connector discovery handles this
// correctly, plus persists/restores the connection across reloads
// (`ssr: true` avoids a hydration mismatch from that persistence check
// running before the client is mounted).
// Written as two concrete branches (rather than a single call keyed by a
// `base | hardhat` union) so each call site's transports record lines up
// with a single literal chain id - TypeScript can't narrow `chain.id` to
// one literal through the union, but each branch alone is unambiguous.
const wagmiConfig =
  activeChainConfig.chainId === base.id
    ? createConfig({ chains: [base], transports: { [base.id]: http(activeChainConfig.rpcUrl) }, connectors: [injected()], ssr: true })
    : createConfig({ chains: [hardhat], transports: { [hardhat.id]: http(activeChainConfig.rpcUrl) }, connectors: [injected()], ssr: true });

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
