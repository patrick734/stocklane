#!/usr/bin/env node
// Launches $LANE on the Pons V2 launchpad from the StockLane dev wallet.
//
//   node launch.mjs               preflight only: reads the chain, simulates, sends nothing
//   node launch.mjs --broadcast   preflight, then asks you to type the symbol before sending
//
// Reads DEPLOYER_PRIVATE_KEY and RPC_URL from the environment (or launch/.env)
// and the token metadata from lane.config.json (or --config <path>).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_RPC_URL,
  PONS_V2_FACTORY,
  ROBINHOOD_CHAIN_ID,
  curveAbi,
  erc20Abi,
  factoryAbi,
  freshSalt,
  minOut,
  tokenParams,
  validateConfig,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const broadcast = args.includes("--broadcast");
const configPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : join(here, "lane.config.json");

if (existsSync(join(here, ".env"))) process.loadEnvFile(join(here, ".env"));

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!key) fail("DEPLOYER_PRIVATE_KEY is not set (environment or launch/.env)");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
const account = privateKeyToAccount(key);

const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
const chain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const explorer = chain.blockExplorers.default.url;

let config, warnings;
try {
  ({ config, warnings } = validateConfig(JSON.parse(readFileSync(configPath, "utf8"))));
} catch (err) {
  fail(err.message);
}

console.log(`StockLane → Pons V2 launch${broadcast ? "" : " (preflight, nothing will be sent)"}\n`);

const chainId = await publicClient.getChainId().catch((err) => fail(`cannot reach ${rpcUrl}: ${err.shortMessage ?? err.message}`));
if (chainId !== ROBINHOOD_CHAIN_ID) fail(`RPC is on chain ${chainId}, expected Robinhood Chain ${ROBINHOOD_CHAIN_ID}`);

const code = await publicClient.getCode({ address: PONS_V2_FACTORY });
if (!code || code === "0x") fail(`no contract at the Pons V2 factory ${PONS_V2_FACTORY}`);

const factory = { address: PONS_V2_FACTORY, abi: factoryAbi };
const [launchFee, canLaunch, maxCreatorTaxBps, configCount, balance] = await Promise.all([
  publicClient.readContract({ ...factory, functionName: "launchFee" }),
  publicClient.readContract({ ...factory, functionName: "canLaunch", args: [account.address] }),
  publicClient.readContract({ ...factory, functionName: "maxCreatorTaxBps" }),
  publicClient.readContract({ ...factory, functionName: "launchConfigCount" }),
  publicClient.getBalance({ address: account.address }),
]);

if (!canLaunch) fail("Pons launches are closed to this wallet right now (launchEnabled is off and it is not whitelisted)");
if (BigInt(config.launchConfigId) >= configCount) fail(`launchConfigId ${config.launchConfigId} does not exist (factory has ${configCount})`);
if (BigInt(config.creatorTaxBps) > maxCreatorTaxBps) fail(`creatorTaxBps ${config.creatorTaxBps} exceeds the factory cap ${maxCreatorTaxBps}`);

const launchConfig = await publicClient.readContract({ ...factory, functionName: "getLaunchConfig", args: [BigInt(config.launchConfigId)] });
if (!launchConfig.enabled) fail(`launch config ${config.launchConfigId} is disabled`);
if (config.pairToken !== zeroAddress) {
  const approved = await publicClient.readContract({ ...factory, functionName: "approvedPairTokens", args: [config.pairToken] });
  if (!approved) fail(`pairToken ${config.pairToken} is not approved by Pons`);
}

// Pin the economics we were quoted so an owner change between now and
// inclusion reverts the launch instead of silently repricing it.
const expectedEconomics = await publicClient.readContract({
  ...factory,
  functionName: "previewLaunchEconomics",
  args: [BigInt(config.launchConfigId), config.pairToken],
});
const salt = config.salt ?? freshSalt(account.address, config.symbol);
const params = tokenParams(config, expectedEconomics, salt);
const launchArgs = config.snipeTaxExemptions.length
  ? [params, BigInt(config.launchConfigId), config.pairToken, config.snipeTaxExemptions]
  : [params, BigInt(config.launchConfigId), config.pairToken];

const { request, result } = await publicClient
  .simulateContract({ ...factory, functionName: "launchToken", args: launchArgs, value: launchFee, account })
  .catch((err) => fail(`launch simulation reverted: ${err.shortMessage ?? err.message}`));
const [predictedToken, predictedCurve] = result;

const gas = await publicClient.estimateContractGas({ ...factory, functionName: "launchToken", args: launchArgs, value: launchFee, account });
const gasPrice = await publicClient.getGasPrice();
const gasCost = gas * gasPrice;
// The dev buy is a second transaction; budget roughly the same gas again.
const needed = launchFee + config.devBuyWei + gasCost * (config.devBuyWei > 0n ? 2n : 1n);

