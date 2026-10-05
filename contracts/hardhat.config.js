require("@nomicfoundation/hardhat-toolbox");
require("./solc-override");

const { ROBINHOOD_RPC_URL, DEPLOYER_PRIVATE_KEY, FORK, FORK_BLOCK } = process.env;
const RPC = ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "./src",
    tests: FORK ? "./test/fork" : "./test/unit",
  },
  mocha: { timeout: FORK ? 600_000 : 60_000 },
  networks: {
    hardhat: {
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
      ...(FORK && {
        chainId: 4663,
        forking: { url: RPC, ...(FORK_BLOCK && { blockNumber: Number(FORK_BLOCK) }) },
      }),
    },
    // Local node on a separate port, used by the keeper bot's tests (keeper/README.md).
    keeper: { url: "http://127.0.0.1:8547" },
    robinhood: {
      url: RPC,
      chainId: 4663,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
