"use client";

import { erc20Abi, zeroAddress, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { drawdownRetireAbi, laneRouterAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";

const timelockAbi = [{ type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const ownerAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** Everything the Burn and Safety pages show, read live from the contracts. */
export function useProtocol() {
  const { deployment: d, chainId } = useDeployment();
  const { data } = useReadContracts({
    query: { enabled: Boolean(d) },
    contracts: d
      ? [
          { address: d.drawdownRetire, abi: drawdownRetireAbi, functionName: "totalRetired", chainId },
          { address: d.drawdownRetire, abi: drawdownRetireAbi, functionName: "laneToken", chainId },
          { address: d.drawdownRetire, abi: drawdownRetireAbi, functionName: "halted", chainId },
          { address: d.drawdownRetire, abi: drawdownRetireAbi, functionName: "lastDrawdown", chainId },
          { address: d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [d.drawdownRetire], chainId },
          { address: d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [d.feeRouter], chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "feeBps", chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "MAX_FEE_BPS", chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "maxOracleDeviationBps", chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "paused", chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "hasRole", args: ["0x" + "00".repeat(32) as `0x${string}`, d.timelock], chainId },
          { address: d.router, abi: laneRouterAbi, functionName: "hasRole", args: ["0x" + "00".repeat(32) as `0x${string}`, d.deployer], chainId },
          { address: d.timelock, abi: timelockAbi, functionName: "getMinDelay", chainId },
          { address: d.oracle, abi: ownerAbi, functionName: "owner", chainId },
          { address: d.feeRouter, abi: ownerAbi, functionName: "owner", chainId },
        ]
      : [],
  });
  const r = (i: number) => data?.[i]?.result;
  const laneToken = r(1) as Address | undefined;
  return {
    d,
    totalRetired: r(0) as bigint | undefined,
    laneToken: laneToken && laneToken !== zeroAddress ? laneToken : null,
    laneTokenKnown: laneToken !== undefined,
    halted: r(2) as boolean | undefined,
    lastDrawdown: r(3) as bigint | undefined,
    usdgWaiting: r(4) !== undefined && r(5) !== undefined ? (r(4) as bigint) + (r(5) as bigint) : undefined,
    feeBps: r(6) as number | undefined,
    maxFeeBps: r(7) as number | undefined,
    maxDeviationBps: r(8) as number | undefined,
    paused: r(9) as boolean | undefined,
    timelockIsAdmin: r(10) as boolean | undefined,
    deployerIsAdmin: r(11) as boolean | undefined,
    delay: r(12) as bigint | undefined,
    oracleOwner: r(13) as Address | undefined,
    feeRouterOwner: r(14) as Address | undefined,
  };
}
