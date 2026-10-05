const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { USDG, EQ, rate, frac, baseFixture, deployStock, deployRouter, poolKey, v4Pool, v3Pool, v3Hop, v4Hop } = require("./fixtures");

const ETH = ethers.ZeroAddress;

describe("LaneRouter", function () {
  // AMD trades at $150 on Chainlink. Pools:
  //   v4 USDG/AMD 0.3% at $150, v3 USDG/AMD 0.05% at $149 (slightly worse), v3 AMD/TSLA at 0.6 TSLA per AMD,
  //   v4 USDG/ETH and ETH/AMD (for a route that passes through native ETH).
  async function routerFixture() {
    const ctx = await baseFixture();
    const { usdg, amd, poolManager, v3Factory } = ctx;
    const tsla = await deployStock(ctx, "TSLA", 250);
    await tsla.equity.mint(poolManager, EQ(1_000_000));

    const v4Key = await v4Pool(poolManager, usdg, amd.equity, frac(1, 150, 6, 18), rate(150, 18, 6));
    const v3UsdgAmd = await v3Pool(v3Factory, usdg, amd.equity, 500, frac(1, 149, 6, 18), rate(149, 18, 6));
    await usdg.mint(v3UsdgAmd, USDG(10_000_000));
    await amd.equity.mint(v3UsdgAmd, EQ(100_000));
    const v3AmdTsla = await v3Pool(v3Factory, amd.equity, tsla.equity, 3000, frac(6, 10, 18, 18), frac(10, 6, 18, 18));
    await amd.equity.mint(v3AmdTsla, EQ(100_000));
    await tsla.equity.mint(v3AmdTsla, EQ(100_000));
    await v4Pool(poolManager, usdg, ETH, frac(1, 3000, 6, 18), rate(3000, 18, 6), 500, 10);
    await v4Pool(poolManager, ETH, amd.equity, rate(20, 18, 18), frac(1, 20, 18, 18), 500, 10);

    for (const s of [ctx.alice, ctx.bob]) {
      await usdg.connect(s).approve(ctx.router, ethers.MaxUint256);
      await amd.equity.connect(s).approve(ctx.router, ethers.MaxUint256);
    }
    await amd.equity.mint(ctx.alice, EQ(1_000));
    return { ...ctx, tsla, v4Key, v3UsdgAmd, v3AmdTsla };
  }

  const deadline = async () => (await time.latest()) + 600;
  const afterFee = (amount) => amount - (amount * 5n) / 10_000n;

  async function swap(ctx, signer, tokenIn, tokenOut, amountIn, legs, minOut = 0n, recipient = signer.address) {
    return ctx.router.connect(signer).swap(tokenIn, tokenOut, amountIn, minOut, recipient, await deadline(), legs);
  }

  describe("deployment", function () {
    it("stores its configuration and grants roles only to the timelock and guardian", async function () {
      const ctx = await loadFixture(routerFixture);
      const r = ctx.router;
      expect(await r.poolManager()).to.equal(ctx.poolManager.target);
      expect(await r.v3Factory()).to.equal(ctx.v3Factory.target);
      expect(await r.oracle()).to.equal(ctx.oracle.target);
      expect(await r.quoteToken()).to.equal(ctx.usdg.target);
      expect(await r.feeRecipient()).to.equal(ctx.feeRouter.target);
      expect(await r.feeBps()).to.equal(5);
      expect(await r.maxOracleDeviationBps()).to.equal(300);
      expect(await r.hasRole(await r.DEFAULT_ADMIN_ROLE(), ctx.timelock.target)).to.equal(true);
      expect(await r.hasRole(await r.GUARDIAN_ROLE(), ctx.guardian.address)).to.equal(true);
    });

    it("rejects zero addresses and allowlists hooks given at deployment", async function () {
      const ctx = await loadFixture(routerFixture);
      const F = await ethers.getContractFactory("LaneRouter");
      for (const k of ["poolManager", "v3Factory", "oracle", "quoteToken", "feeRecipient", "guardian"]) {
        await expect(deployRouter(ctx, { [k]: ETH })).to.be.revertedWithCustomError(F, "InvalidConfig");
      }
      await expect(deployRouter(ctx, { hooks: [ETH] })).to.be.revertedWithCustomError(F, "InvalidConfig");
      const r = await deployRouter(ctx, { hooks: [ctx.carol.address] });
      expect(await r.hookAllowed(ctx.carol.address)).to.equal(true);
    });
  });

  describe("single-pool swaps", function () {
    it("swaps USDG for a stock through a v4 pool and charges the fee in USDG", async function () {
      const ctx = await loadFixture(routerFixture);
      const amountIn = USDG(1_500);
      const legs = [{ amountIn: afterFee(amountIn), hops: [v4Hop(ctx.amd.equity)] }];
      const expected = (afterFee(amountIn) * 10n ** 12n) / 150n;
      const before = await ctx.amd.equity.balanceOf(ctx.alice);
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, amountIn, legs))
        .to.emit(ctx.router, "Swapped")
        .withArgs(ctx.alice.address, ctx.alice.address, ctx.usdg.target, ctx.amd.equity.target, amountIn, anyValue, amountIn - afterFee(amountIn));
      expect((await ctx.amd.equity.balanceOf(ctx.alice)) - before).to.be.closeTo(expected, 100n);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG("0.75"));
      expect(await ctx.usdg.balanceOf(ctx.router)).to.equal(0n);
      expect(await ctx.amd.equity.balanceOf(ctx.router)).to.equal(0n);
    });

    it("swaps a stock for USDG through a v3 pool and pays the recipient", async function () {
      const ctx = await loadFixture(routerFixture);
      const amountIn = EQ(10);
      const legs = [{ amountIn: afterFee(amountIn), hops: [v3Hop(ctx.usdg, 500)] }];
      const expected = (afterFee(amountIn) * 149n) / 10n ** 12n;
      await swap(ctx, ctx.alice, ctx.amd.equity, ctx.usdg, amountIn, legs, expected, ctx.bob.address);
      expect(await ctx.usdg.balanceOf(ctx.bob)).to.equal(USDG(1_000_000) + expected);
      expect(await ctx.amd.equity.balanceOf(ctx.feeRouter)).to.equal(amountIn - afterFee(amountIn));
      expect(await ctx.amd.equity.balanceOf(ctx.router)).to.equal(0n);
    });

    it("works with a zero fee", async function () {
      const ctx = await loadFixture(routerFixture);
      await ctx.router.connect(ctx.admin).setFeeBps(0);
      const legs = [{ amountIn: USDG(150), hops: [v4Hop(ctx.amd.equity)] }];
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(0n);
    });
  });

  describe("multi-hop and split routes", function () {
    it("chains a v4 hop into a v3 hop (USDG -> AMD -> TSLA)", async function () {
      const ctx = await loadFixture(routerFixture);
      const amountIn = USDG(15_000);
      const legs = [{ amountIn: afterFee(amountIn), hops: [v4Hop(ctx.amd.equity), v3Hop(ctx.tsla.equity, 3000)] }];
      const amd = (afterFee(amountIn) * 10n ** 12n) / 150n;
      const expected = (amd * 6n) / 10n;
      await swap(ctx, ctx.alice, ctx.usdg, ctx.tsla.equity, amountIn, legs);
      expect(await ctx.tsla.equity.balanceOf(ctx.alice)).to.be.closeTo(expected, 100n);
    });

    it("passes through native ETH between two v4 hops in one unlock", async function () {
      const ctx = await loadFixture(routerFixture);
      const amountIn = USDG(3_000);
      const legs = [{ amountIn: afterFee(amountIn), hops: [v4Hop(ETH, 500, 10), v4Hop(ctx.amd.equity, 500, 10)] }];
      const eth = (afterFee(amountIn) * 10n ** 12n) / 3000n;
      const before = await ctx.amd.equity.balanceOf(ctx.alice);
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, amountIn, legs);
      expect((await ctx.amd.equity.balanceOf(ctx.alice)) - before).to.be.closeTo(eth * 20n, 100n);
    });

    it("splits one swap across v3 and v4 and sums the output", async function () {
      const ctx = await loadFixture(routerFixture);
      const amountIn = USDG(10_000);
      const net = afterFee(amountIn);
      const a = (net * 7n) / 10n;
      const legs = [
        { amountIn: a, hops: [v4Hop(ctx.amd.equity)] },
        { amountIn: net - a, hops: [v3Hop(ctx.amd.equity, 500)] },
      ];
      const expected = (a * 10n ** 12n) / 150n + ((net - a) * 10n ** 12n) / 149n;
      const [quoted, fee] = await ctx.router.quote.staticCall(ctx.usdg, ctx.amd.equity, amountIn, legs);
      expect(fee).to.equal(amountIn - net);
      const before = await ctx.amd.equity.balanceOf(ctx.alice);
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, amountIn, legs);
      const got = (await ctx.amd.equity.balanceOf(ctx.alice)) - before;
      expect(got).to.be.closeTo(expected, 2n);
      expect(quoted).to.equal(got);
    });
  });

  describe("quote", function () {
    it("matches the executed amount for v3, v4 and mixed paths without moving tokens", async function () {
      const ctx = await loadFixture(routerFixture);
      const routes = [
        [ctx.usdg, ctx.amd.equity, [v4Hop(ctx.amd.equity)]],
        [ctx.usdg, ctx.amd.equity, [v3Hop(ctx.amd.equity, 500)]],
        [ctx.usdg, ctx.tsla.equity, [v4Hop(ctx.amd.equity), v3Hop(ctx.tsla.equity, 3000)]],
        [ctx.usdg, ctx.amd.equity, [v4Hop(ETH, 500, 10), v4Hop(ctx.amd.equity, 500, 10)]],
      ];
      for (const [tin, tout, hops] of routes) {
        const amountIn = USDG(3_000);
        const legs = [{ amountIn: afterFee(amountIn), hops }];
        const balBefore = await ctx.usdg.balanceOf(ctx.alice);
        const [quoted] = await ctx.router.connect(ctx.alice).quote.staticCall(tin, tout, amountIn, legs);
        const outBefore = await tout.balanceOf(ctx.alice);
        await swap(ctx, ctx.alice, tin, tout, amountIn, legs);
        expect((await tout.balanceOf(ctx.alice)) - outBefore).to.equal(quoted);
        expect(balBefore - (await ctx.usdg.balanceOf(ctx.alice))).to.equal(amountIn);
      }
    });

    it("bubbles up pool errors and rejects outside calls to quoteSegment", async function () {
      const ctx = await loadFixture(routerFixture);
      const missing = [{ amountIn: afterFee(USDG(10)), hops: [v4Hop(ctx.amd.equity, 100, 1)] }];
      await expect(ctx.router.quote.staticCall(ctx.usdg, ctx.amd.equity, USDG(10), missing)).to.be.revertedWith("PoolNotInitialized");
      await expect(ctx.router.quoteSegment(ctx.usdg, [v4Hop(ctx.amd.equity)], USDG(1))).to.be.revertedWithCustomError(
        ctx.router,
        "Unauthorized"
      );
    });
  });

  describe("route validation", function () {
    async function expectInvalid(ctx, tokenIn, tokenOut, amountIn, legs) {
      await expect(swap(ctx, ctx.alice, tokenIn, tokenOut, amountIn, legs)).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");
    }

    it("rejects bad tokens, amounts and leg counts", async function () {
      const ctx = await loadFixture(routerFixture);
      const { usdg } = ctx;
      const amd = ctx.amd.equity;
      const ok = (n) => ({ amountIn: n, hops: [v4Hop(amd)] });
      const net = afterFee(USDG(100));
      await expectInvalid(ctx, usdg, amd, USDG(100), []);
      await expectInvalid(ctx, usdg, usdg, USDG(100), [ok(net)]);
      await expectInvalid(ctx, usdg, amd, 0n, [ok(0n)]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [ok(net - 1n)]); // legs must add up exactly
      await expectInvalid(ctx, usdg, amd, USDG(100), [ok(net + 1n)]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [ok(net), { amountIn: 0n, hops: [v4Hop(amd)] }]);
      const five = Array.from({ length: 5 }, () => ok(net / 5n));
      await expectInvalid(ctx, usdg, amd, USDG(100), five);
      await expect(
        ctx.router.connect(ctx.alice).swap(usdg, amd, USDG(100), 0, ETH, await deadline(), [ok(net)])
      ).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");
    });

    it("rejects paths that are empty, too long, end elsewhere, loop in place or use an unknown kind", async function () {
      const ctx = await loadFixture(routerFixture);
      const { usdg } = ctx;
      const amd = ctx.amd.equity;
      const net = afterFee(USDG(100));
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [] }]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [v4Hop(ctx.tsla.equity)] }]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [v4Hop(usdg), v4Hop(amd)] }]);
      const four = [v4Hop(amd), v4Hop(usdg), v4Hop(amd), v4Hop(amd)];
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: four }]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [{ ...v4Hop(amd), kind: 2 }] }]);
    });

    it("allows native ETH only between two v4 hops", async function () {
      const ctx = await loadFixture(routerFixture);
      const { usdg } = ctx;
      const amd = ctx.amd.equity;
      const net = afterFee(USDG(100));
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [v3Hop(ETH, 500), v4Hop(amd, 500, 10)] }]);
      await expectInvalid(ctx, usdg, amd, USDG(100), [{ amountIn: net, hops: [v4Hop(ETH, 500, 10), v3Hop(amd, 500)] }]);
      await expectInvalid(ctx, usdg, ETH, USDG(100), [{ amountIn: net, hops: [v4Hop(ETH, 500, 10)] }]);
      await expectInvalid(ctx, ETH, amd, USDG(100), [{ amountIn: net, hops: [v4Hop(amd, 500, 10)] }]);
    });

    it("rejects expired swaps", async function () {
      const ctx = await loadFixture(routerFixture);
      const legs = [{ amountIn: afterFee(USDG(100)), hops: [v4Hop(ctx.amd.equity)] }];
      const past = (await time.latest()) - 1;
      await expect(
        ctx.router.connect(ctx.alice).swap(ctx.usdg, ctx.amd.equity, USDG(100), 0, ctx.alice.address, past, legs)
      ).to.be.revertedWithCustomError(ctx.router, "Expired");
    });

    it("rejects v3 hops through pools the factory does not know", async function () {
      const ctx = await loadFixture(routerFixture);
      const legs = [{ amountIn: afterFee(USDG(100)), hops: [v3Hop(ctx.amd.equity, 10_000)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(100), legs)).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");
    });
  });

  describe("v4 hooks", function () {
    it("only routes through hooks the timelock allowlisted", async function () {
      const ctx = await loadFixture(routerFixture);
      const hook = ctx.carol.address;
      await v4Pool(ctx.poolManager, ctx.usdg, ctx.amd.equity, frac(1, 150, 6, 18), rate(150, 18, 6), 0, 200, hook);
      const legs = [{ amountIn: afterFee(USDG(150)), hops: [v4Hop(ctx.amd.equity, 0, 200, hook)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs)).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");

      await expect(ctx.router.connect(ctx.admin).setHookAllowed(hook, true)).to.emit(ctx.router, "HookAllowed").withArgs(hook, true);
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs);

      await ctx.router.connect(ctx.admin).setHookAllowed(hook, false);
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs)).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");
    });
  });

  describe("protection", function () {
    it("enforces minOut", async function () {
      const ctx = await loadFixture(routerFixture);
      const legs = [{ amountIn: afterFee(USDG(1_500)), hops: [v4Hop(ctx.amd.equity)] }];
      const [quoted] = await ctx.router.quote.staticCall(ctx.usdg, ctx.amd.equity, USDG(1_500), legs);
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_500), legs, quoted + 1n))
        .to.be.revertedWithCustomError(ctx.router, "InsufficientOutput")
        .withArgs(quoted, quoted + 1n);
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_500), legs, quoted);
    });

    it("reverts when a v3 or v4 pool fills only part of a hop", async function () {
      const ctx = await loadFixture(routerFixture);
      await ctx.v3UsdgAmd.setFillBps(9_000);
      const v3legs = [{ amountIn: afterFee(USDG(100)), hops: [v3Hop(ctx.amd.equity, 500)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(100), v3legs)).to.be.revertedWithCustomError(ctx.router, "PartialFill");

      await ctx.poolManager.setFillBps(ctx.v4Key, 9_000);
      const v4legs = [{ amountIn: afterFee(USDG(100)), hops: [v4Hop(ctx.amd.equity)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(100), v4legs)).to.be.revertedWithCustomError(ctx.router, "PartialFill");
    });

    it("blocks a fill far below the Chainlink price", async function () {
      const ctx = await loadFixture(routerFixture);
      // The v4 pool now pays as if AMD were $200 (25% too few shares).
      await ctx.poolManager.setPool(ctx.v4Key, ...(await ratesFor(ctx, ctx.usdg, frac(1, 200, 6, 18), rate(200, 18, 6))));
      const legs = [{ amountIn: afterFee(USDG(1_500)), hops: [v4Hop(ctx.amd.equity)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_500), legs)).to.be.revertedWithCustomError(
        ctx.router,
        "OracleDeviation"
      );
      // A 3% band: $149 on v3 is within it.
      const v3legs = [{ amountIn: afterFee(USDG(1_500)), hops: [v3Hop(ctx.amd.equity, 500)] }];
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_500), v3legs);
      // Even the widest band the admin can set (10%) still blocks a 25% bad fill.
      await ctx.router.connect(ctx.admin).setMaxOracleDeviationBps(1_000);
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_500), legs)).to.be.revertedWithCustomError(
        ctx.router,
        "OracleDeviation"
      );
    });

    it("skips the price guard when a token has no fresh price, leaving minOut in charge", async function () {
      const ctx = await loadFixture(routerFixture);
      await ctx.amd.equity.setOraclePaused(true); // corporate action
      const r = await ctx.router.oracleCheck(ctx.usdg, USDG(150), ctx.amd.equity, 1n);
      expect(r.priced).to.equal(false);
      expect(r.ok).to.equal(true);
      const legs = [{ amountIn: afterFee(USDG(150)), hops: [v4Hop(ctx.amd.equity)] }];
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs);
    });

    it("values stock-to-stock swaps through both feeds", async function () {
      const ctx = await loadFixture(routerFixture);
      const r = await ctx.router.oracleCheck(ctx.amd.equity, EQ(10), ctx.tsla.equity, EQ(6));
      expect(r.priced).to.equal(true);
      expect(r.valueIn).to.equal(USDG(1_500));
      expect(r.valueOut).to.equal(USDG(1_500));
      expect(r.ok).to.equal(true);
      expect((await ctx.router.oracleCheck(ctx.amd.equity, EQ(10), ctx.tsla.equity, EQ("5.7"))).ok).to.equal(false);
    });

    it("rejects tokens that deliver less than the amount sent", async function () {
      const ctx = await loadFixture(routerFixture);
      const tax = await ethers.deployContract("MockFeeOnTransfer");
      await tax.mint(ctx.alice, EQ(10));
      await tax.connect(ctx.alice).approve(ctx.router, EQ(10));
      const legs = [{ amountIn: afterFee(EQ(1)), hops: [v4Hop(ctx.amd.equity)] }];
      await expect(swap(ctx, ctx.alice, tax, ctx.amd.equity, EQ(1), legs)).to.be.revertedWithCustomError(ctx.router, "InvalidRoute");
    });

    it("pauses swaps but keeps quotes working", async function () {
      const ctx = await loadFixture(routerFixture);
      await ctx.router.connect(ctx.guardian).pause();
      const legs = [{ amountIn: afterFee(USDG(150)), hops: [v4Hop(ctx.amd.equity)] }];
      await expect(swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs)).to.be.revertedWithCustomError(ctx.router, "EnforcedPause");
      await ctx.router.quote.staticCall(ctx.usdg, ctx.amd.equity, USDG(150), legs);
      await ctx.router.connect(ctx.admin).unpause();
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(150), legs);
    });
  });

  describe("callbacks", function () {
    it("rejects v3 callbacks that do not come from the pool being swapped", async function () {
      const ctx = await loadFixture(routerFixture);
      // A real factory pool calling in on its own, outside a swap, cannot pull the router's tokens.
      await ctx.usdg.mint(ctx.router, USDG(10));
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [ctx.usdg.target, ctx.amd.equity.target, 500]);
      const [a0, a1] = BigInt(ctx.usdg.target) < BigInt(ctx.amd.equity.target) ? [USDG(10), 0n] : [0n, USDG(10)];
      await expect(ctx.v3UsdgAmd.poke(ctx.router, a0, a1, data)).to.be.revertedWithCustomError(ctx.router, "Unauthorized");
      await expect(ctx.router.connect(ctx.alice).uniswapV3SwapCallback(a0, a1, data)).to.be.revertedWithCustomError(ctx.router, "Unauthorized");
    });

    it("rejects v4 unlock callbacks from anyone but the PoolManager mid-unlock", async function () {
      const ctx = await loadFixture(routerFixture);
      await expect(ctx.router.connect(ctx.alice).unlockCallback("0x")).to.be.revertedWithCustomError(ctx.router, "Unauthorized");
      const pm = await ethers.getImpersonatedSigner(ctx.poolManager.target);
      await ethers.provider.send("hardhat_setBalance", [ctx.poolManager.target, "0xDE0B6B3A7640000"]);
      await expect(ctx.router.connect(pm).unlockCallback("0x")).to.be.revertedWithCustomError(ctx.router, "Unauthorized");
    });
  });

  describe("governance", function () {
    it("sweeps stray tokens to the timelock's chosen address only", async function () {
      const ctx = await loadFixture(routerFixture);
      await ctx.usdg.mint(ctx.router, USDG(7));
      await expect(ctx.router.connect(ctx.admin).sweep(ctx.usdg, ETH)).to.be.revertedWithCustomError(ctx.router, "InvalidConfig");
      await expect(ctx.router.connect(ctx.admin).sweep(ctx.usdg, ctx.carol.address))
        .to.emit(ctx.router, "Swept")
        .withArgs(ctx.usdg.target, ctx.carol.address, USDG(7));
    });

    it("applies a new fee to the next swap", async function () {
      const ctx = await loadFixture(routerFixture);
      await expect(ctx.router.connect(ctx.admin).setFeeBps(30)).to.emit(ctx.router, "FeeSet").withArgs(30);
      const net = USDG(1_000) - USDG(3);
      await swap(ctx, ctx.alice, ctx.usdg, ctx.amd.equity, USDG(1_000), [{ amountIn: net, hops: [v4Hop(ctx.amd.equity)] }]);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(3));
    });
  });

  /** Rates for setPool on the USDG/AMD key, ordered by currency. */
  async function ratesFor(ctx, usdg, usdgToAmd, amdToUsdg) {
    const key = poolKey(usdg, ctx.amd.equity);
    return key.currency0 === usdg.target ? [usdgToAmd, amdToUsdg] : [amdToUsdg, usdgToAmd];
  }
});
