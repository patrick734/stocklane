const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const FEED = (n) => ethers.parseUnits(String(n), 8);
const WAD = 10n ** 18n;
const DELAY = 48 * 3600;

// Oracle defaults used by every fixture: generous bounds, a 50% / 5-minute circuit breaker.
const BOUNDS = { min: FEED("0.01"), max: FEED(1_000_000) };
const USDG_BOUNDS = { min: FEED("0.5"), max: FEED("1.5") };
const BREAKER = { bps: 5_000, cooldown: 300 };

/** Rate for MockSwapAdapter: out = in * rate / 1e18. */
function rate(outPerInUnit, inDecimals, outDecimals) {
  return (ethers.parseUnits(String(outPerInUnit), outDecimals) * WAD) / 10n ** BigInt(inDecimals);
}

/** Exact rate for `num / den` output units per input unit. */
function frac(num, den, inDecimals, outDecimals) {
  return (BigInt(num) * 10n ** BigInt(outDecimals) * WAD) / (BigInt(den) * 10n ** BigInt(inDecimals));
}

/**
 * Deploys a real OpenZeppelin TimelockController (48h, proposer/executor = `multisig`, no admin) and
 * returns it with an impersonated signer for its address. Unit tests call admin functions through that
 * signer to exercise contract logic directly; governance.test.js covers the schedule/execute path.
 */
async function deployTimelock(multisig) {
  const timelock = await ethers.deployContract("TimelockController", [DELAY, [multisig.address], [multisig.address], ethers.ZeroAddress]);
  await network.provider.send("hardhat_setBalance", [timelock.target, "0x56BC75E2D63100000"]);
  const admin = await ethers.getImpersonatedSigner(timelock.target);
  return { timelock, admin };
}

function feedInit(token, feed, maxAge = 3600, bounds = BOUNDS) {
  return { token: token.target ?? token, aggregator: feed.target ?? feed, maxAge, minAnswer: bounds.min, maxAnswer: bounds.max };
}

async function deployOracle(admin, sequencer, usdgFeed, feeds = [], breaker = BREAKER) {
  return ethers.deployContract("LaneOracle", [
    admin.address ?? admin,
    sequencer,
    { feed: usdgFeed, maxAge: 90_000, decimals: 6, minAnswer: USDG_BOUNDS.min, maxAnswer: USDG_BOUNDS.max },
    breaker.bps,
    breaker.cooldown,
    feeds,
  ]);
}

/** A stock token with its Chainlink feed registered in the oracle. */
async function deployStock(ctx, ticker, price) {
  const { admin, oracle } = ctx;
  const equity = await ethers.deployContract("MockStockToken", [`${ticker} Stock Token`, ticker]);
  const feed = await ethers.deployContract("MockAggregator", [8, FEED(price)]);
  await oracle.connect(admin).setFeed(equity, feed, 3600, BOUNDS.min, BOUNDS.max);
  return { equity, feed };
}

/** Sorted v4 PoolKey for two tokens. */
function poolKey(a, b, fee = 3000, tickSpacing = 60, hooks = ethers.ZeroAddress) {
  const x = a.target ?? a;
  const y = b.target ?? b;
  const [c0, c1] = BigInt(x) < BigInt(y) ? [x, y] : [y, x];
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks };
}

/** Registers a mock v4 pool trading `a` for `b` at `rateAB` and back at `rateBA`. */
async function v4Pool(pm, a, b, rateAB, rateBA, fee = 3000, tickSpacing = 60, hooks = ethers.ZeroAddress) {
  const key = poolKey(a, b, fee, tickSpacing, hooks);
  const aFirst = key.currency0 === (a.target ?? a);
  await pm.setPool(key, aFirst ? rateAB : rateBA, aFirst ? rateBA : rateAB);
  return key;
}

