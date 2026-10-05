"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { laneRouterAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { findRoute, type Route } from "@/lib/route";
import type { Token } from "@/lib/tokens";

export function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Router settings that shape every quote. */
export function useRouterState() {
  const { deployment, chainId } = useDeployment();
  const router = deployment?.router;
  const { data } = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(router) },
    contracts: router
      ? [
          { address: router, abi: laneRouterAbi, functionName: "feeBps", chainId },
          { address: router, abi: laneRouterAbi, functionName: "paused", chainId },
          { address: router, abi: laneRouterAbi, functionName: "maxOracleDeviationBps", chainId },
        ]
      : [],
  });
  return data ? { feeBps: Number(data[0]), paused: data[1] as boolean, maxDeviationBps: Number(data[2]) } : undefined;
}

/** Wallet balances of every listed token, keyed by address. */
export function useBalances(tokens: Token[]) {
  const { address } = useAccount();
  const { chainId } = useDeployment();
  const { data } = useReadContracts({
    query: { enabled: Boolean(address) },
    contracts: tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address!], chainId })),
  });
  const out: Record<string, bigint | undefined> = {};
  tokens.forEach((t, i) => (out[t.address.toLowerCase()] = data?.[i]?.result as bigint | undefined));
  return out;
}

export function useAllowance(token: Address | undefined) {
  const { address } = useAccount();
  const { deployment, chainId } = useDeployment();
  const { data } = useReadContracts({
    query: { enabled: Boolean(address && token && deployment) },
    contracts: [{ address: token!, abi: erc20Abi, functionName: "allowance", args: [address!, deployment?.router as Address], chainId }],
  });
  return data?.[0]?.result as bigint | undefined;
}

export type Quote = Route & { oracle?: { priced: boolean; ok: boolean; valueIn: bigint; valueOut: bigint } };

/** Best route for the debounced input, refreshed every 15s, with its Chainlink check. */
export function useQuote(tokenIn: Token, tokenOut: Token, amountIn: bigint | null, feeBps: number | undefined) {
  const { deployment, chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  const debounced = useDebounced(amountIn);
  return useQuery({
    queryKey: ["quote", chainId, tokenIn.address, tokenOut.address, debounced?.toString(), feeBps],
    enabled: Boolean(client && deployment && debounced && feeBps !== undefined && tokenIn.address !== tokenOut.address),
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async (): Promise<Quote | null> => {
      const route = await findRoute({
        client: client!,
        router: deployment!.router,
        hub: deployment!.usdg,
        feeBps: feeBps!,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: debounced!,
      });
      if (!route) return null;
      try {
        const [ok, priced, valueIn, valueOut] = await client!.readContract({
          address: deployment!.router,
          abi: laneRouterAbi,
          functionName: "oracleCheck",
          args: [tokenIn.address, route.net, tokenOut.address, route.amountOut],
        });
        return { ...route, oracle: { ok, priced, valueIn, valueOut } };
      } catch {
        return route;
      }
    },
  });
}
