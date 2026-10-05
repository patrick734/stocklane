// The deployer must end up with no power, and every admin action must wait out the 48h timelock.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, DELAY, baseFixture, deployOracle, deployRouter, viaTimelock } = require("./fixtures");

describe("Governance", function () {
  describe("the deployer keeps no power", function () {
    it("holds no role on any AccessControl contract", async function () {
      const ctx = await loadFixture(baseFixture);
      for (const c of [ctx.router, ctx.drawdown]) {
        const roles = [await c.DEFAULT_ADMIN_ROLE(), await c.GUARDIAN_ROLE()];
        if (c === ctx.drawdown) roles.push(await c.KEEPER_ROLE());
        for (const role of roles) {
          expect(await c.hasRole(role, ctx.deployer.address)).to.equal(false);
        }
        expect(await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), ctx.timelock.target)).to.equal(true);
      }
    });

    it("owns none of the Ownable contracts, which have no pending owner", async function () {
      const ctx = await loadFixture(baseFixture);
      for (const c of [ctx.oracle, ctx.feeRouter]) {
        expect(await c.owner()).to.equal(ctx.timelock.target);
        expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
      }
    });

    it("cannot call any admin function", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = ctx.deployer;
      for (const call of [
        () => ctx.router.connect(d).setFeeBps(1),
        () => ctx.router.connect(d).setMaxOracleDeviationBps(1),
        () => ctx.router.connect(d).setHookAllowed(d.address, true),
        () => ctx.router.connect(d).pause(),
        () => ctx.router.connect(d).unpause(),
        () => ctx.router.connect(d).sweep(ctx.usdg, d.address),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(ctx.router, "AccessControlUnauthorizedAccount");
      }
      await expect(ctx.drawdown.connect(d).setInputLimit(ctx.usdg, 1)).to.be.revertedWithCustomError(ctx.drawdown, "AccessControlUnauthorizedAccount");
      await expect(ctx.oracle.connect(d).setBreaker(100, 300)).to.be.revertedWithCustomError(ctx.oracle, "OwnableUnauthorizedAccount");
      await expect(ctx.feeRouter.connect(d).proposeDestination(d.address)).to.be.revertedWithCustomError(ctx.feeRouter, "OwnableUnauthorizedAccount");
      const tl = ctx.timelock.connect(d);
      await expect(tl.schedule(ctx.oracle, 0, "0x", ethers.ZeroHash, ethers.ZeroHash, DELAY)).to.be.revertedWithCustomError(
        ctx.timelock,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("constructor checks on the admin", function () {
    async function timelock(delay, proposers, executors, admin = ethers.ZeroAddress) {
      return ethers.deployContract("TimelockController", [delay, proposers, executors, admin]);
    }

    it("rejects a timelock shorter than 48 hours", async function () {
      const ctx = await loadFixture(baseFixture);
      const short = await timelock(DELAY - 1, [ctx.multisig.address], [ctx.multisig.address]);
      const F = await ethers.getContractFactory("FeeRouter");
      await expect(F.deploy(short, ctx.drawdown))
        .to.be.revertedWithCustomError(F, "TimelockDelayTooShort")
        .withArgs(DELAY - 1);
    });

    it("rejects a timelock the deployer can administer, propose to, execute on or cancel", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("FeeRouter");
      const ms = ctx.multisig.address;
      const d = ctx.deployer.address;
      for (const tl of [
        await timelock(DELAY, [ms], [ms], d),
        await timelock(DELAY, [d], [ms]),
        await timelock(DELAY, [ms], [d]),
      ]) {
        await expect(F.deploy(tl, ctx.drawdown)).to.be.revertedWithCustomError(F, "DeployerControlsTimelock").withArgs(d);
      }
    });

    it("rejects a plain account and a contract that is not a timelock", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("FeeRouter");
      await expect(F.deploy(ctx.multisig.address, ctx.drawdown)).to.be.revertedWithCustomError(F, "AdminNotTimelock");
      await expect(F.deploy(ctx.usdg, ctx.drawdown)).to.be.revertedWithCustomError(F, "AdminNotTimelock");
    });

    it("accepts the same timelock when someone other than its controllers deploys", async function () {
      const ctx = await loadFixture(baseFixture);
      const router = await ethers.deployContract("FeeRouter", [ctx.timelock, ctx.drawdown], ctx.alice);
      expect(await router.owner()).to.equal(ctx.timelock.target);
    });
  });

  describe("admin actions through the timelock", function () {
    it("cannot execute before the delay, and works after it", async function () {
      const ctx = await loadFixture(baseFixture);
      const lane = ctx.router;
      const data = lane.interface.encodeFunctionData("setFeeBps", [20]);
      const tl = ctx.timelock.connect(ctx.multisig);
      await tl.schedule(lane, 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY);
      await expect(tl.execute(lane, 0, data, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ctx.timelock,
        "TimelockUnexpectedOperationState"
      );
      await expect(tl.schedule(lane, 0, data, ethers.ZeroHash, ethers.id("other"), DELAY - 1)).to.be.revertedWithCustomError(
        ctx.timelock,
        "TimelockInsufficientDelay"
      );
      await time.increase(DELAY);
      await tl.execute(lane, 0, data, ethers.ZeroHash, ethers.ZeroHash);
      expect(await lane.feeBps()).to.equal(20);
    });

    it("caps the swap fee in code, even for the timelock", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(ctx.router.connect(ctx.admin).setFeeBps(31)).to.be.revertedWithCustomError(ctx.router, "InvalidConfig");
      await expect(ctx.router.connect(ctx.admin).setMaxOracleDeviationBps(1_001)).to.be.revertedWithCustomError(ctx.router, "InvalidConfig");
      await expect(ctx.router.connect(ctx.admin).setMaxOracleDeviationBps(0)).to.be.revertedWithCustomError(ctx.router, "InvalidConfig");
      await viaTimelock(ctx, ctx.router, "setFeeBps", [30]);
      expect(await ctx.router.feeBps()).to.equal(30);
    });

    it("lets the guardian pause swaps but only the timelock unpause", async function () {
      const ctx = await loadFixture(baseFixture);
      await ctx.router.connect(ctx.guardian).pause();
      await expect(ctx.router.connect(ctx.guardian).unpause()).to.be.revertedWithCustomError(ctx.router, "AccessControlUnauthorizedAccount");
      await viaTimelock(ctx, ctx.router, "unpause");
      expect(await ctx.router.paused()).to.equal(false);
    });

    it("rejects a LaneRouter whose admin is not a safe timelock", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("LaneRouter");
      await expect(deployRouter(ctx, { admin: ctx.multisig.address })).to.be.revertedWithCustomError(F, "AdminNotTimelock");
      await expect(deployRouter(ctx, { guardian: ctx.deployer.address })).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deployRouter(ctx, { guardian: ctx.admin.address })).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deployRouter(ctx, { feeBps: 31 })).to.be.revertedWithCustomError(F, "InvalidConfig");
    });

    it("changes the circuit breaker through the timelock only", async function () {
      const ctx = await loadFixture(baseFixture);
      await viaTimelock(ctx, ctx.oracle, "setBreaker", [1_000, 600]);
      expect(await ctx.oracle.maxJumpBps()).to.equal(1_000);
      expect(await ctx.oracle.jumpCooldown()).to.equal(600);
    });
  });

  it("deploys an oracle with its feeds already configured", async function () {
    const ctx = await loadFixture(baseFixture);
    const feed = await ethers.deployContract("MockAggregator", [8, 15_000_000_000n]);
    const oracle = await deployOracle(ctx.admin, ctx.sequencer, ctx.usdgFeed, [
      { token: ctx.amd.equity.target, aggregator: feed.target, maxAge: 3600, minAnswer: 1n, maxAnswer: 10n ** 20n },
    ]);
    expect((await oracle.feeds(ctx.amd.equity)).aggregator).to.equal(feed.target);
    expect(await oracle.isFresh(ctx.amd.equity)).to.equal(true);
  });
});
