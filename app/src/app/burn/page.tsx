"use client";

import { useProtocol } from "@/hooks/useProtocol";
import { fmtAmount, fmtBps, shortAddress } from "@/lib/format";
import { explorer, tradeUrl } from "@/lib/links";

export default function Burn() {
  const p = useProtocol();
  const last = p.lastDrawdown ? new Date(Number(p.lastDrawdown) * 1000) : null;
  return (
    <section className="page">
      <p className="eyebrow">$LANE</p>
      <h1>Every swap burns $LANE</h1>
      <p className="lede">
        StockLane keeps {fmtBps(p.feeBps)} of each swap, in the token you pay with. That fee goes to the FeeRouter, then
        to DrawdownRetire, a contract with no withdraw function at all. A keeper uses it to buy $LANE on its Pons pool
        and burns everything it buys. Runs are capped and at most hourly, so a bad price can never cost much.
      </p>
      <div className="stats">
        <div className="stat">
          <span>$LANE burned</span>
          <b className="num">{p.laneToken ? fmtAmount(p.totalRetired, 18, 0) : "0"}</b>
        </div>
        <div className="stat">
          <span>USDG waiting to buy $LANE</span>
          <b className="num">{fmtAmount(p.usdgWaiting, 6, 2)}</b>
        </div>
        <div className="stat">
          <span>Last burn</span>
          <b>{last ? last.toLocaleString() : "not yet"}</b>
        </div>
        <div className="stat">
          <span>Burn status</span>
          <b>{p.halted ? "Halted by guardian" : p.laneToken ? "Live" : "Waiting for $LANE"}</b>
        </div>
      </div>
      {p.laneTokenKnown && !p.laneToken && (
        <div className="card notice">
          <h3>$LANE is not set yet</h3>
          <p>
            The protocol launched first. $LANE launches on Pons, and the 48-hour timelock then sets it in DrawdownRetire,
            once and permanently. Until then, fees wait safely in the contract.
          </p>
        </div>
      )}
      {p.laneToken && (
        <div className="card notice">
          <h3>$LANE</h3>
          <p>
            Token <a href={explorer("token", p.laneToken)} target="_blank" rel="noreferrer" className="num">{shortAddress(p.laneToken)}</a>.{" "}
            <a href={tradeUrl(p.laneToken)} target="_blank" rel="noreferrer">Trade on Pons ↗</a>
          </p>
        </div>
      )}
      {p.d && (
        <ol className="flow">
          <li>
            <b>LaneRouter</b> takes the fee <a href={explorer("address", p.d.router)} target="_blank" rel="noreferrer" className="num">{shortAddress(p.d.router)}</a>
          </li>
          <li>
            <b>FeeRouter</b> forwards it; a new destination would wait 48h <a href={explorer("address", p.d.feeRouter)} target="_blank" rel="noreferrer" className="num">{shortAddress(p.d.feeRouter)}</a>
          </li>
          <li>
            <b>DrawdownRetire</b> buys $LANE and burns it <a href={explorer("address", p.d.drawdownRetire)} target="_blank" rel="noreferrer" className="num">{shortAddress(p.d.drawdownRetire)}</a>
          </li>
        </ol>
      )}
    </section>
  );
}
