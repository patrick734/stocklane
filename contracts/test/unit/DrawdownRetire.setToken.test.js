// $LANE launched after the protocol: DrawdownRetire starts without a token and the timelock sets it once.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, baseFixture, viaTimelock } = require("./fixtures");

describe("DrawdownRetire without $LANE at deployment", function () {
  async function unset() {
    const ctx = await baseFixture();
    const drawdown = await ethers.deployContract("DrawdownRetire", [
      ethers.ZeroAddress,
      ctx.swap,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      0,
      [ctx.usdg.target],
      [USDG(1_000)],
    ]);
    await ctx.usdg.mint(drawdown, USDG(500));
    return { ...ctx, drawdown };
  }

  it("deploys with no token, holds fees, and refuses to draw down", async function () {
    const { drawdown, usdg, keeper } = await loadFixture(unset);
    expect(await drawdown.laneToken()).to.equal(ethers.ZeroAddress);
    await expect(drawdown.connect(keeper).drawdown(usdg, USDG(100), 1, "0x")).to.be.revertedWithCustomError(drawdown, "LaneTokenUnset");
    await drawdown.retireHeld(); // no-op, does not revert
    expect(await usdg.balanceOf(drawdown)).to.equal(USDG(500));
  });

  it("lets only the admin set the token, and only once", async function () {
    const { drawdown, laneToken, deployer, multisig, guardian, keeper, admin, alice } = await loadFixture(unset);
    for (const s of [deployer, multisig, guardian, keeper, alice]) {
      await expect(drawdown.connect(s).setLaneToken(laneToken)).to.be.revertedWithCustomError(drawdown, "AccessControlUnauthorizedAccount");
    }
    await expect(drawdown.connect(admin).setLaneToken(laneToken)).to.emit(drawdown, "LaneTokenSet").withArgs(laneToken.target);
    const other = await ethers.deployContract("LaneToken", [admin.address, EQ(1)]);
    await expect(drawdown.connect(admin).setLaneToken(other)).to.be.revertedWithCustomError(drawdown, "LaneTokenAlreadySet");
  });

  it("rejects a token without code and a token that is a configured fee input", async function () {
    const { drawdown, usdg, admin, alice } = await loadFixture(unset);
    await expect(drawdown.connect(admin).setLaneToken(alice.address)).to.be.revertedWithCustomError(drawdown, "InvalidConfig");
    await expect(drawdown.connect(admin).setLaneToken(usdg)).to.be.revertedWithCustomError(drawdown, "InvalidConfig");
    await expect(drawdown.connect(admin).setLaneToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(drawdown, "InvalidConfig");
  });

  it("buys and burns once the token is set through the 48h timelock", async function () {
    const ctx = await loadFixture(unset);
    const { drawdown, laneToken, usdg, keeper } = ctx;
    await viaTimelock(ctx, drawdown, "setLaneToken", [laneToken.target]);
    expect(await drawdown.laneToken()).to.equal(laneToken.target);
    const supply = await laneToken.totalSupply();
    await expect(drawdown.connect(keeper).drawdown(usdg, USDG(100), 1, "0x")).to.emit(drawdown, "Retired");
    expect(await laneToken.totalSupply()).to.be.lt(supply);
  });
});
