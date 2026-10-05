// Pure helpers for launch.mjs: config validation and the Pons V2 ABI.
// Kept free of network access so they can be unit tested offline.

import { getAddress, isAddress, keccak256, parseAbi, parseEther, toHex, zeroAddress } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://robinhood-rpc.publicnode.com";

/** PonsV2LaunchFactory, verified on Robinhood Chain (github.com/ponsdotdev/pons-labs). */
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

// Limits enforced by PonsV2LaunchDeployer and PonsV2LaunchFactory.
export const LIMITS = Object.freeze({
  name: 64,
  symbol: 16,
  logo: 512,
  description: 2048,
  social: 256,
  snipeTaxExemptions: 32,
});

const TOKEN_PARAMS =
  "(string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt)";

export const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address launcher) view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled))",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  `function launchToken(${TOKEN_PARAMS} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
  `function launchToken(${TOKEN_PARAMS} params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)`,
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const SOCIAL_KEYS = ["twitter", "telegram", "discord", "website", "farcaster"];

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * Validates lane.config.json and normalises it. Throws with every problem
 * listed at once so a bad config is fixed in one pass.
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  const str = (key, max, { required = false } = {}) => {
    const value = raw[key] ?? "";
    if (typeof value !== "string") errors.push(`${key} must be a string`);
    else if (required && value.trim() === "") errors.push(`${key} is required`);
    else if (byteLength(value) > max) errors.push(`${key} is longer than ${max} bytes`);
    return typeof value === "string" ? value : "";
  };

  const name = str("name", LIMITS.name, { required: true });
  const symbol = str("symbol", LIMITS.symbol, { required: true });
  const logo = str("logo", LIMITS.logo);
  const description = str("description", LIMITS.description);
  if (logo === "") warnings.push("logo is empty: the token will launch without an image (it cannot be changed later)");

  const socialsIn = raw.socials ?? {};
  const socials = {};
  for (const key of SOCIAL_KEYS) {
    const value = socialsIn[key] ?? "";
    if (typeof value !== "string") errors.push(`socials.${key} must be a string`);
    else if (byteLength(value) > LIMITS.social) errors.push(`socials.${key} is longer than ${LIMITS.social} bytes`);
    socials[key] = typeof value === "string" ? value : "";
  }
  for (const key of Object.keys(socialsIn)) {
    if (!SOCIAL_KEYS.includes(key)) errors.push(`socials.${key} is not a Pons social field`);
  }

  const launchConfigId = raw.launchConfigId ?? 0;
  if (!Number.isInteger(launchConfigId) || launchConfigId < 0) errors.push("launchConfigId must be a non-negative integer");

  const pairTokenIn = raw.pairToken || zeroAddress;
  let pairToken = zeroAddress;
  if (!isAddress(pairTokenIn)) errors.push("pairToken must be an address (0x000…000 for native ETH)");
  else pairToken = getAddress(pairTokenIn);

  let creatorFeeRecipient = zeroAddress;
  if (raw.creatorFeeRecipient) {
    if (!isAddress(raw.creatorFeeRecipient)) errors.push("creatorFeeRecipient must be an address or empty");
    else creatorFeeRecipient = getAddress(raw.creatorFeeRecipient);
  }

  const creatorTaxBps = raw.creatorTaxBps ?? 0;
  if (!Number.isInteger(creatorTaxBps) || creatorTaxBps < 0 || creatorTaxBps > 65535) {
    errors.push("creatorTaxBps must be an integer between 0 and 65535");
  }

  const buybackEnabled = raw.buybackEnabled ?? true;
  if (typeof buybackEnabled !== "boolean") errors.push("buybackEnabled must be true or false");

  let salt = null;
  if (raw.salt) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw.salt)) errors.push("salt must be empty or a 32-byte hex string");
    else salt = raw.salt;
  }

  const exemptionsIn = raw.snipeTaxExemptions ?? [];
  const snipeTaxExemptions = [];
  if (!Array.isArray(exemptionsIn)) errors.push("snipeTaxExemptions must be an array");
  else {
    if (exemptionsIn.length > LIMITS.snipeTaxExemptions) {
      errors.push(`snipeTaxExemptions holds at most ${LIMITS.snipeTaxExemptions} addresses`);
    }
    for (const a of exemptionsIn) {
      if (!isAddress(a)) errors.push(`snipeTaxExemptions: ${a} is not an address`);
      else snipeTaxExemptions.push(getAddress(a));
    }
  }

  let devBuyWei = 0n;
  try {
    devBuyWei = parseEther(String(raw.devBuyEth ?? "0"));
    if (devBuyWei < 0n) errors.push("devBuyEth must not be negative");
  } catch {
    errors.push("devBuyEth must be a decimal ETH amount, e.g. \"0.05\"");
  }
  if (devBuyWei > 0n && pairToken !== zeroAddress) {
    errors.push("devBuyEth is only supported for native-ETH launches (pairToken 0x000…000)");
  }

  const devBuySlippageBps = raw.devBuySlippageBps ?? 300;
  if (!Number.isInteger(devBuySlippageBps) || devBuySlippageBps < 0 || devBuySlippageBps > 5000) {
    errors.push("devBuySlippageBps must be an integer between 0 and 5000");
  }

  if (errors.length) throw new Error(`invalid launch config:\n  - ${errors.join("\n  - ")}`);
  return {
    config: {
      name,
      symbol,
      logo,
      description,
      socials,
      launchConfigId,
      pairToken,
      creatorFeeRecipient,
      creatorTaxBps,
      buybackEnabled,
      salt,
      snipeTaxExemptions,
      devBuyWei,
      devBuySlippageBps,
    },
    warnings,
  };
}

/** A fresh CREATE2 salt, unique per deployer and moment. */
export function freshSalt(deployer, symbol, now = Date.now()) {
  return keccak256(toHex(`stocklane:${symbol}:${deployer.toLowerCase()}:${now}`));
}

/** The TokenParams tuple passed to launchToken. */
export function tokenParams(config, expectedEconomics, salt) {
  return {
    name: config.name,
    symbol: config.symbol,
    logo: config.logo,
    description: config.description,
    socials: config.socials,
    creatorFeeRecipient: config.creatorFeeRecipient,
    creatorTaxBps: config.creatorTaxBps,
    buybackEnabled: config.buybackEnabled,
    expectedEconomics,
    salt,
  };
}

/** Lower bound for a dev buy given the simulated output and slippage tolerance. */
export function minOut(simulatedTokensOut, slippageBps) {
  return (simulatedTokensOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
