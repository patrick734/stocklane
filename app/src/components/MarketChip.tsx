"use client";

import { useEffect, useState } from "react";
import { marketState, type MarketState } from "@/lib/market";

/// Live NYSE session chip. Chainlink stock prices pause outside the session; swaps still run, guarded by your minimum.
export function MarketChip() {
  const [state, setState] = useState<MarketState | null>(null);
  useEffect(() => {
    const tick = () => setState(marketState());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  if (!state) return <span className="mkt" aria-hidden><span className="dot" />NYSE</span>;
  return (
    <span className={state.open ? "mkt open" : "mkt"} title="Chainlink stock prices update during the NYSE session; the price guard follows them.">
      <span className="dot" />
      {state.label}
    </span>
  );
}
