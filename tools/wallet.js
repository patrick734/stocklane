#!/usr/bin/env node
// Wallet helpers.
//   node tools/wallet.js address <name>    address of a saved wallet (no password needed)
//   node tools/wallet.js keeper-secret     creates a new keeper wallet and stores its key ONLY as the GitHub
//                                          Actions secret KEEPER_PRIVATE_KEY of this repo; prints the address and
//                                          writes KEEPER_ADDRESS into launch.env. Also stores ROBINHOOD_RPC_URL
//                                          from launch.env as a secret and sets KEEPER_LIVE=0 if missing.
//                                          Needs the GitHub CLI: brew install gh && gh auth login
// FORCE=1 replaces an existing KEEPER_PRIVATE_KEY secret.
const { execFileSync, spawnSync } = require("child_process");
const { ethers, fail, githubRepo, keystoreAddress, readEnv, writeEnvValue } = require("./lib");

function gh(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") fail("the GitHub CLI is not installed. Run: brew install gh && gh auth login");
  return r;
}

function keeperSecret() {
  const repo = githubRepo();
  const auth = gh(["auth", "status"]);
  if (auth.status !== 0) fail("the GitHub CLI is not logged in. Run: gh auth login");

  const secrets = gh(["secret", "list", "-R", repo]);
  if (secrets.status !== 0) fail(`cannot read secrets of ${repo}: ${secrets.stderr.trim()}`);
  if (/^KEEPER_PRIVATE_KEY\s/m.test(secrets.stdout) && process.env.FORCE !== "1") {
    fail(`${repo} already has a KEEPER_PRIVATE_KEY secret. Run with FORCE=1 to replace it with a new keeper.`);
  }

  const wallet = ethers().Wallet.createRandom();
  const set = gh(["secret", "set", "KEEPER_PRIVATE_KEY", "-R", repo], wallet.privateKey);
  if (set.status !== 0) fail(`could not set the secret: ${set.stderr.trim()}`);

  const env = readEnv();
  if (env.ROBINHOOD_RPC_URL) {
    const rpc = gh(["secret", "set", "ROBINHOOD_RPC_URL", "-R", repo], env.ROBINHOOD_RPC_URL);
    console.log(rpc.status === 0 ? "Stored ROBINHOOD_RPC_URL from launch.env as a repo secret." : "Could not store ROBINHOOD_RPC_URL as a secret.");
  }
  const vars = gh(["variable", "list", "-R", repo]);
  if (!/^KEEPER_LIVE\s/m.test(vars.stdout || "")) {
    gh(["variable", "set", "KEEPER_LIVE", "-R", repo, "--body", "0"]);
    console.log("Set the repo variable KEEPER_LIVE=0 (dry runs only).");
  }

  writeEnvValue("KEEPER_ADDRESS", wallet.address);
  console.log(`Keeper key stored as the KEEPER_PRIVATE_KEY secret of ${repo}. It is not saved anywhere else.`);
  console.log(`KEEPER_ADDRESS=${wallet.address} written to launch.env`);
  console.log(`Keeper address: ${wallet.address}`);
  console.log("Send it 0.01 ETH on Robinhood Chain for gas.");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "address") console.log(keystoreAddress(arg || fail("usage: node tools/wallet.js address <name>")));
else if (cmd === "keeper-secret") keeperSecret();
else fail("usage: node tools/wallet.js address <name> | keeper-secret");
