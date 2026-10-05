"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount } from "wagmi";
import { laneRouterAbi } from "@/generated/abis";
import { useAllowance, useBalances, useQuote, useRouterState } from "@/hooks/useSwap";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtBps, fmtUsd, safeParse, toInput } from "@/lib/format";
import { tokenList, type Token } from "@/lib/tokens";
import { TokenSelect } from "./TokenSelect";
import { TxStatus, useTx } from "./Tx";

const SLIPPAGES = [10, 50, 100];

export function SwapCard() {
  const { deployment, chainId } = useDeployment();
  const { address, isConnected } = useAccount();
  const tokens = useMemo(() => tokenList(deployment), [deployment]);
  const [tokenIn, setTokenIn] = useState<Token>(tokens[0]);
  const [tokenOut, setTokenOut] = useState<Token>(tokens.find((t) => t.symbol === "TSLA") ?? tokens[1]);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState(50);
  const [showSettings, setShowSettings] = useState(false);
  // Another network has other token addresses: keep the same symbols.
  useEffect(() => {
    setTokenIn((t) => tokens.find((x) => x.symbol === t.symbol) ?? tokens[0]);
    setTokenOut((t) => tokens.find((x) => x.symbol === t.symbol) ?? tokens[1]);
  }, [tokens]);

  const routerState = useRouterState();
  const balances = useBalances(tokens);
  const allowance = useAllowance(tokenIn.address);
  const amountIn = safeParse(input, tokenIn.decimals);
  const quote = useQuote(tokenIn, tokenOut, amountIn, routerState?.feeBps);
  const tx = useTx();

  const balanceIn = balances[tokenIn.address.toLowerCase()];
  const balanceOut = balances[tokenOut.address.toLowerCase()];
  const q = quote.data;
  const fresh = q && amountIn !== null && q.net + q.fee === amountIn;
  const minOut = q ? (q.amountOut * BigInt(10_000 - slippage)) / 10_000n : undefined;

  const pick = (side: "in" | "out", t: Token) => {
    const [cur, other] = side === "in" ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
    if (t.address === other.address) {
      setTokenIn(side === "in" ? t : cur);
      setTokenOut(side === "in" ? cur : t);
    } else if (side === "in") setTokenIn(t);
    else setTokenOut(t);
  };
  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    if (q && fresh) setInput(toInput(q.amountOut, tokenOut.decimals));
  };

  // Value difference against Chainlink: negative means the fill is worth less than what goes in.
  let vsOracle: number | undefined;
  if (q?.oracle?.priced && q.oracle.valueIn > 0n) {
    vsOracle = (Number(q.oracle.valueOut) / Number(q.oracle.valueIn) - 1) * 100;
    if (Math.abs(vsOracle) < 0.005) vsOracle = 0;
  }
  const blocked = Boolean(q?.oracle?.priced && !q.oracle.ok);

  async function swap() {
    if (!q || !deployment || !address || minOut === undefined || amountIn === null) return;
    const router = deployment.router as Address;
    await tx.run("Swap", async ({ ensureAllowance }) => {
      await ensureAllowance(tokenIn.address, router, amountIn);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      return tx.writeContractAsync({
        address: router,
        abi: laneRouterAbi,
        chainId,
        functionName: "swap",
        args: [tokenIn.address, tokenOut.address, amountIn, minOut, address, deadline, q.legs],
      });
    });
  }

  let action: { label: string; disabled: boolean } = { label: "Swap", disabled: false };
  if (!deployment) action = { label: "Not live on this network yet", disabled: true };
  else if (routerState?.paused) action = { label: "Swaps are paused by the guardian", disabled: true };
  else if (!isConnected) action = { label: "Connect a wallet to swap", disabled: true };
  else if (amountIn === null) action = { label: "Enter an amount", disabled: true };
  else if (balanceIn !== undefined && amountIn > balanceIn) action = { label: `Not enough ${tokenIn.symbol}`, disabled: true };
  else if (quote.isFetching && !fresh) action = { label: "Finding the best route…", disabled: true };
  else if (!q) action = { label: "No route with liquidity", disabled: true };
  else if (blocked) action = { label: "Price too far from Chainlink", disabled: true };
  else if (tx.busy) action = { label: tx.message ?? "Working…", disabled: true };
  else if (allowance !== undefined && allowance < amountIn) action = { label: `Approve ${tokenIn.symbol} and swap`, disabled: false };

  return (
    <div className="card swap" aria-label="Swap">
      <div className="swap-head">
        <h2>Swap</h2>
        <button className="icon-btn" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings} aria-label="Slippage settings">
          {fmtBps(slippage, slippage % 100 ? 1 : 0)} slippage ⚙
        </button>
      </div>
      {showSettings && (
        <div className="settings">
          <span>Max slippage</span>
          {SLIPPAGES.map((s) => (
            <button key={s} className={s === slippage ? "chip active" : "chip"} onClick={() => setSlippage(s)}>
              {fmtBps(s, s % 100 ? 1 : 0)}
            </button>
          ))}
        </div>
      )}

      <div className="side">
        <div className="side-top">
          <span>You pay</span>
          {balanceIn !== undefined && (
            <button className="link-btn" onClick={() => setInput(toInput(balanceIn, tokenIn.decimals))}>
              Balance {fmtAmount(balanceIn, tokenIn.decimals)} · Max
            </button>
          )}
        </div>
        <div className="side-row">
          <input
            className="amount"
            inputMode="decimal"
            placeholder="0"
            value={input}
            onChange={(e) => setInput(e.target.value.trim().replace(",", "."))}
            aria-label={`Amount of ${tokenIn.symbol} to pay`}
          />
          <TokenSelect tokens={tokens} value={tokenIn} other={tokenOut} balances={balances} onChange={(t) => pick("in", t)} />
        </div>
        <div className="side-foot">{q?.oracle?.priced ? fmtUsd(Number(formatUnits(q.oracle.valueIn, 6))) : " "}</div>
      </div>

      <button className="flip" onClick={flip} aria-label="Switch pay and receive">
        ↓↑
      </button>

      <div className="side">
        <div className="side-top">
          <span>You receive</span>
          {balanceOut !== undefined && <span className="muted">Balance {fmtAmount(balanceOut, tokenOut.decimals)}</span>}
        </div>
        <div className="side-row">
          <output className={quote.isFetching ? "amount loading" : "amount"} aria-live="polite">
            {q && fresh ? fmtAmount(q.amountOut, tokenOut.decimals, 6) : "0"}
          </output>
          <TokenSelect tokens={tokens} value={tokenOut} other={tokenIn} balances={balances} onChange={(t) => pick("out", t)} />
        </div>
        <div className="side-foot">
          {q?.oracle?.priced ? (
            <>
              {fmtUsd(Number(formatUnits(q.oracle.valueOut, 6)))}
              {vsOracle !== undefined && <span className={vsOracle < -1 ? "bad" : "muted"}> ({vsOracle >= 0 ? "+" : ""}{vsOracle.toFixed(2)}% vs Chainlink)</span>}
            </>
          ) : (
            " "
          )}
        </div>
      </div>

      {q && fresh && (
        <div className="route">
          <div className="route-row">
            <span>Route</span>
            <span className="route-parts">
              {q.parts.map((p) => (
                <span key={p.label} className="route-part">
                  {q.parts.length > 1 && <b>{p.share}%</b>} {p.label}
                </span>
              ))}
            </span>
          </div>
          <div className="route-row">
            <span>Minimum received</span>
            <span className="num">
              {fmtAmount(minOut, tokenOut.decimals, 6)} {tokenOut.symbol}
            </span>
          </div>
          <div className="route-row">
            <span>StockLane fee ({fmtBps(routerState?.feeBps)}, burns $LANE)</span>
            <span className="num">
              {fmtAmount(q.fee, tokenIn.decimals, 6)} {tokenIn.symbol}
            </span>
          </div>
          <div className="route-row">
            <span>Price guard</span>
            <span>
              {q.oracle?.priced
                ? q.oracle.ok
                  ? `Within ${fmtBps(routerState?.maxDeviationBps, 0)} of Chainlink`
                  : `Over ${fmtBps(routerState?.maxDeviationBps, 0)} from Chainlink: the router refuses this fill`
                : "No fresh Chainlink price (market closed): your minimum applies"}
            </span>
          </div>
          <div className="route-row muted">
            <span>Compared</span>
            <span>{q.compared} routes across Uniswap v3 and v4</span>
          </div>
        </div>
      )}
      {quote.error && <p className="tx-status error">Couldn&apos;t reach Robinhood Chain to quote. Retrying…</p>}

      <button className="btn btn-primary wide big" disabled={action.disabled} onClick={swap}>
        {action.label}
      </button>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
    </div>
  );
}
