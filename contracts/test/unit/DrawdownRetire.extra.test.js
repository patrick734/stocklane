const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, baseFixture } = require("./fixtures");

describe("DrawdownRetire (extra coverage)", function () {
  async function funded() {
    const ctx = await baseFixture();
    await ctx.usdg.mint(ctx.drawdown, USDG(10_000));
    await ctx.drawdown.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(1_000));
    return ctx;
  }

  describe("constructor", function () {
    it("rejects a token without code and a zero swap adapter", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("DrawdownRetire");
      const base = [ctx.laneToken.target, ctx.swap.target, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 3600, [], []];
      for (const [idx, value] of [[0, ctx.alice.address], [1, ethers.ZeroAddress]]) {
        const args = [...base];
        args[idx] = value;
        await expect(F.deploy(...args)).to.be.revertedWithCustomError(F, "InvalidConfig");
      }
    });

    it("rejects an admin that is not a timelock, and zero or colliding roles", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("DrawdownRetire");
      const deploy = (admin, guardian, keeper) => F.deploy(ctx.laneToken, ctx.swap, admin, guardian, keeper, 3600, [], []);
      await expect(deploy(ctx.alice.address, ctx.guardian.address, ctx.keeper.address)).to.be.revertedWithCustomError(F, "AdminNotTimelock");
      await expect(deploy(ctx.admin.address, ethers.ZeroAddress, ctx.keeper.address)).to.be.revertedWithCustomError(F, "RoleCollision");
      await expect(deploy(ctx.admin.address, ctx.guardian.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "RoleCollision");
      await expect(deploy(ctx.admin.address, ctx.deployer.address, ctx.keeper.address)).to.be.revertedWithCustomError(F, "RoleCollision");
    });

    it("sets input limits atomically in the constructor and rejects bad lists", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("DrawdownRetire");
      const deploy = (tokens, limits) =>
        F.deploy(ctx.laneToken, ctx.swap, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0, tokens, limits);
      const d = await deploy([ctx.usdg.target], [USDG(250)]);
      expect(await d.maxInputPerRun(ctx.usdg)).to.equal(USDG(250));
      await expect(deploy([ctx.usdg.target], [])).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deploy([ctx.laneToken.target], [1])).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deploy([ethers.ZeroAddress], [1])).to.be.revertedWithCustomError(F, "InvalidConfig");
    });

    it("wires immutables and roles", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = ctx.drawdown;
      expect(await d.laneToken()).to.equal(ctx.laneToken.target);
      expect(await d.swapAdapter()).to.equal(ctx.swap.target);
      expect(await d.minInterval()).to.equal(3600);
      expect(await d.lastDrawdown()).to.equal(0);
      expect(await d.halted()).to.equal(false);
      expect(await d.hasRole(await d.KEEPER_ROLE(), ctx.keeper.address)).to.equal(true);
      expect(await d.hasRole(await d.GUARDIAN_ROLE(), ctx.guardian.address)).to.equal(true);
    });
  });

  it("exposes no withdrawal, rescue or sweep path", async function () {
    const ctx = await loadFixture(baseFixture);
    const names = ctx.drawdown.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const n of names) {
      expect(n).to.not.match(/withdraw|rescue|sweep|recover|transfer|skim|approve|execute|call/);
    }
    // The only state-changing functions:
    const mutating = ctx.drawdown.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    expect(mutating).to.deep.equal(
      [
        "drawdown",
        "grantRole",
        "halt",
        "renounceRole",
        "resume",
        "retireHeld",
        "revokeRole",
        "setInputLimit",
        "setMinInterval",
        "setLaneToken",
      ].sort()
    );
  });

  describe("per-run limits", function () {
    it("rejects $LANE as the input even with a limit set", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await d.connect(ctx.admin).setInputLimit(ctx.laneToken, EQ(1_000));
      await ctx.laneToken.connect(ctx.admin).transfer(d, EQ(10));
      await expect(d.connect(ctx.keeper).drawdown(ctx.laneToken, EQ(1), 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });

    it("rejects a zero amount and a token with no limit", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, 0, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
      const other = await ethers.deployContract("MockERC20", ["Other", "OTH", 18]);
      await other.mint(d, EQ(1));
      await expect(d.connect(ctx.keeper).drawdown(other, 1, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });

    it("accepts exactly the per-run limit and tracks spend per token", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(1_000), EQ(100_000), "0x"))
        .to.emit(d, "Drawdown")
        .withArgs(ctx.usdg.target, USDG(1_000), EQ(100_000))
        .and.to.emit(d, "Retired")
        .withArgs(EQ(100_000), EQ(100_000));
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(1_000));
      expect(await ctx.usdg.allowance(d, ctx.swap)).to.equal(0);
      expect(await d.lastDrawdown()).to.equal(await time.latest());
    });

    it("reverts when the adapter cannot meet minLaneOut", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(100), EQ(10_000) + 1n, "0x")).to.be.reverted;
      expect(await d.totalSpent(ctx.usdg)).to.equal(0);
      expect(await d.lastDrawdown()).to.equal(0);
    });

    it("limit changes are admin-only and can close a token", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      for (const s of [ctx.guardian, ctx.keeper, ctx.alice]) {
        await expect(d.connect(s).setInputLimit(ctx.usdg, 1)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      }
      await expect(d.connect(ctx.admin).setInputLimit(ctx.usdg, 0)).to.emit(d, "InputLimitSet").withArgs(ctx.usdg.target, 0);
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, 1, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });
  });

  describe("minimum interval", function () {
    it("allows the next run exactly at lastDrawdown + minInterval, not a second earlier", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x");
      const last = Number(await d.lastDrawdown());
      await time.setNextBlockTimestamp(last + 3599);
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x")).to.be.revertedWithCustomError(d, "TooSoon");
      await time.setNextBlockTimestamp(last + 3600);
      await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x");
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(20));
    });

    it("setMinInterval is admin-only; zero allows back-to-back runs", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.guardian).setMinInterval(0)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.keeper).setMinInterval(0)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.admin).setMinInterval(0)).to.emit(d, "MinIntervalSet").withArgs(0);
      expect(await d.minInterval()).to.equal(0);
      await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x");
      await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x");
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(20));

      await d.connect(ctx.admin).setMinInterval(86_400);
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(10), 1, "0x")).to.be.revertedWithCustomError(d, "TooSoon");
    });
  });

  describe("halt", function () {
    it("only the guardian halts; only the admin resumes", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.admin).halt()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.keeper).halt()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.guardian).halt()).to.emit(d, "HaltSet").withArgs(true);
      expect(await d.halted()).to.equal(true);
      await expect(d.connect(ctx.keeper).resume()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.admin).resume()).to.emit(d, "HaltSet").withArgs(false);
    });

    it("halting does not stop retireHeld", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await d.connect(ctx.guardian).halt();
      await ctx.laneToken.connect(ctx.admin).transfer(d, EQ(3));
      await d.connect(ctx.alice).retireHeld();
      expect(await d.totalRetired()).to.equal(EQ(3));
    });
  });

  describe("burn accounting", function () {
    it("burns $LANE already held together with the swap proceeds", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await ctx.laneToken.connect(ctx.admin).transfer(d, EQ(7));
      const supply = await ctx.laneToken.totalSupply();
      await expect(d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(1), EQ(100), "0x"))
        .to.emit(d, "Drawdown")
        .withArgs(ctx.usdg.target, USDG(1), EQ(100))
        .and.to.emit(d, "Retired")
        .withArgs(EQ(107), EQ(107));
      expect(supply - (await ctx.laneToken.totalSupply())).to.equal(EQ(107));
      expect(await ctx.laneToken.balanceOf(d)).to.equal(0);
    });

    it("retireHeld with nothing held is a no-op", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await expect(d.connect(ctx.bob).retireHeld()).not.to.emit(d, "Retired");
      expect(await d.totalRetired()).to.equal(0);
    });

    it("totalRetired accumulates across runs", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.drawdown;
      await ctx.laneToken.connect(ctx.admin).transfer(d, EQ(1));
      await d.retireHeld();
      await ctx.laneToken.connect(ctx.admin).transfer(d, EQ(2));
      await expect(d.retireHeld()).to.emit(d, "Retired").withArgs(EQ(2), EQ(3));
      await d.connect(ctx.keeper).drawdown(ctx.usdg, USDG(1), 1, "0x");
      expect(await d.totalRetired()).to.equal(EQ(103));
    });
  });
});
