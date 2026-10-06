"use client";

import { useState } from "react";
import { LANE_CA, tradeUrl } from "@/lib/links";

/** The $LANE contract address with copy and buy buttons. */
export function LaneCA() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(LANE_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }
  return (
    <div className="ca">
      <span className="ca-label">$LANE CA</span>
      <code className="ca-addr">{LANE_CA}</code>
      <span className="ca-actions">
        <button type="button" className="chip" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <a className="chip chip-accent" href={tradeUrl(LANE_CA)} target="_blank" rel="noreferrer">
          Buy on Pons ↗
        </a>
      </span>
    </div>
  );
}
