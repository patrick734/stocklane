// Checks a StockLane deployment on-chain. Read-only, needs no key, and anyone can run it:
//   npx hardhat run scripts/verify.js --network robinhood        (reads deployments/robinhood.json)
//   DEPLOYMENT=deployments/fork.json npx hardhat run scripts/verify.js
// Exits 1 if any check fails. deploy.js runs the same checks right after deploying.
const fs = require("fs");
const path = require("path");

const MIN_DELAY = 48n * 3600n;

/**
 * Role events for several contracts in one sweep. Free RPC plans cap eth_getLogs ranges (Alchemy free: 10
 * blocks), so: one request on the given RPC, then one on the public Robinhood RPC, then 10-block chunks.
 */
async function roleLogs(ethers, addresses, fromBlock) {
  const iface = new ethers.Interface([
    "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
    "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  ]);
  const topics = [[iface.getEvent("RoleGranted").topicHash, iface.getEvent("RoleRevoked").topicHash]];
  const toBlock = await ethers.provider.getBlockNumber();
  const filter = (from, to) => ({ address: addresses, topics, fromBlock: from, toBlock: to });
  const parse = (logs) => logs.map((l) => ({ address: l.address.toLowerCase(), ...iface.parseLog(l) }));
  try {
    return parse(await ethers.provider.getLogs(filter(fromBlock, toBlock)));
  } catch {}
  const config = require("../config/robinhood.json");
  if (config.network.chainId === Number((await ethers.provider.getNetwork()).chainId)) {
    const pub = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
    for (let i = 0; i < 2; i++) {
      try {
        return parse(await pub.getLogs(filter(fromBlock, toBlock)));
      } catch {}
    }
  }
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += 10) {
    const to = Math.min(from + 9, toBlock);
    for (let tries = 0; ; tries++) {
      try {
        out.push(...(await ethers.provider.getLogs(filter(from, to))));
        break;
      } catch (e) {
        if (tries >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * (tries + 1)));
      }
    }
  }
  return parse(out);
}

