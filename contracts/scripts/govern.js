// Prepares timelock actions for the admin Safe. Read-only: it sends nothing and needs no key.
// Each action is two Safe Transaction Builder files in safe-txs/: "schedule" (submit now) and "execute"
// (submit once the 48h delay has passed). In Safe: Apps > Transaction Builder > drag the file in.
//
//   node scripts/govern.js set-token <address>   set $LANE in DrawdownRetire (once), after the Pons launch
//   node scripts/govern.js set-fee <bps>         change the swap fee (0 to 30 bps; launch value 5)
//   node scripts/govern.js status                list scheduled timelock actions and whether they can execute
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const OUT = path.join(__dirname, "..", "..", "safe-txs");
const DEPLOYMENT = path.join(__dirname, "..", "deployments", "robinhood.json");
const LOG_CHUNK = 400_000;

const TIMELOCK_ABI = [
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
];
const DRAWDOWN_ABI = [
  "function laneToken() view returns (address)",
  "function maxInputPerRun(address) view returns (uint256)",
  "function setLaneToken(address token)",
];
const KNOWN = new ethers.Interface([
  "function setLaneToken(address token)",
  "function setHookAllowed(address hook, bool allowed)",
  "function setFeeBps(uint16 bps)",
  "function setMaxOracleDeviationBps(uint16 bps)",
  "function sweep(address token, address to)",
  "function setFeed(address token, address aggregator, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer)",
  "function setBreaker(uint16 maxJumpBps, uint32 jumpCooldown)",
  "function setInputLimit(address token, uint256 maxPerRun)",
  "function setMinInterval(uint32 interval)",
  "function unpause()",
  "function resume()",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function transferOwnership(address newOwner)",
  "function proposeDestination(address next)",
  "function executeDestination()",
]);

function load() {
  if (!fs.existsSync(DEPLOYMENT)) throw new Error("No contracts/deployments/robinhood.json. Deploy first with ./launch.sh.");
  const d = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  return { d, provider, timelock: new ethers.Contract(d.timelock, TIMELOCK_ABI, provider) };
}

function safeBatch(name, description, admin, txs) {
  return {
    version: "1.0",
    chainId: String(config.network.chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.17.1", createdFromSafeAddress: admin, createdFromOwnerAddress: "" },
    transactions: txs.map((t) => ({ to: t.to, value: "0", data: t.data, contractMethod: null, contractInputsValues: null })),
  };
}

function write(file, obj) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, file);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return path.relative(path.join(__dirname, "..", ".."), p);
}

/** Writes schedule + execute files for one timelock call. */
async function prepare(ctx, slug, title, target, data, salt) {
  const { d, timelock } = ctx;
  const delay = await timelock.getMinDelay();
  const tl = new ethers.Interface(TIMELOCK_ABI);
  const id = await timelock.hashOperation(target, 0, data, ethers.ZeroHash, salt);
  if (await timelock.isOperationDone(id)) return console.log(`"${title}" was already executed. Nothing to do.`);
  const pending = await timelock.isOperationPending(id);
  const schedule = tl.encodeFunctionData("schedule", [target, 0, data, ethers.ZeroHash, salt, delay]);
  const execute = tl.encodeFunctionData("execute", [target, 0, data, ethers.ZeroHash, salt]);
  const a = write(`${slug}-1-schedule.json`, safeBatch(`${title}: schedule`, `Schedules on the StockLane timelock (${Number(delay) / 3600}h delay)`, d.roles.admin, [{ to: d.timelock, data: schedule }]));
  const b = write(`${slug}-2-execute.json`, safeBatch(`${title}: execute`, "Executes the scheduled call once the delay has passed", d.roles.admin, [{ to: d.timelock, data: execute }]));
  console.log(`\nTimelock operation ${id}`);
  if (pending) {
    const ts = Number(await timelock.getTimestamp(id));
    const ready = await timelock.isOperationReady(id);
    console.log(ready ? "Already scheduled and READY: submit the execute file now." : `Already scheduled; executable after ${new Date(ts * 1000).toISOString()}.`);
  }
  const mode = process.env.GOVERN_SEND;
  if (mode) return send(ctx, mode, { schedule, execute, pending, id });
  const isWallet = (await ctx.provider.getCode(d.roles.admin)) === "0x";
  if (isWallet) {
    console.log(`\nThe admin ${d.roles.admin} is a plain wallet. Send it from there with:`);
    console.log(`  1. Now:            ${ctx.cmd} --schedule`);
    console.log(`  2. After ${Number(delay) / 3600} hours:  ${ctx.cmd} --execute   (check with: ./govern.sh status)`);
    return;
  }
  console.log(`\nIn the admin Safe ${d.roles.admin} on app.safe.global:`);
  console.log(`  1. Now:            Apps > Transaction Builder > drag in ${a} > Create batch > sign with the owners`);
  console.log(`  2. After ${Number(delay) / 3600} hours:  same with ${b}  (anyone can check with: ./govern.sh status)`);
}

