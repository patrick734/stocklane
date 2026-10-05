// Price bounds and the round-to-round circuit breaker.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, BOUNDS, baseFixture, deployOracle } = require("./fixtures");

const Status = { Ok: 0, NoFeed: 1, SequencerDown: 2, CorporateAction: 3, Stale: 4, OutOfBounds: 5, Jump: 6, UsdgStale: 7, UsdgOutOfBounds: 8, UsdgJump: 9 };

describe("LaneOracle hardening", function () {
  // A tighter breaker than the base fixture: 10% moves within 15 minutes are held back.
  async function tight() {
    const ctx = await baseFixture();
    await ctx.oracle.connect(ctx.admin).setBreaker(1_000, 900);
    return ctx;
  }

  describe("circuit breaker", function () {
    it("accepts a move within the limit immediately", async function () {
      const ctx = await loadFixture(tight);
      await ctx.amd.feed.setAnswer(FEED(160)); // +6.7%
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Ok);
      expect(await ctx.oracle.price(ctx.amd.equity)).to.equal(FEED(160));
    });

    it("holds a jump until it is older than the cooldown, in both directions", async function () {
      const ctx = await loadFixture(tight);
      for (const next of [FEED(180), FEED(120)]) {
        await ctx.amd.feed.setAnswer(next);
        expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Jump);
        await expect(ctx.oracle.price(ctx.amd.equity))
          .to.be.revertedWithCustomError(ctx.oracle, "Unpriced")
          .withArgs(ctx.amd.equity.target, Status.Jump);
        await time.increase(899);
        expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Jump);
        await time.increase(1);
        expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Ok);
      }
    });

    it("treats a move of exactly maxJumpBps as within the limit", async function () {
      const ctx = await loadFixture(tight);
      await ctx.amd.feed.setAnswer(FEED(165)); // exactly +10%
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Ok);
    });

    it("holds a young answer whose previous round cannot be read", async function () {
      const ctx = await loadFixture(tight);
      await ctx.amd.feed.disableHistory(true);
      await ctx.amd.feed.setAnswer(FEED(150));
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Jump);
      await time.increase(900);
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.Ok);
    });

    it("applies to the USDG feed too", async function () {
      const ctx = await loadFixture(tight);
      await ctx.usdgFeed.setAnswer(FEED("0.8"));
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.UsdgJump);
    });

    it("makes LaneRouter skip its price guard during a jump, then resume it", async function () {
      const ctx = await loadFixture(tight);
      await ctx.amd.feed.setAnswer(FEED(200));
      // Unpriced: the guard is skipped and the swap relies on the trader's minOut.
      let r = await ctx.router.oracleCheck(ctx.usdg, USDG(150), ctx.amd.equity, EQ("0.1"));
      expect(r.ok).to.equal(true);
      expect(r.priced).to.equal(false);

      await time.increase(900);
      await ctx.amd.feed.setAnswer(FEED(200)); // feed updates again, no jump from the previous round
      r = await ctx.router.oracleCheck(ctx.usdg, USDG(150), ctx.amd.equity, EQ("0.1"));
      expect(r.priced).to.equal(true);
      expect(r.ok).to.equal(false); // 0.1 AMD at $200 is far below $150
    });

    it("can only be tuned within hard limits, never switched off", async function () {
      const ctx = await loadFixture(baseFixture);
      const o = ctx.oracle.connect(ctx.admin);
      for (const [bps, cd] of [[0, 300], [99, 300], [5_001, 300], [1_000, 299], [1_000, 86_401]]) {
        await expect(o.setBreaker(bps, cd)).to.be.revertedWithCustomError(o, "InvalidBreaker");
      }
      await expect(o.setBreaker(100, 86_400)).to.emit(o, "BreakerSet").withArgs(100, 86_400);
      await expect(ctx.oracle.connect(ctx.alice).setBreaker(100, 300)).to.be.revertedWithCustomError(o, "OwnableUnauthorizedAccount");
      await expect(deployOracle(ctx.admin, ctx.sequencer, ctx.usdgFeed, [], { bps: 0, cooldown: 300 })).to.be.revertedWithCustomError(
        o,
        "InvalidBreaker"
      );
    });
  });

  describe("price bounds", function () {
    it("treats an answer outside the feed's bounds as unpriced", async function () {
      const ctx = await loadFixture(baseFixture);
      const o = ctx.oracle.connect(ctx.admin);
      await o.setFeed(ctx.amd.equity, ctx.amd.feed, 3600, FEED(100), FEED(200));
      expect(await o.status(ctx.amd.equity)).to.equal(Status.Ok);
      await time.increase(300);
      await ctx.amd.feed.setAnswer(FEED(99));
      expect(await o.status(ctx.amd.equity)).to.equal(Status.OutOfBounds);
      await time.increase(300);
      await ctx.amd.feed.setAnswer(FEED(201));
      expect(await o.status(ctx.amd.equity)).to.equal(Status.OutOfBounds);
      await time.increase(300);
      await ctx.amd.feed.setAnswer(FEED(200));
      expect(await o.status(ctx.amd.equity)).to.equal(Status.Ok);
      await expect(o.usdgValue(ctx.amd.equity, EQ(1))).to.not.be.reverted;
    });

    it("treats a USDG answer outside its bounds as unpriced", async function () {
      const ctx = await loadFixture(baseFixture);
      await ctx.usdgFeed.setAnswer(FEED("0.49"));
      expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.UsdgOutOfBounds);
      expect(await ctx.oracle.usdgMinAnswer()).to.equal(FEED("0.5"));
    });

    it("rejects empty or inverted bounds", async function () {
      const ctx = await loadFixture(baseFixture);
      const o = ctx.oracle.connect(ctx.admin);
      await expect(o.setFeed(ctx.amd.equity, ctx.amd.feed, 3600, 0, FEED(200))).to.be.revertedWithCustomError(o, "InvalidFeed");
      await expect(o.setFeed(ctx.amd.equity, ctx.amd.feed, 3600, FEED(200), FEED(200))).to.be.revertedWithCustomError(o, "InvalidFeed");
      await expect(o.setFeed(ethers.ZeroAddress, ctx.amd.feed, 3600, BOUNDS.min, BOUNDS.max)).to.be.revertedWithCustomError(o, "InvalidFeed");
    });
  });

  it("reports why a token is unpriced", async function () {
    const ctx = await loadFixture(baseFixture);
    expect(await ctx.oracle.status(ctx.usdg)).to.equal(Status.NoFeed);
    await ctx.amd.equity.setOraclePaused(true);
    expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.CorporateAction);
    await ctx.amd.equity.setOraclePaused(false);
    const now = await time.latest();
    await ctx.sequencer.set(1, now, now);
    expect(await ctx.oracle.status(ctx.amd.equity)).to.equal(Status.SequencerDown);
  });
});