async function verifyDeployment(ethers, d, { requireMultisigs = false } = {}) {
  let failures = 0;
  const check = (ok, msg) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`);
    if (!ok) failures++;
  };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const fromBlock = d.startBlock ?? 0;

  console.log("Timelock");
  const tl = await ethers.getContractAt("TimelockController", d.timelock);
  const artifact = await require("hardhat").artifacts.readArtifact("TimelockController");
  const code = await ethers.provider.getCode(d.timelock);
  check(ethers.keccak256(code) === ethers.keccak256(artifact.deployedBytecode), "bytecode is the unmodified OpenZeppelin TimelockController");
  const delay = await tl.getMinDelay();
  check(delay >= MIN_DELAY, `minimum delay ${delay / 3600n}h (at least 48h)`);
  const R = { admin: await tl.DEFAULT_ADMIN_ROLE(), proposer: await tl.PROPOSER_ROLE(), executor: await tl.EXECUTOR_ROLE(), canceller: await tl.CANCELLER_ROLE() };
  for (const [name, role] of Object.entries(R)) {
    check(!(await tl.hasRole(role, d.deployer)), `deployer is not a timelock ${name}`);
  }
  check(await tl.hasRole(R.proposer, d.roles.admin), "admin multisig can propose");
  check(!(await tl.hasRole(R.admin, d.roles.admin)), "admin multisig cannot bypass the timelock's own role management");
  // contract label, address, roles it must hold exactly
  const accessControlled = [
    ["LaneRouter", d.router, ["admin", "guardian"]],
    ["DrawdownRetire", d.drawdownRetire, ["admin", "guardian", "keeper"]],
  ];
  const logs = await roleLogs(ethers, [d.timelock, ...accessControlled.map(([, a]) => a)], fromBlock);
  const tlGrants = logs.filter((l) => l.address === d.timelock.toLowerCase() && l.name === "RoleGranted" && l.args.role === R.admin);
  check(tlGrants.every((e) => same(e.args.account, d.timelock)), "only the timelock administers itself");

  if (requireMultisigs) {
    console.log("Multisigs");
    for (const name of ["admin", "guardian"]) {
      check((await ethers.provider.getCode(d.roles[name])) !== "0x", `${name} ${d.roles[name]} is a contract`);
    }
  }

  console.log("Role holders");
  for (const [label, address, names] of accessControlled) {
    const c = await ethers.getContractAt("DrawdownRetire", address); // same AccessControl ABI
    const roleIds = {
      admin: [await c.DEFAULT_ADMIN_ROLE(), d.timelock],
      guardian: [await c.GUARDIAN_ROLE(), d.roles.guardian],
      keeper: [ethers.id("KEEPER_ROLE"), d.roles.keeper],
    };
    const expected = Object.fromEntries(names.map((n) => roleIds[n]));
    const holders = new Map();
    for (const e of logs.filter((l) => l.address === address.toLowerCase())) {
      const k = `${e.args.role}:${e.args.account.toLowerCase()}`;
      if (e.name === "RoleGranted") holders.set(k, [e.args.role, e.args.account]);
      else holders.delete(k);
    }
    const unexpected = [...holders.values()].filter(([role, account]) => !same(expected[role], account));
    check(unexpected.length === 0 && holders.size === names.length, `${label}: exactly ${names.map((n) => (n === "admin" ? "timelock admin" : n)).join(", ")}`);
    check(!(await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), d.deployer)), `${label}: deployer has no admin role`);
  }

  console.log("Owners");
  for (const [label, address] of [
    ["LaneOracle", d.oracle],
    ["FeeRouter", d.feeRouter],
  ]) {
    const c = await ethers.getContractAt("FeeRouter", address); // same Ownable2Step ABI
    check(same(await c.owner(), d.timelock) && same(await c.pendingOwner(), ethers.ZeroAddress), `${label}: owned by the timelock, nothing pending`);
  }

  console.log("Router");
  const router = await ethers.getContractAt("LaneRouter", d.router);
  check(same(await router.poolManager(), d.poolManager), `Uniswap v4 PoolManager ${d.poolManager}`);
  check(same(await router.v3Factory(), d.v3Factory), `Uniswap v3 factory ${d.v3Factory}`);
  check(same(await router.oracle(), d.oracle) && same(await router.quoteToken(), d.usdg), "prices with LaneOracle in USDG");
  check(same(await router.feeRecipient(), d.feeRouter), "swap fees go to FeeRouter");
  const fee = await router.feeBps();
  check(fee <= 30n, `swap fee ${Number(fee) / 100}% (code cap 0.30%)`);
  check((await router.maxOracleDeviationBps()) <= 1_000n, `price guard ${Number(await router.maxOracleDeviationBps()) / 100}% from Chainlink`);
  check(await router.hookAllowed(d.ponsHook), `Pons hook ${d.ponsHook} allowed (the $LANE pool)`);
  check(!(await router.paused()), "not paused");

  console.log("Buy-and-burn");
  const adapter = await ethers.getContractAt("LaneRouterAdapter", d.adapter);
  check(same(await adapter.router(), d.router), "adapter swaps through LaneRouter");
  const drawdown = await ethers.getContractAt("DrawdownRetire", d.drawdownRetire);
  check(same(await drawdown.swapAdapter(), d.adapter), "DrawdownRetire buys through the adapter");
  const onChainToken = await drawdown.laneToken();
  if (d.laneToken) check(same(onChainToken, d.laneToken), `DrawdownRetire burns $LANE ${d.laneToken}`);
  else if (same(onChainToken, ethers.ZeroAddress)) console.log("  info  $LANE not set yet: fees wait in DrawdownRetire until the timelock sets it (set-token.sh)");
  else console.log(`  info  $LANE set on-chain to ${onChainToken} (deployment file not updated yet)`);
  const feeRouter = await ethers.getContractAt("FeeRouter", d.feeRouter);
  check(same(await feeRouter.drawdownRetire(), d.drawdownRetire) && same(await feeRouter.pendingDrawdownRetire(), ethers.ZeroAddress), "FeeRouter sends to DrawdownRetire, no change pending");

  console.log("Oracle");
  const oracle = await ethers.getContractAt("LaneOracle", d.oracle);
  check((await oracle.maxJumpBps()) > 0n && (await oracle.jumpCooldown()) > 0n, `circuit breaker ${await oracle.maxJumpBps()} bps / ${await oracle.jumpCooldown()}s`);
  const missing = [];
  for (const [ticker, t] of Object.entries(d.stocks)) {
    if (!same((await oracle.feeds(t.address)).aggregator, t.feed)) missing.push(ticker);
  }
  check(missing.length === 0, `Chainlink feeds for ${Object.keys(d.stocks).length} stock tokens${missing.length ? ` (wrong: ${missing.join(", ")})` : ""}`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed: the deployer holds no power over StockLane.");
  return failures;
}

async function main() {
  const hre = require("hardhat");
  const file = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Verifying ${path.relative(process.cwd(), file)} on ${hre.network.name}\n`);
  const failures = await verifyDeployment(hre.ethers, d, { requireMultisigs: hre.network.name === "robinhood" && process.env.ALLOW_PLAIN_WALLETS !== "1" });
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { verifyDeployment };
