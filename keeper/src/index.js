#!/usr/bin/env node
// StockLane keeper. One cycle:
//   1. route: FeeRouter.routeMany for fee tokens worth forwarding (anyone may call it)
//   2. burn:  DrawdownRetire.drawdown — buy $LANE with one fee token through LaneRouter, then burn it
// Every call is simulated first. DRY_RUN=1 (the default) only simulates and logs.
//
//   node src/index.js --once     one cycle (what GitHub Actions runs)
//   node src/index.js            loop every LOOP_SECONDS (default 900)
//
// Env: RPC_URL, KEEPER_PRIVATE_KEY (not needed for DRY_RUN), KEEPER_NETWORK (deployment file name, default
//      robinhood), KEEPER_CONFIG (default actions.config.json), DRY_RUN (default 1).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { logger } = require("./log");
const { feeFor, burnPaths, encodeLegs, minOut } = require("./routes");

const ROOT = path.join(__dirname, "..", "..");
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
const FEE_ROUTER = ["function routeMany(address[] tokens)"];
const ORACLE = ["function isFresh(address) view returns (bool)", "function usdgValue(address,uint256) view returns (uint256)"];
const ROUTER = [
  "function feeBps() view returns (uint16)",
  "function quote(address tokenIn, address tokenOut, uint256 amountIn, (uint256 amountIn, (uint8 kind, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)[] hops)[] legs) returns (uint256 amountOut, uint256 fee)",
];
const DRAWDOWN = [
  "function laneToken() view returns (address)",
  "function halted() view returns (bool)",
  "function lastDrawdown() view returns (uint64)",
  "function minInterval() view returns (uint32)",
  "function maxInputPerRun(address) view returns (uint256)",
  "function drawdown(address tokenIn, uint256 amountIn, uint256 minLaneOut, bytes route) returns (uint256)",
  "error OverLimit()",
  "error TooSoon()",
  "error IsHalted()",
  "error LaneTokenUnset()",
  "error SwapShortfall(uint256 received, uint256 minimum)",
];

const log = logger("keeper");

function reason(e) {
  return (e?.revert?.name ? `${e.revert.name}(${e.revert.args.join(", ")})` : e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 300);
}

function load() {
  const network = process.env.KEEPER_NETWORK || "robinhood";
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "deployments", `${network}.json`), "utf8"));
  const chain = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "config", "robinhood.json"), "utf8"));
  const cfgFile = path.join(__dirname, "..", process.env.KEEPER_CONFIG || "actions.config.json");
  const cfg = { minRouteUsdg: "5", minDrawdownUsdg: "10", slippageBps: 300, ...JSON.parse(fs.readFileSync(cfgFile, "utf8")) };
  return { network, dep, chain, cfg, dryRun: process.env.DRY_RUN !== "0", once: process.argv.includes("--once") };
}

/** USDG value of a token amount, or null when it has no fresh price. */
async function usdValue(ctx, token, amount) {
  if (token.toLowerCase() === ctx.dep.usdg.toLowerCase()) return amount;
  if (!(await ctx.oracle.isFresh(token))) return null;
  return ctx.oracle.usdgValue(token, amount);
}

async function send(ctx, label, contract, fn, args) {
  await contract[fn].staticCall(...args, { from: ctx.keeper });
  if (ctx.dryRun) return logger(label).info("simulated OK (dry run, not sent)");
  const tx = await contract.connect(ctx.signer)[fn](...args);
  logger(label).info("sent", { tx: tx.hash });
  const r = await tx.wait();
  logger(label).info(r.status === 1 ? "confirmed" : "REVERTED", { gasUsed: r.gasUsed });
}

async function route(ctx) {
  const l = logger("route");
  const fr = new ethers.Contract(ctx.dep.feeRouter, FEE_ROUTER, ctx.provider);
  const min = ethers.parseUnits(ctx.cfg.minRouteUsdg, 6);
  const tokens = [];
  for (const [symbol, token] of ctx.feeTokens) {
    const bal = await new ethers.Contract(token, ERC20, ctx.provider).balanceOf(ctx.dep.feeRouter);
    if (bal === 0n) continue;
    const value = await usdValue(ctx, token, bal);
    if (value !== null && value < min) continue;
    l.info("to forward", { token: symbol, amount: bal, usdg: value === null ? "unpriced" : ethers.formatUnits(value, 6) });
    tokens.push(token);
  }
  if (!tokens.length) return l.info("nothing worth forwarding");
  await send(ctx, "route", fr, "routeMany", [tokens]);
}

