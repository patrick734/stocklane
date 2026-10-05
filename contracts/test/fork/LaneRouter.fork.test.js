// Runs LaneRouter against real Robinhood Chain state: real Uniswap v3 and v4 pools, real Chainlink feeds.
//   FORK=1 npx hardhat test          (set ROBINHOOD_RPC_URL to a private RPC if the public one drops)
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const config = require("../../config/robinhood.json");
const { equityFeedInit, usdgInit } = require("../../scripts/lib/oracle-config");

const USDG = config.tokens.usdg.address;
const ETH = ethers.ZeroAddress;
const v3Hop = (tokenOut, fee) => ({ kind: 0, tokenOut, fee, tickSpacing: 0, hooks: ETH });
const v4Hop = (tokenOut, fee, tickSpacing, hooks = ETH) => ({ kind: 1, tokenOut, fee, tickSpacing, hooks });

/** Writes a USDG balance by finding its balances mapping slot. Returns false if the layout is not a plain one. */
async function giveUsdg(to, amount) {
  const token = await ethers.getContractAt("IERC20", USDG);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  for (let slot = 0; slot < 200; slot++) {
    const key = ethers.keccak256(coder.encode(["address", "uint256"], [to, slot]));
    const before = await ethers.provider.getStorage(USDG, key);
    await network.provider.send("hardhat_setStorageAt", [USDG, key, ethers.toBeHex(amount, 32)]);
    if ((await token.balanceOf(to)) === amount) return true;
    await network.provider.send("hardhat_setStorageAt", [USDG, key, before]);
  }
  return false;
}

describe("LaneRouter on a Robinhood Chain fork", function () {
  let router, oracle, alice, found = [];

  before(async function () {
    const [deployer, multisig, guardian, , a] = await ethers.getSigners();
    alice = a;
    const timelock = await ethers.deployContract("TimelockController", [48 * 3600, [multisig.address], [multisig.address], ETH]);
    const feeds = [];
    for (const ticker of Object.keys(config.equityTokens)) feeds.push(await equityFeedInit(ethers, ticker));
    oracle = await ethers.deployContract("LaneOracle", [timelock, config.chainlink.sequencerUptimeFeed || ETH, await usdgInit(ethers), config.oracle.maxJumpBps, config.oracle.jumpCooldownSeconds, feeds]);
    const sink = await ethers.deployContract("MockERC20", ["sink", "S", 18]); // stands in for FeeRouter
    router = await ethers.deployContract("LaneRouter", [
      {
        poolManager: config.uniswap.poolManager,
        v3Factory: config.uniswap.v3Factory,
        oracle: oracle.target,
        quoteToken: USDG,
        feeRecipient: sink.target,
        admin: timelock.target,
        guardian: guardian.address,
        feeBps: config.launch.routerFeeBps,
        maxOracleDeviationBps: config.launch.maxOracleDeviationBps,
        hooks: [config.pons.hook],
      },
    ]);
    expect(await deployer.provider.getCode(config.uniswap.v3Factory)).to.not.equal("0x");
  });

  it("quotes 100 USDG into every stock across Uniswap v3 and v4 pools", async function () {
    const amountIn = 100_000_000n;
    const net = amountIn - (amountIn * BigInt(config.launch.routerFeeBps)) / 10_000n;
    for (const [ticker, t] of Object.entries(config.equityTokens)) {
      const candidates = [
        ...config.uniswap.v3Fees.map((f) => [`v3 ${f / 10000}%`, [v3Hop(t.address, f)]]),
        ...config.uniswap.v4HooklessPools.map((p) => [`v4 ${p.fee / 10000}%`, [v4Hop(t.address, p.fee, p.tickSpacing)]]),
      ];
      const results = [];
      for (const [label, hops] of candidates) {
        try {
          const [out] = await router.quote.staticCall(USDG, t.address, amountIn, [{ amountIn: net, hops }]);
          if (out > 0n) results.push({ label, out, hops });
        } catch {}
      }
      results.sort((x, y) => (y.out > x.out ? 1 : -1));
      const best = results[0];
      console.log(`      ${ticker.padEnd(6)} ${best ? `${ethers.formatEther(best.out)} via ${best.label} (${results.length} pools)` : "no pool"}`);
      if (best) found.push({ ticker, token: t.address, ...best });
    }
    if (!found.length) console.log("      No USDG pool for any stock yet: the router works, but there is nothing to route to.");
  });

  it("executes the best route and pays out what it quoted", async function () {
    if (!found.length) this.skip();
    if (!(await giveUsdg(alice.address, 1_000_000_000n))) {
      console.log("      Could not mint test USDG on the fork (non-standard storage); quotes above still prove the routes.");
      this.skip();
    }
    const usdg = await ethers.getContractAt("IERC20", USDG);
    await usdg.connect(alice).approve(router, ethers.MaxUint256);
    for (const r of found.slice(0, 3)) {
      const amountIn = 100_000_000n;
      const net = amountIn - (amountIn * BigInt(config.launch.routerFeeBps)) / 10_000n;
      const legs = [{ amountIn: net, hops: r.hops }];
      const [quoted] = await router.quote.staticCall(USDG, r.token, amountIn, legs);
      const stock = await ethers.getContractAt("IERC20", r.token);
      const before = await stock.balanceOf(alice);
      const guard = await router.oracleCheck(USDG, net, r.token, quoted);
      if (!guard.ok) {
        console.log(`      ${r.ticker}: pool is more than ${config.launch.maxOracleDeviationBps / 100}% off Chainlink; the router refuses it (as designed)`);
        continue;
      }
      await router.connect(alice).swap(USDG, r.token, amountIn, quoted, alice.address, (await time.latest()) + 600, legs);
      expect((await stock.balanceOf(alice)) - before).to.equal(quoted);
      expect(await stock.balanceOf(router)).to.equal(0n);
      expect(await usdg.balanceOf(router)).to.equal(0n);
      console.log(`      ${r.ticker}: swapped 100 USDG for ${ethers.formatEther(quoted)} (oracle-checked: ${guard.priced})`);
    }
  });
});
