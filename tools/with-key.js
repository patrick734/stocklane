#!/usr/bin/env node
// Runs a command with DEPLOYER_PRIVATE_KEY (or the variable named by KEY_ENV) set from a saved wallet,
// for that process only.
//   node tools/with-key.js <wallet-name> -- <command> [args...]
// The key is never printed or written to disk.
const { spawnSync } = require("child_process");
const { fail, unlock } = require("./lib");

async function main() {
  const [name, sep, cmd, ...args] = process.argv.slice(2);
  if (!name || sep !== "--" || !cmd) fail("usage: node tools/with-key.js <wallet-name> -- <command> [args...]");
  const wallet = await unlock(name);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, [process.env.KEY_ENV || "DEPLOYER_PRIVATE_KEY"]: wallet.privateKey } });
  process.exit(r.status ?? 1);
}

main().catch((e) => fail(e.message));
