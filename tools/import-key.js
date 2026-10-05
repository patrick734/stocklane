#!/usr/bin/env node
// Saves a MetaMask private key as an encrypted keystore in ~/.stocklane/keystores/<name>.json.
//   1. In MetaMask: Account details > Show private key > copy.
//   2. node tools/import-key.js stocklane-dev
// The key is read from the clipboard (macOS), never shown, and the clipboard is cleared afterwards.
// Without a clipboard (Linux), it is asked for with hidden input instead.
const fs = require("fs");
const { execFileSync } = require("child_process");
const { KEYSTORE_DIR, ethers, fail, keystorePath, prompt, promptHidden } = require("./lib");

async function main() {
  const name = process.argv[2];
  if (!name) fail("usage: node tools/import-key.js <wallet-name>   (for example stocklane-dev)");
  const file = keystorePath(name);
  if (fs.existsSync(file) && process.env.FORCE !== "1") fail(`a wallet named "${name}" already exists. Use another name, or FORCE=1 to replace it.`);

  let key;
  const mac = process.platform === "darwin";
  if (mac) {
    prompt("Copy the private key in MetaMask, then press Enter here... ");
    key = execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } else {
    key = promptHidden("Paste the private key (hidden): ").trim();
  }
  if (!key.startsWith("0x")) key = "0x" + key;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    if (mac) execFileSync("pbcopy", { input: "" });
    fail("that is not a private key (64 hex characters). The clipboard was cleared; copy it again.");
  }
  if (mac) execFileSync("pbcopy", { input: "" });

  const wallet = new (ethers().Wallet)(key);
  console.log(`Wallet address: ${wallet.address}`);
  const pw = promptHidden("Choose a password to encrypt it (min 8 characters): ");
  if (pw.length < 8) fail("password too short");
  if (promptHidden("Repeat the password: ") !== pw) fail("passwords did not match");

  console.log("Encrypting (takes a few seconds)...");
  const json = await wallet.encrypt(pw);
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, json, { mode: 0o600 });
  console.log(`Saved ${file}`);
  console.log(`Address: ${wallet.address}`);
  console.log("The clipboard was cleared. Keep the password safe: without it this file cannot be used.");
}

main().catch((e) => fail(e.message));
