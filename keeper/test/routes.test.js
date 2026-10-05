const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const { feeFor, burnPaths, encodeLegs, minOut, LEGS } = require("../src/routes");
const chain = require("../../contracts/config/robinhood.json");

const usdg = chain.tokens.usdg.address;
const lane = "0x00000000000000000000000000000000000000aa";
const env = { usdg, lane, uniswap: chain.uniswap, pons: chain.pons };

test("USDG burns through ETH into the Pons pool", () => {
  const [p] = burnPaths(usdg, env);
  assert.equal(p.hops.length, 2);
  assert.equal(p.hops[0].tokenOut, ethers.ZeroAddress);
  assert.deepEqual([p.hops[1].tokenOut, p.hops[1].hooks, p.hops[1].fee, p.hops[1].tickSpacing], [lane, chain.pons.hook, 0, 200]);
});

test("stock fees go to USDG first over every v3 and hookless v4 tier, within the 3-hop limit", () => {
  const paths = burnPaths(chain.equityTokens.TSLA.address, env);
  assert.equal(paths.length, chain.uniswap.v3Fees.length + chain.uniswap.v4HooklessPools.length);
  for (const p of paths) {
    assert.equal(p.hops.length, 3);
    assert.equal(p.hops[0].tokenOut, usdg);
    assert.equal(p.hops[0].kind === 1 ? p.hops[0].hooks : ethers.ZeroAddress, ethers.ZeroAddress);
  }
});

test("fee, minimum and encoding match the router", () => {
  assert.equal(feeFor(1_000_000n, 5), 500n);
  assert.equal(minOut(10_000n, 300), 9_700n);
  const legs = [{ amountIn: 5n, hops: burnPaths(usdg, env)[0].hops }];
  const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode([LEGS], encodeLegs(legs));
  assert.equal(decoded[0].amountIn, 5n);
  assert.equal(decoded[0].hops[1].tokenOut.toLowerCase(), lane);
});
