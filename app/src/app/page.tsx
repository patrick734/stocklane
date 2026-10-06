import { HomeStats } from "@/components/HomeStats";
import { LaneCA } from "@/components/LaneCA";
import { SwapCard } from "@/components/SwapCard";

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Robinhood Chain · Uniswap v3 + v4 · Chainlink</p>
          <h1>
            Every pool.
            <br />
            <span className="accent">One lane.</span>
          </h1>
          <p className="lede">
            StockLane checks every Uniswap v3 and v4 pool for a tokenized stock, splits your order where that pays
            more, and refuses any fill too far from the Chainlink price. Each swap&apos;s 0.05% fee buys $LANE and
            burns it.
          </p>
          <ul className="checks">
            <li>Best price across dozens of routes, quoted live on-chain</li>
            <li>Chainlink price guard on every swap, plus your own minimum</li>
            <li>No admin keys: every change waits 48 hours in a public timelock</li>
          </ul>
          <LaneCA />
        </div>
        <SwapCard />
      </section>
      <HomeStats />
      <section className="how">
        <div>
          <span className="step">1</span>
          <h3>Find</h3>
          <p>Your browser quotes the trade through every fee tier on Uniswap v3 and v4, directly and through USDG.</p>
        </div>
        <div>
          <span className="step">2</span>
          <h3>Split</h3>
          <p>If two independent pools beat one, the order is split 70/30, 50/50 or 30/70, whichever pays you most.</p>
        </div>
        <div>
          <span className="step">3</span>
          <h3>Guard</h3>
          <p>The router compares what you get with Chainlink and reverts if it is more than 3% worse. Your minimum applies on top.</p>
        </div>
        <div>
          <span className="step">4</span>
          <h3>Burn</h3>
          <p>The 0.05% fee goes to the burn contract. A keeper buys $LANE with it on Pons and burns every token.</p>
        </div>
      </section>
    </>
  );
}