/** Sends the schedule or execute call from the admin wallet (ADMIN_PRIVATE_KEY, set by tools/with-key.js). */
async function send(ctx, mode, { schedule, execute, pending, id }) {
  const { d, provider, timelock } = ctx;
  if (!process.env.ADMIN_PRIVATE_KEY) throw new Error("no admin key: run this through ./set-token.sh or ./govern.sh with --schedule or --execute");
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  if (wallet.address.toLowerCase() !== d.roles.admin.toLowerCase()) {
    throw new Error(`ADMIN_ACCOUNT is ${wallet.address}, but the timelock's admin is ${d.roles.admin}.`);
  }
  if (mode === "schedule" && pending) return console.log("\nAlready scheduled. Run the same command with --execute once it is ready.");
  if (mode === "execute") {
    if (!pending) throw new Error("not scheduled yet. Run the same command with --schedule first.");
    if (!(await timelock.isOperationReady(id))) {
      const ts = Number(await timelock.getTimestamp(id));
      throw new Error(`not ready yet: executable after ${new Date(ts * 1000).toISOString()}.`);
    }
  }
  if (mode !== "schedule" && mode !== "execute") throw new Error(`unknown mode ${mode}`);
  const tx = await wallet.sendTransaction({ to: d.timelock, data: mode === "schedule" ? schedule : execute });
  console.log(`\n${mode} sent: ${config.network.explorer}/tx/${tx.hash}`);
  const r = await tx.wait();
  if (r.status !== 1) throw new Error("the transaction reverted");
  console.log(mode === "schedule" ? "Scheduled. Run the same command with --execute after the delay." : "Executed.");
}