/** Creates a mock v3 pool and funds it. */
async function v3Pool(factory, a, b, fee, rateAB, rateBA) {
  await factory.createPool(a, b, fee, rateAB, rateBA);
  return ethers.getContractAt("MockV3Pool", await factory.getPool(a, b, fee));
}

const v3Hop = (tokenOut, fee = 3000) => ({ kind: 0, tokenOut: tokenOut.target ?? tokenOut, fee, tickSpacing: 0, hooks: ethers.ZeroAddress });
const v4Hop = (tokenOut, fee = 3000, tickSpacing = 60, hooks = ethers.ZeroAddress) => ({
  kind: 1,
  tokenOut: tokenOut.target ?? tokenOut,
  fee,
  tickSpacing,
  hooks: hooks.target ?? hooks,
});

async function deployRouter(ctx, overrides = {}) {
  return ethers.deployContract("LaneRouter", [
    {
      poolManager: ctx.poolManager.target,
      v3Factory: ctx.v3Factory.target,
      oracle: ctx.oracle.target,
      quoteToken: ctx.usdg.target,
      feeRecipient: ctx.feeRouter.target,
      admin: ctx.admin.address,
      guardian: ctx.guardian.address,
      feeBps: 5,
      maxOracleDeviationBps: 300,
      hooks: [],
      ...overrides,
    },
  ]);
}

async function baseFixture() {
  const [deployer, multisig, guardian, keeper, alice, bob, carol] = await ethers.getSigners();
  const { timelock, admin } = await deployTimelock(multisig);

  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const sequencer = await ethers.deployContract("MockAggregator", [0, 0]);
  const now = await time.latest();
  await sequencer.set(0, now - 7200, now);
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
  const oracle = await deployOracle(admin, sequencer, usdgFeed);

  const swap = await ethers.deployContract("MockSwapAdapter");
  const laneToken = await ethers.deployContract("LaneToken", [admin.address, EQ(1_000_000_000)]);
  const drawdown = await ethers.deployContract("DrawdownRetire", [
    laneToken,
    swap,
    admin.address,
    guardian.address,
    keeper.address,
    3600,
    [],
    [],
  ]);
  const feeRouter = await ethers.deployContract("FeeRouter", [admin.address, drawdown]);

  await usdg.mint(swap, USDG(100_000_000));
  await laneToken.connect(admin).transfer(swap, EQ(100_000_000));
  await swap.setRate(usdg, laneToken, rate(100, 6, 18));

  for (const user of [alice, bob, carol]) await usdg.mint(user, USDG(1_000_000));

  const v3Factory = await ethers.deployContract("MockV3Factory");
  const poolManager = await ethers.deployContract("MockPoolManager");
  await usdg.mint(poolManager, USDG(100_000_000));

  const ctx = { deployer, multisig, timelock, admin, guardian, keeper, alice, bob, carol, usdg, usdgFeed, sequencer, oracle, swap, laneToken, drawdown, feeRouter, v3Factory, poolManager };
  const amd = await deployStock(ctx, "AMD", 150);
  await amd.equity.mint(poolManager, EQ(1_000_000));
  const router = await deployRouter(ctx);
  return { ...ctx, amd, router };
}

/** Schedules `target.fn(...args)` on the timelock from the multisig, waits the delay, executes it. */
async function viaTimelock(ctx, target, fn, args = [], salt = ethers.ZeroHash) {
  const data = target.interface.encodeFunctionData(fn, args);
  const tl = ctx.timelock.connect(ctx.multisig);
  await tl.schedule(target, 0, data, ethers.ZeroHash, salt, DELAY);
  await time.increase(DELAY);
  return tl.execute(target, 0, data, ethers.ZeroHash, salt);
}

module.exports = { USDG, EQ, FEED, WAD, DELAY, BOUNDS, USDG_BOUNDS, BREAKER, rate, frac, deployTimelock, feedInit, deployOracle, deployStock, deployRouter, poolKey, v4Pool, v3Pool, v3Hop, v4Hop, baseFixture, viaTimelock };
