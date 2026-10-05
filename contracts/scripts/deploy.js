// Deploys StockLane. Every contract is configured in its constructor and governed by the 48h timelock
// from its first block: the deployer wallet ends with no role, no ownership and nothing pending.
//
//   Local demo (mocks, seeded):  npx hardhat run scripts/deploy.js
//   Fork dry run:                FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js
//   Robinhood Chain:             npx hardhat run scripts/deploy.js --network robinhood
//
// Live deploys read from env:
//   ADMIN_MULTISIG       proposer/executor of the timelock (a multisig contract, or a plain wallet with
//                        ALLOW_PLAIN_WALLETS=1)
//   GUARDIAN_MULTISIG    may pause swaps and halt the burn (a different multisig or wallet)
//   KEEPER_ADDRESS       runs buy-and-burn (a hot wallet, not the deployer)
//   LANE_TOKEN_ADDRESS   optional: $LANE if it is already launched on Pons. Usually left empty: the protocol
//                        deploys first and the timelock sets $LANE once after the Pons launch (set-token.sh).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");
const { equityFeedInit, usdgInit } = require("./lib/oracle-config");
const { verifyDeployment } = require("./verify");

const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
// Real role addresses: always on mainnet, and in a fork rehearsal when launch.env provides them.
const REAL_ROLES = network.name === "robinhood" || (LIVE && Boolean(process.env.ADMIN_MULTISIG));
const TIMELOCK_DELAY = config.launch.timelockDelaySeconds;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(18)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const roles = REAL_ROLES
    ? { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS") }
    : { admin: rest[0].address, guardian: rest[1].address, keeper: rest[2].address };
  await checkRoles(roles, deployer.address);

  console.log(`Deploying StockLane to ${network.name} from ${deployer.address}`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = { network: network.name, chainId, deployer: deployer.address, roles, startBlock: await ethers.provider.getBlockNumber() };

  const timelock = await deploy("TimelockController", [TIMELOCK_DELAY, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  out.timelock = await timelock.getAddress();

  const env = LIVE ? liveEnv() : await localEnv();
  Object.assign(out, { usdg: env.usdg, poolManager: env.poolManager, v3Factory: env.v3Factory, ponsHook: env.ponsHook });

  // DEPLOY_WITHOUT_TOKEN=1 makes the local demo start without $LANE too, to rehearse set-token.sh.
  const laneToken = LIVE
    ? process.env.LANE_TOKEN_ADDRESS
      ? await existingLaneToken(required("LANE_TOKEN_ADDRESS"))
      : null
    : process.env.DEPLOY_WITHOUT_TOKEN === "1"
      ? null
      : env.laneToken;
  out.laneToken = laneToken ? await laneToken.getAddress() : null;
  if (!laneToken) console.log(`  ${"$LANE".padEnd(18)} not launched yet: set it after the Pons launch with ./set-token.sh`);

  const tickers = Object.keys(env.stocks);
  const feedInits = [];
  for (const ticker of tickers) feedInits.push(LIVE ? await equityFeedInit(ethers, ticker) : localFeedInit(env.stocks[ticker]));
  const oracle = await deploy("LaneOracle", [
    out.timelock,
    env.sequencerFeed,
    LIVE ? await usdgInit(ethers) : localUsdgInit(env.usdgFeed),
    config.oracle.maxJumpBps,
    config.oracle.jumpCooldownSeconds,
    feedInits,
  ]);
  out.oracle = await oracle.getAddress();

  // The fee goes to FeeRouter, which needs DrawdownRetire, which needs the adapter, which needs the router.
  // So the FeeRouter address is computed ahead: router, adapter, DrawdownRetire, then FeeRouter.
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const feeRouterAddress = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

  const router = await deploy("LaneRouter", [
    {
      poolManager: env.poolManager,
      v3Factory: env.v3Factory,
      oracle: out.oracle,
      quoteToken: env.usdg,
      feeRecipient: feeRouterAddress,
      admin: out.timelock,
      guardian: roles.guardian,
      feeBps: config.launch.routerFeeBps,
      maxOracleDeviationBps: config.launch.maxOracleDeviationBps,
      hooks: [env.ponsHook],
    },
  ]);
  out.router = await router.getAddress();

  const adapter = await deploy("LaneRouterAdapter", [out.router]);
  out.adapter = await adapter.getAddress();

  // Small per-run buys: a fresh Pons pool holds a few ETH, so large buys move its price a lot.
  const inputTokens = [env.usdg, ...tickers.map((t) => env.stocks[t].address)];
  const inputLimits = [usdgUnits(config.launch.drawdownMaxUsdgPerRun), ...tickers.map(() => wad(config.launch.drawdownMaxEquityPerRun))];
  const drawdown = await deploy("DrawdownRetire", [
    out.laneToken ?? ethers.ZeroAddress,
    out.adapter,
    out.timelock,
    roles.guardian,
    roles.keeper,
    config.launch.drawdownMinIntervalSeconds,
    inputTokens,
    inputLimits,
  ]);
  out.drawdownRetire = await drawdown.getAddress();

  const feeRouter = await deploy("FeeRouter", [out.timelock, out.drawdownRetire]);
  out.feeRouter = await feeRouter.getAddress();
  if (out.feeRouter !== feeRouterAddress) throw new Error(`FeeRouter landed at ${out.feeRouter}, not ${feeRouterAddress}: do not use this deployment`);

  out.stocks = Object.fromEntries(tickers.map((t) => [t, { address: env.stocks[t].address, name: env.stocks[t].name, feed: env.stocks[t].feed }]));

  if (!LIVE) await seedLocal(out, env, rest);

  // Only a real mainnet deploy may write robinhood.json; a fork rehearsal always writes fork.json.
  const label = network.name === "robinhood" ? "robinhood" : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), file)}\n`);

  let failures;
  try {
    failures = await verifyDeployment(ethers, out, { requireMultisigs: REAL_ROLES && process.env.ALLOW_PLAIN_WALLETS !== "1" });
  } catch (e) {
    console.error(`\nThe contracts ARE deployed (${path.relative(process.cwd(), file)}), but verification could not finish:`);
    console.error(`  ${e.shortMessage || e.message}`);
    console.error("Do NOT deploy again. Run ./verify.sh to finish the checks.");
    process.exit(3);
  }
  if (failures) {
    console.error(`\n${failures} verification check(s) failed. Do not announce this deployment.`);
    process.exitCode = 1;
  }
}

async function checkRoles(roles, deployer) {
  const all = [roles.admin, roles.guardian, roles.keeper].map((a) => a.toLowerCase());
  if (new Set(all).size !== all.length) throw new Error("admin, guardian and keeper must be three different addresses");
  if (all.includes(deployer.toLowerCase())) throw new Error("the deployer must not hold any role: use a fresh wallet for deploying");
  if (REAL_ROLES && process.env.ALLOW_PLAIN_WALLETS !== "1") {
    for (const name of ["admin", "guardian"]) {
      if ((await ethers.provider.getCode(roles[name])) === "0x") throw new Error(`${name} ${roles[name]} must be a multisig contract, not a plain wallet`);
    }
  }
}

// DrawdownRetire calls burn(uint256) on $LANE, so reject anything that can't burn.
async function existingLaneToken(address) {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at LANE_TOKEN_ADDRESS ${address}`);
  const token = await ethers.getContractAt("LaneToken", address);
  const [symbol, decimals, supply] = await Promise.all([token.symbol(), token.decimals(), token.totalSupply()]);
  if (decimals !== 18n) throw new Error(`$LANE must have 18 decimals, got ${decimals}`);
  try {
    await token.burn.staticCall(0);
  } catch {
    throw new Error(`Token at ${address} does not support burn(uint256), which DrawdownRetire requires`);
  }
  console.log(`  ${"$LANE".padEnd(18)} ${address} (${symbol}, supply ${ethers.formatEther(supply)})`);
  return token;
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for live deploys`);
  return ethers.getAddress(v);
}

function liveEnv() {
  const stocks = {};
  for (const [ticker, t] of Object.entries(config.equityTokens)) stocks[ticker] = { address: t.address, feed: t.chainlinkFeed, name: t.name };
  return {
    usdg: config.tokens.usdg.address,
    poolManager: ethers.getAddress(config.uniswap.poolManager),
    v3Factory: ethers.getAddress(config.uniswap.v3Factory),
    ponsHook: ethers.getAddress(config.pons.hook),
    sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress,
    stocks,
  };
}

// ---------------------------------------------------------------- local demo

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 336.31, AMD: 162.5, META: 778.25, GOOGL: 342.66, SPY: 766.89 };
const ETH_USD = 3000;
const LANE_PER_USD = 100;

function localFeedInit(t) {
  const answer = BigInt(Math.round(t.price * 1e8));
  return { token: t.address, aggregator: t.feed, maxAge: config.chainlink.equityMaxAge, minAnswer: answer / 10n, maxAnswer: answer * 10n };
}

function localUsdgInit(feed) {
  return { feed, maxAge: config.chainlink.usdgMaxAge, decimals: 6, minAnswer: ethers.parseUnits(config.oracle.usdgMinUsd, 8), maxAnswer: ethers.parseUnits(config.oracle.usdgMaxUsd, 8) };
}

/** WAD rate: `outPerIn` output tokens per whole input token. */
function rate(outPerIn, inDecimals, outDecimals) {
  const scaled = BigInt(Math.round(outPerIn * 1e12));
  return (scaled * 10n ** BigInt(outDecimals) * 10n ** 18n) / (10n ** 12n * 10n ** BigInt(inDecimals));
}

function sortedKey(a, b, fee, tickSpacing, hooks = ethers.ZeroAddress) {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

async function localEnv() {
  console.log("Local demo: deploying mock USDG, $LANE, stock tokens, feeds and Uniswap v3/v4 pools");
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const pm = await deploy("MockPoolManager");
  const v3 = await deploy("MockV3Factory");
  const ponsHook = "0x0000000000000000000000000000000000000044"; // stands in for the Pons hook of the $LANE pool
  const laneToken = await deploy("LaneToken", [await pm.getAddress(), wad(1_000_000_000)]);
  await (await usdg.mint(pm, usdgUnits(100_000_000))).wait();

  const usdgAddr = await usdg.getAddress();
  const lane = await laneToken.getAddress();
  const setPool = async (key, aIsCurrency0, rAB, rBA) => (await pm.setPool(key, aIsCurrency0 ? rAB : rBA, aIsCurrency0 ? rBA : rAB)).wait();
  // USDG <-> ETH (v4, 0.01%) and ETH <-> $LANE (Pons pool), as on mainnet.
  let key = sortedKey(usdgAddr, ethers.ZeroAddress, 100, 1);
  await setPool(key, key.currency0 === usdgAddr, rate(1 / ETH_USD, 6, 18), rate(ETH_USD, 18, 6));
  key = sortedKey(ethers.ZeroAddress, lane, 0, 200, ponsHook);
  await setPool(key, true, rate(ETH_USD * LANE_PER_USD, 18, 18), rate(1 / (ETH_USD * LANE_PER_USD), 18, 18));

  const stocks = {};
  for (const [ticker, price] of Object.entries(DEMO_PRICES)) {
    const token = await deploy("MockStockToken", [`${config.equityTokens[ticker].name} Stock Token`, ticker]);
    const feed = await deploy("MockAggregator", [8, Math.round(price * 1e8)]);
    const addr = await token.getAddress();
    await (await token.mint(pm, wad(1_000_000))).wait();
    // A v4 pool at the oracle price and a v3 pool 0.4% off it, so the app's route finder has a choice.
    key = sortedKey(addr, usdgAddr, 3000, 60);
    await setPool(key, key.currency0 === addr, rate(price, 18, 6), rate(1 / price, 6, 18));
    await (await v3.createPool(addr, usdgAddr, 500, rate(price * 0.996, 18, 6), rate(1 / (price * 1.004), 6, 18))).wait();
    const pool = await v3.getPool(addr, usdgAddr, 500);
    await (await token.mint(pool, wad(100_000))).wait();
    await (await usdg.mint(pool, usdgUnits(50_000_000))).wait();
    stocks[ticker] = { address: addr, feed: await feed.getAddress(), name: config.equityTokens[ticker].name, price, token };
  }
  return {
    usdg: usdgAddr,
    usdgToken: usdg,
    usdgFeed: await usdgFeed.getAddress(),
    poolManager: await pm.getAddress(),
    v3Factory: await v3.getAddress(),
    ponsHook,
    sequencerFeed: ethers.ZeroAddress,
    stocks,
    laneToken,
  };
}

async function seedLocal(out, env, [, , , demoUser]) {
  console.log("Seeding the demo wallet");
  await (await env.usdgToken.mint(demoUser.address, usdgUnits(250_000))).wait();
  for (const t of Object.values(env.stocks)) await (await t.token.mint(demoUser.address, wad(100))).wait();
  out.demoUser = demoUser.address;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