async function setToken(ctx, address) {
  if (!address || !ethers.isAddress(address)) throw new Error("usage: ./set-token.sh <$LANE token address>");
  const { d, provider } = ctx;
  const token = ethers.getAddress(address);
  if ((await provider.getCode(token)) === "0x") throw new Error(`No contract at ${token} on Robinhood Chain.`);
  const t = new ethers.Contract(token, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function burn(uint256)"], provider);
  const [symbol, decimals, supply] = await Promise.all([t.symbol(), t.decimals(), t.totalSupply()]);
  if (decimals !== 18n) throw new Error(`${symbol} has ${decimals} decimals; DrawdownRetire expects 18.`);
  const from = "0x000000000000000000000000000000000000dEaD";
  const over = await provider.call({ from, to: token, data: t.interface.encodeFunctionData("burn", [10n ** 40n]) }).then(() => true, () => false);
  const zero = await provider.call({ from, to: token, data: t.interface.encodeFunctionData("burn", [0n]) }).then(() => true, () => false);
  if (!zero || over) throw new Error(`${symbol} has no working burn(uint256); DrawdownRetire could not retire it.`);
  console.log(`$LANE candidate: ${symbol} at ${token}, supply ${ethers.formatEther(supply)}, burnable`);

  const dd = new ethers.Contract(d.drawdownRetire, DRAWDOWN_ABI, provider);
  const current = await dd.laneToken();
  if (current !== ethers.ZeroAddress) {
    if (current.toLowerCase() === token.toLowerCase()) return console.log("DrawdownRetire already burns this token. Nothing to do.");
    throw new Error(`DrawdownRetire is already set to ${current}; it can only be set once.`);
  }
  if ((await dd.maxInputPerRun(token)) !== 0n) throw new Error("This token is configured as a fee input; that must be cleared first.");
  ctx.cmd = `./set-token.sh ${token}`;
  await prepare(ctx, "set-token", `Set $LANE to ${symbol}`, d.drawdownRetire, dd.interface.encodeFunctionData("setLaneToken", [token]), ethers.id(`stocklane:set-token:${token.toLowerCase()}`));
  console.log("\nOnce it executes, the keeper buys and burns $LANE through its Pons pool with the swap fees.");
}

async function setFee(ctx, arg) {
  const bps = Number(arg);
  if (!Number.isInteger(bps) || bps < 0 || bps > 30) throw new Error("usage: ./govern.sh set-fee <0-30>  (basis points: 5 = 0.05%)");
  const { d, provider } = ctx;
  const router = new ethers.Contract(d.router, ["function feeBps() view returns (uint16)", "function setFeeBps(uint16 bps)"], provider);
  const current = Number(await router.feeBps());
  if (current === bps) return console.log(`The swap fee is already ${bps} bps. Nothing to do.`);
  console.log(`Swap fee: ${current} bps now, ${bps} bps after the timelock delay`);
  ctx.cmd = `./govern.sh set-fee ${bps}`;
  const data = router.interface.encodeFunctionData("setFeeBps", [bps]);
  // The same change can recur (5 -> 10 -> 5 -> 10), so use the first salt not already executed. It stays the
  // same between --schedule and --execute, because a scheduled operation is pending, not done.
  let salt;
  for (let n = 1; ; n++) {
    salt = ethers.id(`stocklane:set-fee:${current}->${bps}:${n}`);
    if (!(await ctx.timelock.isOperationDone(await ctx.timelock.hashOperation(d.router, 0, data, ethers.ZeroHash, salt)))) break;
  }
  await prepare(ctx, `set-fee-${bps}`, `Set the swap fee to ${bps} bps`, d.router, data, salt);
}

async function status({ d, provider, timelock }) {
  const head = await provider.getBlockNumber();
  const events = [];
  // Free RPC plans cap eth_getLogs ranges; fall back to the public Robinhood RPC for this read.
  const scan = async (tl) => {
    const out = [];
    for (let from = d.startBlock ?? 0; from <= head; from += LOG_CHUNK) {
      out.push(...(await tl.queryFilter(tl.filters.CallScheduled(), from, Math.min(from + LOG_CHUNK - 1, head))));
    }
    return out;
  };
  try {
    events.push(...(await scan(timelock)));
  } catch {
    const pub = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
    events.push(...(await scan(new ethers.Contract(d.timelock, TIMELOCK_ABI, pub))));
  }
  if (!events.length) return console.log("No timelock actions have ever been scheduled.");
  const names = { [d.drawdownRetire.toLowerCase()]: "DrawdownRetire", [d.router.toLowerCase()]: "LaneRouter", [d.oracle.toLowerCase()]: "LaneOracle", [d.feeRouter.toLowerCase()]: "FeeRouter", [d.timelock.toLowerCase()]: "Timelock" };
  for (const e of events) {
    const { id, target, data } = e.args;
    let call = data.slice(0, 10);
    try {
      const p = KNOWN.parseTransaction({ data });
      call = `${p.name}(${p.args.map(String).join(", ")})`;
    } catch {}
    const [done, ready, pending] = await Promise.all([timelock.isOperationDone(id), timelock.isOperationReady(id), timelock.isOperationPending(id)]);
    const ts = Number(await timelock.getTimestamp(id));
    const state = done ? "EXECUTED" : ready ? "READY to execute" : pending ? `waiting until ${new Date(ts * 1000).toISOString()}` : "cancelled";
    console.log(`${state.padEnd(36)} ${names[target.toLowerCase()] ?? target}.${call}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const ctx = load();
  const chainId = Number((await ctx.provider.getNetwork()).chainId);
  if (chainId !== config.network.chainId && process.env.STOCKLANE_LOCAL_TEST !== "1") {
    throw new Error(`the RPC is on chain ${chainId}, not Robinhood Chain (${config.network.chainId}). Check ROBINHOOD_RPC_URL in launch.env.`);
  }
  if (cmd === "set-token") return setToken(ctx, arg);
  if (cmd === "set-fee") return setFee(ctx, arg);
  if (cmd === "status") return status(ctx);
  throw new Error("usage: node scripts/govern.js set-token <address> | set-fee <bps> | status");
}

main().catch((e) => {
  console.error(`STOPPED: ${e.shortMessage || e.message}`);
  process.exit(1);
});
