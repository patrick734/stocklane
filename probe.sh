#!/usr/bin/env bash
# Quotes every stock against the real Uniswap v3 and v4 pools through the StockLane router's own code.
# Read-only: sends nothing, needs no key. Works before and after deploying.
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
cd contracts
npx hardhat run scripts/probe-quotes.js
