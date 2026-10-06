// Quotes every stock against the real Uniswap v3 and v4 pools through LaneRouter's own code, before LaneRouter
// is deployed. Read-only and needs no key: the router is compiled and constructed on an in-memory chain, then its
// code and settings are planted into an eth_call on the live chain (a state override). The real pools run the
// real swap code, and everything is reverted. Works on any RPC: no fork, no old state needed.
//
//   ./probe.sh                                  (from the repo root; loads ROBINHOOD_RPC_URL from launch.env)
//   PROBE_DEPLOYMENT=localhost RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/probe-quotes.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const config = require("../config/robinhood.json");

const PROBE = "0x0000000000000000000000000000000057a7e000"; // where the router code is planted for the call
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
const ZERO = ethers.ZeroAddress;

function venues() {
  const dep = process.env.PROBE_DEPLOYMENT;
  if (dep) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${dep}.json`), "utf8"));
    const stocks = Object.fromEntries(Object.entries(d.stocks).map(([t, s]) => [t, { address: s.address, feed: s.feed }]));
    return { rpc: process.env.RPC_URL, poolManager: d.poolManager, v3Factory: d.v3Factory, usdg: d.usdg, stocks };
  }
  const stocks = Object.fromEntries(Object.entries(config.equityTokens).map(([t, s]) => [t, { address: s.address, feed: s.chainlinkFeed }]));
  return {
    rpc: process.env.RPC_URL || process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl,
    poolManager: config.uniswap.poolManager,
    v3Factory: config.uniswap.v3Factory,
    usdg: config.tokens.usdg.address,
    stocks,
  };
}

const c_label = (h) => `${h.kind ? "v4" : "v3"} ${h.fee}`;
const hops = (tokenOut) => [
  ...config.uniswap.v3Fees.map((fee) => ({ label: `v3 ${fee / 10000}%`, hop: { kind: 0, tokenOut, fee, tickSpacing: 0, hooks: ZERO } })),
  ...config.uniswap.v4HooklessPools.map((p) => ({ label: `v4 ${p.fee / 10000}%`, hop: { kind: 1, tokenOut, fee: p.fee, tickSpacing: p.tickSpacing, hooks: ZERO } })),
];

async function main() {
  const v = venues();
  const [deployer, multisig, guardian, sink] = await ethers.getSigners();

  // Build the router exactly as deploy.js does, on the in-memory chain.
  const timelock = await ethers.deployContract("TimelockController", [48 * 3600, [multisig.address], [multisig.address], ZERO]);
  const router = await ethers.deployContract("LaneRouter", [
    {
      poolManager: v.poolManager,
      v3Factory: v.v3Factory,
      oracle: sink.address, // quote() never reads the oracle
      quoteToken: v.usdg,
      feeRecipient: sink.address,
      admin: await timelock.getAddress(),
      guardian: guardian.address,
      feeBps: config.launch.routerFeeBps,
      maxOracleDeviationBps: config.launch.maxOracleDeviationBps,
      hooks: [],
    },
  ]);
  const code = await ethers.provider.getCode(router);
  const stateDiff = {};
  for (let slot = 0; slot < 12; slot++) {
    const key = ethers.toBeHex(slot, 32);
    const value = await ethers.provider.getStorage(router, slot);
    if (BigInt(value) !== 0n) stateDiff[key] = value;
  }
  void deployer;

  const live = new ethers.JsonRpcProvider(v.rpc, undefined, { staticNetwork: true });
  const chainId = Number((await live.getNetwork()).chainId);
  const block = await live.getBlockNumber();
  console.log(`Probing ${Object.keys(v.stocks).length} stocks on chain ${chainId} at block ${block} through LaneRouter's code (read-only)\n`);

  const iface = router.interface;
  const fee = (a) => a - (a * BigInt(config.launch.routerFeeBps)) / 10_000n;
  async function quote(tokenIn, tokenOut, amountIn, hop) {
    const data = iface.encodeFunctionData("quote", [tokenIn, tokenOut, amountIn, [{ amountIn: fee(amountIn), hops: [hop] }]]);
    try {
      const raw = await live.send("eth_call", [{ to: PROBE, data, gas: "0x989680" }, "latest", { [PROBE]: { code, stateDiff } }]);
      return { out: iface.decodeFunctionResult("quote", raw)[0] };
    } catch (e) {
      const msg = (e.info?.error?.message || e.shortMessage || e.message || "").toLowerCase();
      if (msg.includes("override") || msg.includes("too many arguments") || msg.includes("invalid params")) throw new Error(`this RPC does not support eth_call state overrides: ${msg}`);
      if (process.env.PROBE_DEBUG) console.log("   ", c_label(hop), msg.slice(0, 200));
      return { err: msg.slice(0, 60) };
    }
  }

  const usdgIn = ethers.parseUnits("100", 6);
  let routed = 0;
  let v3ok = 0;
  let v4ok = 0;
  const rows = [];
  for (const [ticker, s] of Object.entries(v.stocks)) {
    const [, answer] = await new ethers.Contract(s.feed, FEED_ABI, live).latestRoundData();
    const chainlink = Number(answer) / 1e8;
    let best = null;
    let pools = 0;
    for (const c of hops(s.address)) {
      const r = await quote(v.usdg, s.address, usdgIn, c.hop);
      if (r.out === undefined || r.out === 0n) continue;
      pools++;
      c.hop.kind === 0 ? v3ok++ : v4ok++;
      if (!best || r.out > best.out) best = { ...c, out: r.out };
    }
    if (!best) {
      rows.push(`  ${ticker.padEnd(6)} no pool answered`);
      continue;
    }
    routed++;
    const shares = Number(ethers.formatEther(best.out));
    const buyPrice = 100 / shares;
    // Sell the same shares back through whichever pool is best for selling.
    let sell = null;
    for (const c of hops(v.usdg)) {
      const r = await quote(s.address, v.usdg, best.out, c.hop);
      if (r.out !== undefined && r.out > 0n && (!sell || r.out > sell.out)) sell = { ...c, out: r.out };
    }
    const off = ((buyPrice / chainlink - 1) * 100).toFixed(2);
    const back = sell ? `sell back ${ethers.formatUnits(sell.out, 6).slice(0, 7)} USDG via ${sell.label}` : "no sell route";
    rows.push(
      `  ${ticker.padEnd(6)} 100 USDG -> ${shares.toFixed(6)} via ${best.label.padEnd(9)} (${pools} pools)  $${buyPrice.toFixed(2)} vs Chainlink $${chainlink.toFixed(2)} (${off >= 0 ? "+" : ""}${off}%)  ${back}`
    );
  }
  console.log(rows.join("\n"));
  console.log(`\n${routed} of ${Object.keys(v.stocks).length} stocks routable. Quotes that ran real pool code: ${v3ok} Uniswap v3, ${v4ok} Uniswap v4.`);
  console.log("Prices include the 0.05% StockLane fee and each pool's own fee. More than ~3% above Chainlink would be refused by the price guard when prices are fresh.");
  if (!routed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`PROBE FAILED: ${e.shortMessage || e.message}`);
  process.exit(1);
});
