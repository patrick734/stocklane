const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, baseFixture } = require("./fixtures");

describe("FeeRouter and DrawdownRetire", function () {
  async function withFees() {
    const ctx = await baseFixture();
    await ctx.usdg.mint(ctx.feeRouter, USDG(300)); // swap fees collected by the router
    await ctx.drawdown.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(500));
    return ctx;
  }

  it("routes the whole protocol share to DrawdownRetire", async function () {
    const ctx = await loadFixture(withFees);
    await ctx.feeRouter.route(ctx.usdg);
    expect(await ctx.usdg.balanceOf(ctx.drawdown)).to.equal(USDG(300));
    expect(await ctx.feeRouter.totalRouted(ctx.usdg)).to.equal(USDG(300));
  });

  it("buys $LANE with fees and burns it", async function () {
    const ctx = await loadFixture(withFees);
    await ctx.feeRouter.route(ctx.usdg);
    const supplyBefore = await ctx.laneToken.totalSupply();

    await ctx.drawdown.connect(ctx.keeper).drawdown(ctx.usdg, USDG(300), EQ(29_000), "0x");

    expect(supplyBefore - (await ctx.laneToken.totalSupply())).to.equal(EQ(30_000));
    expect(await ctx.drawdown.totalRetired()).to.equal(EQ(30_000));
    expect(await ctx.laneToken.balanceOf(ctx.drawdown)).to.equal(0);
  });

  it("bounds each run by input cap, interval, keeper role and halt", async function () {
    const ctx = await loadFixture(withFees);
    await ctx.feeRouter.route(ctx.usdg);
    const d = ctx.drawdown;

    await expect(d.connect(ctx.alice).drawdown(ctx.usdg, USDG(10), 1, "0x")).to.be.reverted;
    await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(501), 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 0, "0x")).to.be.revertedWithCustomError(d, "OverLimit");

    await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(100), 1, "0x");
    await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(100), 1, "0x")).to.be.revertedWithCustomError(d, "TooSoon");

    await time.increase(3600);
    await d.connect(ctx.guardian).halt();
    await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(100), 1, "0x")).to.be.revertedWithCustomError(d, "IsHalted");
    await expect(d.connect(ctx.guardian).resume()).to.be.reverted;
    await d.connect(ctx.admin).resume();
    await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(100), 1, "0x");
  });

  it("retires $LANE sent to it directly", async function () {
    const ctx = await loadFixture(withFees);
    await ctx.laneToken.connect(ctx.admin).transfer(ctx.drawdown, EQ(5));
    await ctx.drawdown.connect(ctx.bob).retireHeld();
    expect(await ctx.drawdown.totalRetired()).to.equal(EQ(5));
  });

  it("delays FeeRouter destination changes by 48 hours", async function () {
    const ctx = await loadFixture(withFees);
    const r = ctx.feeRouter;
    await r.connect(ctx.admin).proposeDestination(ctx.carol.address);
    await expect(r.connect(ctx.admin).executeDestination()).to.be.revertedWithCustomError(r, "NotReady");
    await time.increase(48 * 3600);
    await r.connect(ctx.admin).executeDestination();
    expect(await r.drawdownRetire()).to.equal(ctx.carol.address);
  });
});
