// Read-only launch checks. Sends nothing and never needs a private key.
// Usage: node scripts/preflight.js
// Env: ADMIN_MULTISIG, GUARDIAN_MULTISIG, KEEPER_ADDRESS, LANE_TOKEN_ADDRESS (optional; usually set later),
//      DEPLOYER_ADDRESS (the fresh deployer wallet, for the role and gas checks), ROBINHOOD_RPC_URL (optional).
// Exits 1 if any check fails, so a launch script can stop before deploying.
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const MIN_DEPLOYER_ETH = ethers.parseEther(process.env.MIN_DEPLOYER_ETH || "0.01");
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];

let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => console.log(`  warn  ${msg}`);
const fail = (msg) => {
  failed++;
  console.log(`  FAIL  ${msg}`);
};

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });
  const now = BigInt((await withRetry(() => provider.getBlock("latest"))).timestamp);

  console.log("Network");
  const chainId = await withRetry(() => provider.send("eth_chainId", []));
  if (BigInt(chainId) === BigInt(config.network.chainId)) ok(`chainId ${BigInt(chainId)} (Robinhood Chain)`);
  else fail(`chainId ${BigInt(chainId)}, expected ${config.network.chainId}`);

  console.log("Roles");
  const roles = {};
  for (const name of ["ADMIN_MULTISIG", "GUARDIAN_MULTISIG", "KEEPER_ADDRESS"]) {
    const v = process.env[name];
    if (!v || !ethers.isAddress(v)) {
      fail(`${name} is not set to an address`);
      continue;
    }
    roles[name] = ethers.getAddress(v);
    const code = await withRetry(() => provider.getCode(v));
    const isContract = code !== "0x";
    const wantsContract = name !== "KEEPER_ADDRESS";
    if (wantsContract && !isContract && process.env.ALLOW_PLAIN_WALLETS === "1") ok(`${name} ${roles[name]} (plain wallet, allowed by ALLOW_PLAIN_WALLETS=1)`);
    else if (wantsContract && !isContract) fail(`${name} ${roles[name]} is a plain wallet; it must be a multisig contract (or set ALLOW_PLAIN_WALLETS=1 in launch.env)`);
    else ok(`${name} ${roles[name]}${isContract ? " (contract)" : ""}`);
  }
  const set = Object.values(roles);
  if (new Set(set).size !== set.length) fail("admin, guardian and keeper must be three different addresses");

  if (process.env.DEPLOYER_ADDRESS) {
    console.log("Deployer");
    const d = process.env.DEPLOYER_ADDRESS;
    if (!ethers.isAddress(d)) fail("DEPLOYER_ADDRESS is not an address");
    else {
      const bal = await withRetry(() => provider.getBalance(d));
      const msg = `${ethers.getAddress(d)} holds ${ethers.formatEther(bal)} ETH`;
      if (bal >= MIN_DEPLOYER_ETH) ok(msg);
      else fail(`${msg}, needs at least ${ethers.formatEther(MIN_DEPLOYER_ETH)} for gas`);
      if (Object.values(roles).includes(ethers.getAddress(d))) fail("the deployer is also one of the role addresses; deploy from a fresh wallet");
    }
  }

  console.log("$LANE");
  const w = process.env.LANE_TOKEN_ADDRESS;
  if (!w) ok("no $LANE yet: deploying first; after the Pons launch, ./set-token.sh prepares the timelock transaction");
  else if (!ethers.isAddress(w)) fail("LANE_TOKEN_ADDRESS is not an address");
  else {
    const t = new ethers.Contract(w, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function burn(uint256)"], provider);
    try {
      const [symbol, decimals, supply] = await withRetry(() => Promise.all([t.symbol(), t.decimals(), t.totalSupply()]));
      if (decimals !== 18n) fail(`${symbol} has ${decimals} decimals, needs 18`);
      else ok(`${symbol} at ${ethers.getAddress(w)}, supply ${ethers.formatEther(supply)}`);
      // A real burn must refuse to burn more than the caller holds; a fallback would accept it.
      const over = await provider.call({ from: ethers.ZeroAddress.replace(/0$/, "1"), to: w, data: t.interface.encodeFunctionData("burn", [10n ** 30n]) }).then(() => true, () => false);
      const zero = await provider.call({ from: ethers.ZeroAddress.replace(/0$/, "1"), to: w, data: t.interface.encodeFunctionData("burn", [0n]) }).then(() => true, () => false);
      if (zero && !over) ok("burn(uint256) works, as DrawdownRetire requires");
      else fail("token has no working burn(uint256); DrawdownRetire cannot retire it");
    } catch (e) {
      fail(`could not read the token at ${w}: ${e.shortMessage || e.message}`);
    }
  }

  console.log("Uniswap and Pons");
  const hasCode = async (a) => (await withRetry(() => provider.getCode(a))) !== "0x";
  for (const [label, a] of [
    ["Uniswap v4 PoolManager", config.uniswap.poolManager],
    ["Uniswap v3 factory", config.uniswap.v3Factory],
    ["Pons hook", config.pons.hook],
  ]) {
    if (await hasCode(a)) ok(`${label} ${ethers.getAddress(a)}`);
    else fail(`${label}: no contract at ${a}`);
  }
  // A genuine Uniswap v3 factory maps the standard fee tiers to their tick spacings.
  const factory = new ethers.Contract(
    config.uniswap.v3Factory,
    ["function feeAmountTickSpacing(uint24) view returns (int24)", "function getPool(address,address,uint24) view returns (address)"],
    provider
  );
  try {
    const spacings = await withRetry(() => Promise.all([500, 3000, 10000].map((f) => factory.feeAmountTickSpacing(f))));
    if (spacings.map(Number).join() === "10,60,200") ok("v3 factory has the standard fee tiers (0.05% / 0.3% / 1%)");
    else fail(`v3 factory fee tiers look wrong: ${spacings.join(", ")}`);
  } catch (e) {
    fail(`v3 factory did not answer like Uniswap v3: ${e.shortMessage || e.message}`);
  }

  console.log("Prices");
  const usdgFeed = new ethers.Contract(config.chainlink.usdgUsdFeed, FEED_ABI, provider);
  const [, usdgAnswer, , usdgUpdated] = await withRetry(() => usdgFeed.latestRoundData());
  const usdgAge = now - usdgUpdated;
  if (usdgAge <= BigInt(config.chainlink.usdgMaxAge) && usdgAnswer > 0n) ok(`USDG/USD fresh (${usdgAge}s old)`);
  else fail(`USDG/USD stale or invalid (${usdgAge}s old)`);

  const usdg = config.tokens.usdg.address;
  let stale = 0;
  let withV3 = 0;
  for (const [ticker, t] of Object.entries(config.equityTokens)) {
    const feed = new ethers.Contract(t.chainlinkFeed, FEED_ABI, provider);
    const [, answer, , updated] = await withRetry(() => feed.latestRoundData());
    if (answer <= 0n) {
      fail(`${ticker}: feed answer is not positive`);
      continue;
    }
    const age = now - updated;
    if (age > BigInt(config.chainlink.equityMaxAge)) stale++;
    const v3 = await withRetry(() => Promise.all(config.uniswap.v3Fees.map((f) => factory.getPool(t.address, usdg, f))));
    const tiers = config.uniswap.v3Fees.filter((_, i) => v3[i] !== ethers.ZeroAddress);
    if (tiers.length) withV3++;
    console.log(`  info  ${ticker.padEnd(6)} $${(Number(answer) / 1e8).toFixed(2).padStart(9)}  ${age}s old  v3 pools: ${tiers.length ? tiers.map((f) => `${f / 10000}%`).join(" ") : "none"}`);
  }
  if (stale) warn(`${stale} stock price(s) are stale (market closed?). Deploying is fine; the price guard waits for fresh prices.`);
  ok(`${withV3} of ${Object.keys(config.equityTokens).length} stocks have a Uniswap v3 USDG pool (v4 pools are found by the app at quote time)`);

  console.log(failed ? `\n${failed} check(s) failed. Fix them before deploying.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Preflight could not finish:", e.shortMessage || e.message);
  process.exit(1);
});
