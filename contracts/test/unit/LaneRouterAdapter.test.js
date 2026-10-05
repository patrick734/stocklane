const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, rate, frac, baseFixture, deployRouter, v4Pool, v3Pool, v3Hop, v4Hop } = require("./fixtures");

const ETH = ethers.ZeroAddress;
const LEGS = "tuple(uint256 amountIn, tuple(uint8 kind, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)[] hops)[]";
const encode = (legs) => ethers.AbiCoder.defaultAbiCoder().encode([LEGS], [legs]);

describe("Buy-and-burn through LaneRouter", function () {
  // $LANE trades against native ETH in a Pons pool (fee 0, tick spacing 200, Pons hook), like on mainnet.
  async function burnFixture() {
    const ctx = await baseFixture();
    const pons = ctx.carol.address; // stands in for the Pons hook address
    const router = await deployRouter(ctx, { hooks: [pons] });
    const adapter = await ethers.deployContract("LaneRouterAdapter", [router]);
    const drawdown = await ethers.deployContract("DrawdownRetire", [
      ctx.laneToken,
      adapter,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      3600,
      [ctx.usdg, ctx.amd.equity],
      [USDG(250), EQ("0.5")],
    ]);
    await ctx.laneToken.connect(ctx.admin).transfer(ctx.poolManager, EQ(10_000_000));
    await v4Pool(ctx.poolManager, ctx.usdg, ETH, frac(1, 3000, 6, 18), rate(3000, 18, 6), 100, 1);
    await v4Pool(ctx.poolManager, ETH, ctx.laneToken, rate(300_000, 18, 18), frac(1, 300_000, 18, 18), 0, 200, pons);
    const v3 = await v3Pool(ctx.v3Factory, ctx.amd.equity, ctx.usdg, 500, rate(150, 18, 6), frac(1, 150, 6, 18));
    await ctx.usdg.mint(v3, USDG(1_000_000));
    return { ...ctx, pons, router, adapter, drawdown };
  }

  const net = (n) => n - (n * 5n) / 10_000n;
  it("burns $LANE bought with USDG fees via USDG -> ETH -> $LANE (Pons pool)", async function () {
    const ctx = await loadFixture(burnFixture);
    await ctx.usdg.mint(ctx.drawdown, USDG(250));
    const legs = [{ amountIn: net(USDG(250)), hops: [v4Hop(ETH, 100, 1), v4Hop(ctx.laneToken, 0, 200, ctx.pons)] }];
    const supply = await ctx.laneToken.totalSupply();
    await ctx.drawdown.connect(ctx.keeper).drawdown(ctx.usdg, USDG(250), EQ(24_000), encode(legs));
    const burned = supply - (await ctx.laneToken.totalSupply());
    expect(burned).to.be.closeTo((net(USDG(250)) * 10n ** 12n * 100n), EQ("0.001")); // 1 USDG = 100 $LANE
    expect(await ctx.drawdown.totalRetired()).to.equal(burned);
    expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(250) - net(USDG(250))); // the router's own fee
    for (const a of [ctx.adapter, ctx.router]) {
      expect(await ctx.usdg.balanceOf(a)).to.equal(0n);
      expect(await ctx.laneToken.balanceOf(a)).to.equal(0n);
    }
  });

  it("burns $LANE bought with stock-token fees via a v3 pool first", async function () {
    const ctx = await loadFixture(burnFixture);
    await ctx.amd.equity.mint(ctx.drawdown, EQ("0.5"));
    const legs = [
      { amountIn: net(EQ("0.5")), hops: [v3Hop(ctx.usdg, 500), v4Hop(ETH, 100, 1), v4Hop(ctx.laneToken, 0, 200, ctx.pons)] },
    ];
    await ctx.drawdown.connect(ctx.keeper).drawdown(ctx.amd.equity, EQ("0.5"), 1, encode(legs));
    expect(await ctx.drawdown.totalRetired()).to.be.closeTo(EQ(7_496), EQ(1)); // ~$74.96 at 100 $LANE per dollar
  });

  it("enforces the keeper's minimum and rejects an empty route", async function () {
    const ctx = await loadFixture(burnFixture);
    await ctx.usdg.mint(ctx.drawdown, USDG(250));
    const legs = [{ amountIn: net(USDG(250)), hops: [v4Hop(ETH, 100, 1), v4Hop(ctx.laneToken, 0, 200, ctx.pons)] }];
    await expect(ctx.drawdown.connect(ctx.keeper).drawdown(ctx.usdg, USDG(250), EQ(30_000), encode(legs))).to.be.reverted;
    await expect(ctx.drawdown.connect(ctx.keeper).drawdown(ctx.usdg, USDG(250), 1, "0x")).to.be.revertedWithCustomError(
      ctx.adapter,
      "InvalidRoute"
    );
  });

  it("cannot reach the Pons pool if the router has not allowlisted its hook", async function () {
    const ctx = await loadFixture(burnFixture);
    await ctx.router.connect(ctx.admin).setHookAllowed(ctx.pons, false);
    await ctx.usdg.mint(ctx.drawdown, USDG(250));
    const legs = [{ amountIn: net(USDG(250)), hops: [v4Hop(ETH, 100, 1), v4Hop(ctx.laneToken, 0, 200, ctx.pons)] }];
    await expect(ctx.drawdown.connect(ctx.keeper).drawdown(ctx.usdg, USDG(250), 1, encode(legs))).to.be.revertedWithCustomError(
      ctx.router,
      "InvalidRoute"
    );
  });
});
