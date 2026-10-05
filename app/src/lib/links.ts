import { catalog } from "@/generated/catalog";

export const explorer = (kind: "address" | "tx" | "token", value: string) => `${catalog.explorer}/${kind}/${value}`;
// $LANE trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_LANE_TRADE_URL overrides.
export const tradeUrl = (token?: string | null) =>
  process.env.NEXT_PUBLIC_LANE_TRADE_URL || `${catalog.pons.tokenPageUrl}${token ?? ""}`;
export const X_URL = process.env.NEXT_PUBLIC_X_URL || "https://x.com/stocklanefun";
export const GITHUB_URL = "https://github.com/patrick734/stocklane";
