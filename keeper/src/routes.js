// Pure helpers for the burn route: which paths can turn a fee token into $LANE.
const { ethers } = require("ethers");

const ZERO = ethers.ZeroAddress;
const LEGS = "tuple(uint256 amountIn, tuple(uint8 kind, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)[] hops)[]";

const v3 = (tokenOut, fee) => ({ kind: 0, tokenOut, fee, tickSpacing: 0, hooks: ZERO });
const v4 = (tokenOut, fee, tickSpacing, hooks = ZERO) => ({ kind: 1, tokenOut, fee, tickSpacing, hooks });

function feeFor(amount, feeBps) {
  return (amount * BigInt(feeBps)) / 10_000n;
}

/**
 * Candidate paths from a fee token to $LANE. $LANE trades against native ETH in its Pons pool, so every path
 * ends USDG -> ETH -> $LANE. A stock fee token first goes to USDG through any Uniswap v3 or hookless v4 pool.
 */
function burnPaths(token, { usdg, lane, uniswap, pons }) {
  const tail = [v4(ZERO, uniswap.ethUsdgPool.fee, uniswap.ethUsdgPool.tickSpacing), v4(lane, pons.poolFee, pons.poolTickSpacing, pons.hook)];
  if (token.toLowerCase() === usdg.toLowerCase()) return [{ label: "USDG → ETH → $LANE", hops: tail }];
  return [
    ...uniswap.v3Fees.map((f) => ({ label: `v3 ${f / 10000}% → USDG → ETH → $LANE`, hops: [v3(usdg, f), ...tail] })),
    ...uniswap.v4HooklessPools.map((p) => ({ label: `v4 ${p.fee / 10000}% → USDG → ETH → $LANE`, hops: [v4(usdg, p.fee, p.tickSpacing), ...tail] })),
  ];
}

function encodeLegs(legs) {
  return ethers.AbiCoder.defaultAbiCoder().encode([LEGS], [legs]);
}

function minOut(quoted, slippageBps) {
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

module.exports = { feeFor, burnPaths, encodeLegs, minOut, LEGS };
