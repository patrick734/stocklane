// Offline compiler: set SOLCJS_PATH to a soljson.js (solc npm package) when
// binaries.soliditylang.org is unreachable. CI leaves it unset and downloads solc normally.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

if (process.env.SOLCJS_PATH) {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, _hre, runSuper) => {
    const solc = require(require("path").join(require("path").dirname(process.env.SOLCJS_PATH), "index.js"));
    const longVersion = solc.version().replace(/\.Emscripten.*$/, "");
    if (!longVersion.startsWith(solcVersion)) return runSuper();
    return { compilerPath: process.env.SOLCJS_PATH, isSolcJs: true, version: solcVersion, longVersion };
  });
}
