import { catalog } from "@/generated/catalog";

export const explorer = (kind: "address" | "tx" | "token", value: string) => `${catalog.explorer}/${kind}/${value}`;
// $LANE trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_LANE_TRADE_URL overrides.
export const tradeUrl = (token?: string | null) =>
  process.env.NEXT_PUBLIC_LANE_TRADE_URL || `${catalog.pons.tokenPageUrl}${token ?? ""}`;
export const X_URL = process.env.NEXT_PUBLIC_X_URL || "https://x.com/Stock_Lane";
export const GITHUB_URL = "https://github.com/patrick734/stocklane";
// The $LANE token on Pons. The burn uses whatever DrawdownRetire holds on-chain; this is for display and trading links.
export const LANE_CA = (process.env.NEXT_PUBLIC_LANE_CA || "0x23d250F0a3b809c27D5D0D011763Ec514eaF8DE5") as `0x${string}`;
