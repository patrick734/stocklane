"use client";

import { useAccount } from "wagmi";
import { deployments, type Deployment } from "@/generated/deployments";
import { defaultChainId, wagmiConfig } from "./wagmi";

export type AppChainId = (typeof wagmiConfig)["chains"][number]["id"];

/// The deployment to show, and the chain it lives on. Reads and writes must target this chain, not
/// whatever network the wallet happens to be on, or they hit addresses that don't exist there.
export function useDeployment(): { deployment: Deployment | null; chainId: AppChainId } {
  const { chainId: walletChain } = useAccount();
  const chainId = (walletChain && deployments[walletChain] ? walletChain : defaultChainId) as AppChainId;
  return { deployment: deployments[chainId] ?? null, chainId };
}