const row = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
row("Dev wallet", account.address);
row("Balance", `${formatEther(balance)} ETH`);
row("Factory", `${PONS_V2_FACTORY} (Pons V2)`);
row("Token", `${config.name} ($${config.symbol})`);
row("Supply", formatUnits(launchConfig.supply, 18));
row("Quote asset", config.pairToken === zeroAddress ? "native ETH" : config.pairToken);
row("Launch config", `#${config.launchConfigId} (curve fee ${launchConfig.curveFeeBps} bps)`);
row("Creator tax", `${config.creatorTaxBps} bps`);
row("Creator fees to", config.creatorFeeRecipient === zeroAddress ? `${account.address} (dev wallet)` : config.creatorFeeRecipient);
row("Buyback", config.buybackEnabled ? "enabled" : "disabled");
row("Launch fee", `${formatEther(launchFee)} ETH`);
row("Dev buy", config.devBuyWei > 0n ? `${formatEther(config.devBuyWei)} ETH (max slippage ${config.devBuySlippageBps} bps)` : "none");
row("Est. gas", `${formatEther(gasCost)} ETH${config.devBuyWei > 0n ? " per tx" : ""}`);
row("Economics pin", expectedEconomics);
row("Salt", salt);
row("Predicted token", predictedToken);
row("Predicted curve", predictedCurve);
for (const w of warnings) console.log(`  ! ${w}`);

if (balance < needed) fail(`dev wallet needs about ${formatEther(needed)} ETH, has ${formatEther(balance)} ETH`);
if (expectedEconomics === zeroHash) fail("factory returned an empty economics digest; refusing to launch unpinned");

if (!broadcast) {
  console.log("\n✓ Preflight passed. Re-run with --broadcast to launch.");
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nThis launches $${config.symbol} on Robinhood Chain mainnet and cannot be undone.\nType ${config.symbol} to continue: `);
rl.close();
if (answer.trim() !== config.symbol) fail("not confirmed, nothing was sent");

const outDir = join(here, "deployments");
mkdirSync(outDir, { recursive: true });
const recordPath = join(outDir, `${config.symbol.toLowerCase()}-${ROBINHOOD_CHAIN_ID}.json`);
const record = { chainId: ROBINHOOD_CHAIN_ID, factory: PONS_V2_FACTORY, deployer: account.address, salt, expectedEconomics };
const save = () => writeFileSync(recordPath, JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

const launchHash = await walletClient.writeContract(request);
record.launchTx = launchHash;
save();
console.log(`\n→ launch sent: ${explorer}/tx/${launchHash}`);
const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
if (launchReceipt.status !== "success") fail(`launch transaction reverted: ${explorer}/tx/${launchHash}`);

const [launched] = parseEventLogs({ abi: factoryAbi, eventName: "TokenLaunched", logs: launchReceipt.logs });
if (!launched) fail("launch mined but no TokenLaunched event was found; check the transaction on the explorer");
const { token, curve } = launched.args;
const [onchainSymbol, totalSupply] = await Promise.all([
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
]);
Object.assign(record, { token, curve, symbol: onchainSymbol, totalSupply, launchBlock: launchReceipt.blockNumber });
save();
console.log(`✓ $${onchainSymbol} launched`);
row("Token", `${token}  ${explorer}/address/${token}`);
row("Curve", curve);

if (config.devBuyWei > 0n) {
  const buy = { address: curve, abi: curveAbi, functionName: "buy", value: config.devBuyWei, account };
  const sim = await publicClient
    .simulateContract({ ...buy, args: [config.devBuyWei, 0n, account.address] })
    .catch((err) => fail(`dev buy simulation reverted (token is live, buy skipped): ${err.shortMessage ?? err.message}`));
  const floor = minOut(sim.result, config.devBuySlippageBps);
  const { request: buyRequest } = await publicClient.simulateContract({ ...buy, args: [config.devBuyWei, floor, account.address] });
  const buyHash = await walletClient.writeContract(buyRequest);
  record.devBuyTx = buyHash;
  save();
  console.log(`→ dev buy sent: ${explorer}/tx/${buyHash}`);
  const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
  if (buyReceipt.status !== "success") fail(`dev buy reverted (token is live): ${explorer}/tx/${buyHash}`);
  const held = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  record.devBalance = held;
  save();
  console.log(`✓ dev wallet holds ${formatUnits(held, 18)} $${onchainSymbol}`);
}

console.log(`\nSaved ${recordPath}`);
console.log(`Next: ./set-token.sh ${token}   (prepares the admin Safe transaction that sets $LANE)`);
