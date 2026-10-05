import type { Address } from "viem";
import { catalog } from "@/generated/catalog";
import type { Deployment } from "@/generated/deployments";

export type Token = { symbol: string; name: string; address: Address; decimals: number; kind: "usd" | "stock" };

/** USDG first, then every stock token with a Chainlink feed, alphabetically. */
export function tokenList(d: Deployment | null): Token[] {
  const usdg: Token = { symbol: "USDG", name: "Global Dollar", address: (d?.usdg ?? catalog.usdg) as Address, decimals: 6, kind: "usd" };
  const stocks = d?.stocks ?? catalog.stocks;
  const list = Object.entries(stocks)
    .map(([symbol, s]) => ({ symbol, name: s.name, address: s.address as Address, decimals: 18, kind: "stock" as const }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [usdg, ...list];
}
