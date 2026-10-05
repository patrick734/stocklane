import { zeroAddress, type Address, type PublicClient } from "viem";
import { catalog } from "@/generated/catalog";

// Route finding runs in the browser: it asks LaneRouter.quote (an eth_call that simulates the pool swaps) for
// every candidate path, then for splits between the two best independent paths. The router executes exactly the
// legs the user signs, and the user's minimum output protects the result.

export type Hop = { kind: 0 | 1; tokenOut: Address; fee: number; tickSpacing: number; hooks: Address };
export type Leg = { amountIn: bigint; hops: Hop[] };
export type Path = { hops: Hop[]; label: string };
export type Route = {
  legs: Leg[];
  amountOut: bigint;
  fee: bigint;
  net: bigint;
  parts: { label: string; share: number }[];
  compared: number;
};

const LEG = {
  type: "tuple[]",
  name: "legs",
  components: [
    { name: "amountIn", type: "uint256" },
    {
      name: "hops",
      type: "tuple[]",
      components: [
        { name: "kind", type: "uint8" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
  ],
} as const;

// `quote` is not a view (it simulates swaps and reverts them), but it is only ever eth_call'ed, so it is typed
// as one here for viem's readContract.
export const quoteAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      LEG,
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
] as const;

const SPLITS = [70, 50, 30];

function singleHops(tokenOut: Address): Path[] {
  const v3 = catalog.uniswap.v3Fees.map((fee) => ({
    label: `Uniswap v3 ${fee / 10_000}%`,
    hops: [{ kind: 0 as const, tokenOut, fee, tickSpacing: 0, hooks: zeroAddress }],
  }));
  const v4 = catalog.uniswap.v4HooklessPools.map((p) => ({
    label: `Uniswap v4 ${p.fee / 10_000}%`,
    hops: [{ kind: 1 as const, tokenOut, fee: p.fee, tickSpacing: p.tickSpacing, hooks: zeroAddress }],
  }));
  return [...v3, ...v4];
}

const hopKey = (from: Address, h: Hop) => `${h.kind}:${[from.toLowerCase(), h.tokenOut.toLowerCase()].sort().join("-")}:${h.fee}:${h.tickSpacing}:${h.hooks}`;

function pools(tokenIn: Address, p: Path) {
  const keys: string[] = [];
  let from = tokenIn;
  for (const h of p.hops) {
    keys.push(hopKey(from, h));
    from = h.tokenOut;
  }
  return keys;
}

export function feeFor(amountIn: bigint, feeBps: number) {
  return (amountIn * BigInt(feeBps)) / 10_000n;
}

async function quoteAll(client: PublicClient, router: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, legsList: Leg[][]) {
  const results = await Promise.allSettled(
    legsList.map((legs) => client.readContract({ address: router, abi: quoteAbi, functionName: "quote", args: [tokenIn, tokenOut, amountIn, legs] }))
  );
  return results.map((r) => (r.status === "fulfilled" && r.value[0] > 0n ? r.value[0] : null));
}

export async function findRoute(opts: {
  client: PublicClient;
  router: Address;
  hub: Address;
  feeBps: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}): Promise<Route | null> {
  const { client, router, hub, feeBps, tokenIn, tokenOut, amountIn } = opts;
  const fee = feeFor(amountIn, feeBps);
  const net = amountIn - fee;
  if (net <= 0n) return null;
  const one = (p: Path): Leg[] => [{ amountIn: net, hops: p.hops }];

  // Direct pools, plus the first hop into USDG when neither side is USDG.
  const direct = singleHops(tokenOut);
  const viaHub = tokenIn !== hub && tokenOut !== hub;
  const firstHops = viaHub ? singleHops(hub) : [];
  const round1 = await quoteAll(client, router, tokenIn, tokenOut, amountIn, direct.map(one));
  let candidates: { path: Path; out: bigint }[] = direct.flatMap((path, i) => (round1[i] ? [{ path, out: round1[i]! }] : []));
  let compared = direct.length;

  if (viaHub) {
    const hubOuts = await quoteAll(client, router, tokenIn, hub, amountIn, firstHops.map(one));
    compared += firstHops.length;
    const bestFirst = firstHops
      .map((p, i) => ({ p, out: hubOuts[i] }))
      .filter((x) => x.out)
      .sort((a, b) => (b.out! > a.out! ? 1 : -1))
      .slice(0, 2);
    const twoHop: Path[] = bestFirst.flatMap(({ p }) =>
      singleHops(tokenOut).map((q) => ({ label: `${p.label} → USDG → ${q.label}`, hops: [...p.hops, ...q.hops] }))
    );
    const round2 = await quoteAll(client, router, tokenIn, tokenOut, amountIn, twoHop.map(one));
    compared += twoHop.length;
    candidates = candidates.concat(twoHop.flatMap((path, i) => (round2[i] ? [{ path, out: round2[i]! }] : [])));
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.out > a.out ? 1 : -1));
  const best = candidates[0];
  let route: Route = { legs: one(best.path), amountOut: best.out, fee, net, parts: [{ label: best.path.label, share: 100 }], compared };

  // Split between the best path and the best one sharing no pool with it (legs are quoted independently, so a
  // shared pool would be counted twice).
  const used = new Set(pools(tokenIn, best.path));
  const second = candidates.slice(1).find((c) => pools(tokenIn, c.path).every((k) => !used.has(k)));
  if (second) {
    const splitLegs = SPLITS.map((pct) => {
      const a = (net * BigInt(pct)) / 100n;
      return [
        { amountIn: a, hops: best.path.hops },
        { amountIn: net - a, hops: second.path.hops },
      ];
    });
    const outs = await quoteAll(client, router, tokenIn, tokenOut, amountIn, splitLegs);
    route.compared += SPLITS.length;
    outs.forEach((out, i) => {
      if (out && out > route.amountOut) {
        route = {
          ...route,
          legs: splitLegs[i],
          amountOut: out,
          parts: [
            { label: best.path.label, share: SPLITS[i] },
            { label: second.path.label, share: 100 - SPLITS[i] },
          ],
        };
      }
    });
  }
  return route;
}
