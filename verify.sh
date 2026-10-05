#!/usr/bin/env bash
# Proves on-chain that the deployment is wired correctly and the deployer holds no power. Read-only.
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
cd contracts
npx hardhat run scripts/verify.js --network robinhood
