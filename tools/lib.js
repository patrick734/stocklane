// Shared helpers for the launch tools: launch.env parsing, encrypted keystores, hidden prompts.
// Plain Node (CommonJS) + ethers from contracts/node_modules, so nothing extra to install.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, "launch.env");
const KEYSTORE_DIR = path.join(os.homedir(), ".stocklane", "keystores");

function ethers() {
  try {
    return require(path.join(ROOT, "contracts", "node_modules", "ethers"));
  } catch {
    fail("contracts/node_modules is missing. Run: (cd contracts && npm ci)");
  }
}

function fail(msg) {
  console.error(`STOPPED: ${msg}`);
  process.exit(1);
}

/** Reads launch.env tolerantly: KEY=VALUE lines, # comments, no trailing newline needed, last value wins. */
function readEnv(file = ENV_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Sets KEY=VALUE in launch.env, replacing an existing line or appending one on its own line. */
function writeEnvValue(key, value, file = ENV_FILE) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, `${key}=${value}`);
  else text = (text && !text.endsWith("\n") ? text + "\n" : text) + `${key}=${value}\n`;
  fs.writeFileSync(file, text);
}

function keystorePath(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name || "")) fail("wallet names may use letters, numbers, - and _ only");
  return path.join(KEYSTORE_DIR, `${name}.json`);
}

function keystoreAddress(name) {
  const file = keystorePath(name);
  if (!fs.existsSync(file)) fail(`no saved wallet named "${name}". Import it with: node tools/import-key.js ${name}`);
  return ethers().getAddress("0x" + JSON.parse(fs.readFileSync(file, "utf8")).address);
}

/** Prompts on the terminal without echoing the answer. */
function promptHidden(question) {
  process.stdout.write(question);
  const tty = fs.openSync("/dev/tty", "r");
  try {
    execFileSync("stty", ["-echo"], { stdio: [tty, "inherit", "inherit"] });
    const buf = Buffer.alloc(1024);
    let s = "";
    for (;;) {
      const n = fs.readSync(tty, buf, 0, buf.length, null);
      if (n <= 0) break;
      s += buf.toString("utf8", 0, n);
      if (s.includes("\n")) break;
    }
    return s.split("\n")[0].replace(/\r$/, "");
  } finally {
    execFileSync("stty", ["echo"], { stdio: [tty, "inherit", "inherit"] });
    fs.closeSync(tty);
    process.stdout.write("\n");
  }
}

function prompt(question) {
  process.stdout.write(question);
  const tty = fs.openSync("/dev/tty", "r");
  const buf = Buffer.alloc(1024);
  let s = "";
  for (;;) {
    const n = fs.readSync(tty, buf, 0, buf.length, null);
    if (n <= 0) break;
    s += buf.toString("utf8", 0, n);
    if (s.includes("\n")) break;
  }
  fs.closeSync(tty);
  return s.split("\n")[0].trim();
}

/** Decrypts a saved wallet. The key stays in this process. */
async function unlock(name) {
  const file = keystorePath(name);
  if (!fs.existsSync(file)) fail(`no saved wallet named "${name}". Import it with: node tools/import-key.js ${name}`);
  const json = fs.readFileSync(file, "utf8");
  const password = process.env.KEYSTORE_PASSWORD ?? promptHidden(`Password for wallet "${name}": `);
  try {
    return await ethers().Wallet.fromEncryptedJson(json, password);
  } catch {
    fail("wrong password");
  }
}

function githubRepo() {
  let url;
  try {
    url = execFileSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  } catch {
    fail("this folder has no git remote. Run the tools from your clone of the GitHub repo.");
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!m) fail(`origin ${url} is not a GitHub repo`);
  return `${m[1]}/${m[2]}`;
}

module.exports = { ROOT, ENV_FILE, KEYSTORE_DIR, ethers, fail, readEnv, writeEnvValue, keystorePath, keystoreAddress, promptHidden, prompt, unlock, githubRepo };
