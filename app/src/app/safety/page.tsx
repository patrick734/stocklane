"use client";

import { useProtocol } from "@/hooks/useProtocol";
import { fmtBps, shortAddress } from "@/lib/format";
import { explorer, GITHUB_URL } from "@/lib/links";

export default function Safety() {
  const p = useProtocol();
  const d = p.d;
  const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const rows: [string, boolean | undefined, string][] = d
    ? [
        ["The deployer holds no admin role", p.deployerIsAdmin === undefined ? undefined : !p.deployerIsAdmin, "The wallet that deployed StockLane has no power over it."],
        ["The router's admin is the timelock", p.timelockIsAdmin, "Only the timelock can change the fee, the price guard or the allowed hooks."],
        ["Every change waits at least 48 hours", p.delay === undefined ? undefined : p.delay >= 172_800n, `Timelock delay: ${p.delay !== undefined ? `${Number(p.delay) / 3600}h` : "…"}. Anyone can see a change coming.`],
        ["The oracle and FeeRouter belong to the timelock", p.oracleOwner === undefined ? undefined : same(p.oracleOwner, d.timelock) && same(p.feeRouterOwner, d.timelock), "No wallet can swap a price feed or redirect fees."],
        ["The fee is capped in code", p.feeBps === undefined ? undefined : p.feeBps <= (p.maxFeeBps ?? 30), `Now ${fmtBps(p.feeBps)}. It can never exceed ${fmtBps(p.maxFeeBps)}, even through the timelock.`],
        ["Swaps are open", p.paused === undefined ? undefined : !p.paused, "The guardian can pause swaps in an emergency; only the timelock can unpause."],
      ]
    : [];
  return (
    <section className="page">
      <p className="eyebrow">Safety</p>
      <h1>Nobody holds the keys</h1>
      <p className="lede">
        StockLane&apos;s router never holds your tokens between transactions: each swap pulls your input, routes it,
        checks the output and pays you in the same transaction. These checks are read live from the contracts.
      </p>
      {!d && <div className="card notice"><p>StockLane is not deployed on this network yet.</p></div>}
      <ul className="safety">
        {rows.map(([title, ok, detail]) => (
          <li key={title} className={ok === undefined ? "" : ok ? "ok" : "bad"}>
            <span className="mark">{ok === undefined ? "…" : ok ? "✓" : "✕"}</span>
            <div>
              <b>{title}</b>
              <p>{detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <h2>What protects each swap</h2>
      <ul className="plain">
        <li><b>Full fills only.</b> Every hop must use its whole input, or the swap reverts. Nothing is left behind.</li>
        <li><b>Canonical pools only.</b> v3 pools must come from the Uniswap factory; v4 pools must be hookless or use a hook the timelock allowed (the Pons hook, for $LANE).</li>
        <li><b>Chainlink price guard.</b> When both tokens have a fresh Chainlink price, the output may be at most {fmtBps(p.maxDeviationBps, 0)} worse than the input. Outside market hours there is no fresh price, so only your minimum applies.</li>
        <li><b>Your minimum and deadline.</b> You sign the least you accept and a 10-minute deadline.</li>
      </ul>
      {d && (
        <>
          <h2>Contracts</h2>
          <table className="addrs">
            <tbody>
              {(
                [
                  ["LaneRouter", d.router],
                  ["Timelock (48h)", d.timelock],
                  ["LaneOracle", d.oracle],
                  ["FeeRouter", d.feeRouter],
                  ["DrawdownRetire", d.drawdownRetire],
                  ["Burn adapter", d.adapter],
                  ["Admin (proposes to the timelock)", d.roles.admin],
                  ["Guardian (pause only)", d.roles.guardian],
                  ["Keeper (runs the burn)", d.roles.keeper],
                ] as const
              ).map(([label, a]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>
                    <a className="num" href={explorer("address", a)} target="_blank" rel="noreferrer">{shortAddress(a)}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">
        Source code and the full verification script: <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>. Anyone can
        run <code>./verify.sh</code> against the live contracts.
      </p>
    </section>
  );
}
