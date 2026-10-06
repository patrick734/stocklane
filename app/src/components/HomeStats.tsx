"use client";

import Link from "next/link";
import { useProtocol } from "@/hooks/useProtocol";
import { fmtAmount, fmtBps } from "@/lib/format";

export function HomeStats() {
  const p = useProtocol();
  if (!p.d) return null;
  return (
    <section className="stats">
      <div className="stat">
        <span>$LANE burned</span>
        <b className="num">{fmtAmount(p.totalRetired ?? 0n, 18, 0)}</b>
      </div>
      <div className="stat">
        <span>Swap fee</span>
        <b className="num">{fmtBps(p.feeBps)}</b>
      </div>
      <div className="stat">
        <span>Price guard</span>
        <b className="num">{fmtBps(p.maxDeviationBps, 0)}</b>
      </div>
      <div className="stat">
        <span>Admin delay</span>
        <b className="num">{p.delay !== undefined ? `${Number(p.delay) / 3600}h` : "…"}</b>
      </div>
      <Link href="/safety" className="stat stat-link">
        <span>Deployer power</span>
        <b>{p.deployerIsAdmin === false ? "None ✓" : "…"}</b>
      </Link>
    </section>
  );
}
