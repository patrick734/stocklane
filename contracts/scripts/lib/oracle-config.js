// Builds LaneOracle constructor arguments from config/robinhood.json and live Chainlink answers.
// Equity bounds are [price / factor, price * factor] around the answer at deploy time: wide enough for any
// real market move, narrow enough that a broken or replaced aggregator cannot value a Lane absurdly.
const config = require("../../config/robinhood.json");

const FEED_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
];

async function equityFeedInit(ethers, ticker, { maxAge = config.chainlink.equityMaxAge } = {}) {
  const t = config.equityTokens[ticker];
  if (!t) throw new Error(`unknown ticker ${ticker}`);
  const feed = new ethers.Contract(t.chainlinkFeed, FEED_ABI, ethers.provider);
  const [, answer] = await feed.latestRoundData();
  if (answer <= 0n) throw new Error(`${ticker} feed answer is not positive`);
  const factor = BigInt(config.oracle.equityBoundsFactor);
  return {
    token: t.address,
    aggregator: t.chainlinkFeed,
    maxAge,
    minAnswer: answer / factor > 0n ? answer / factor : 1n,
    maxAnswer: answer * factor,
  };
}

async function usdgInit(ethers, feedAddress = config.chainlink.usdgUsdFeed) {
  const feed = new ethers.Contract(feedAddress, FEED_ABI, ethers.provider);
  const decimals = Number(await feed.decimals());
  return {
    feed: feedAddress,
    maxAge: config.chainlink.usdgMaxAge,
    decimals: config.tokens.usdg.decimals,
    minAnswer: ethers.parseUnits(config.oracle.usdgMinUsd, decimals),
    maxAnswer: ethers.parseUnits(config.oracle.usdgMaxUsd, decimals),
  };
}

module.exports = { equityFeedInit, usdgInit };