async function burn(ctx) {
  const l = logger("burn");
  const dd = new ethers.Contract(ctx.dep.drawdownRetire, DRAWDOWN, ctx.provider);
  const lane = await dd.laneToken();
  if (lane === ethers.ZeroAddress) return l.info("$LANE not set yet (./set-token.sh): fees wait in DrawdownRetire");
  if (await dd.halted()) return l.warn("halted by the guardian");
  const [last, interval, head] = await Promise.all([dd.lastDrawdown(), dd.minInterval(), ctx.provider.getBlock("latest")]);
  const wait = Number(last) + Number(interval) - head.timestamp;
  if (wait > 0) return l.info(`next burn allowed in ${Math.ceil(wait / 60)} min`);

  const router = new ethers.Contract(ctx.dep.router, ROUTER, ctx.provider);
  const feeBps = await router.feeBps();
  const min = ethers.parseUnits(ctx.cfg.minDrawdownUsdg, 6);
  const env = { usdg: ctx.dep.usdg, lane, uniswap: ctx.chain.uniswap, pons: { ...ctx.chain.pons, hook: ctx.dep.ponsHook } };
  // USDG first: it needs the fewest hops. Then whichever stock fee is worth the most.
  for (const [symbol, token] of ctx.feeTokens) {
    const [bal, cap] = await Promise.all([new ethers.Contract(token, ERC20, ctx.provider).balanceOf(ctx.dep.drawdownRetire), dd.maxInputPerRun(token)]);
    const amount = bal < cap ? bal : cap;
    if (amount === 0n) continue;
    const value = await usdValue(ctx, token, amount);
    if (value === null || value < min) continue;

    const net = amount - feeFor(amount, feeBps);
    let best = null;
    for (const p of burnPaths(token, env)) {
      try {
        const [out] = await router.quote.staticCall(token, lane, amount, [{ amountIn: net, hops: p.hops }]);
        if (!best || out > best.out) best = { ...p, out };
      } catch {}
    }
    if (!best) {
      l.warn("no route to $LANE yet", { token: symbol });
      continue;
    }
    const legs = [{ amountIn: net, hops: best.hops }];
    const floor = minOut(best.out, ctx.cfg.slippageBps);
    l.info("buying $LANE", { token: symbol, amount, usdg: ethers.formatUnits(value, 6), via: best.label, quoted: ethers.formatEther(best.out), minOut: ethers.formatEther(floor) });
    await send(ctx, "burn", dd, "drawdown", [token, amount, floor, encodeLegs(legs)]);
    return; // DrawdownRetire allows one run per interval
  }
  l.info("no fee token worth burning yet");
}

async function cycle(ctx) {
  for (const [name, fn] of [
    ["route", route],
    ["burn", burn],
  ]) {
    try {
      await fn(ctx);
    } catch (e) {
      logger(name).error("failed", { reason: reason(e) });
    }
  }
}

async function main() {
  const { network, dep, chain, cfg, dryRun, once } = load();
  const rpc = process.env.RPC_URL || chain.network.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== Number(dep.chainId)) throw new Error(`RPC is on chain ${chainId}, deployment ${network}.json is on ${dep.chainId}`);
  let signer;
  let keeper = dep.roles.keeper;
  if (process.env.KEEPER_PRIVATE_KEY) {
    signer = new ethers.NonceManager(new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider));
    keeper = await signer.getAddress();
  } else if (!dryRun) throw new Error("KEEPER_PRIVATE_KEY is required when DRY_RUN=0");
  const feeTokens = [["USDG", dep.usdg], ...Object.entries(dep.stocks).map(([t, s]) => [t, s.address])];
  const ctx = { dep, chain, cfg, dryRun, provider, signer, keeper, feeTokens, oracle: new ethers.Contract(dep.oracle, ORACLE, provider) };
  log.info("start", { network, chainId, keeper, mode: dryRun ? "DRY_RUN (simulate only)" : "LIVE" });
  for (;;) {
    await cycle(ctx);
    if (once) break;
    await new Promise((r) => setTimeout(r, Number(process.env.LOOP_SECONDS || 900) * 1000));
  }
}

if (require.main === module) {
  main().catch((e) => {
    log.error("fatal", { reason: reason(e) });
    process.exit(1);
  });
}
