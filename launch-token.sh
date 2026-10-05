#!/usr/bin/env bash
# Launches $LANE on the Pons V2 launchpad from the dev wallet (alternative to launching on the Pons website).
#   ./launch-token.sh            preflight: checks and simulates, sends nothing
#   ./launch-token.sh --launch   real launch (asks you to type LANE first)
# Token name, logo, socials and optional dev buy: launch/lane.config.json
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
[[ -d launch/node_modules ]] || (cd launch && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
[[ -n "${DEPLOYER_ACCOUNT:-}" ]] || { echo "STOPPED: DEPLOYER_ACCOUNT is not set in launch.env" >&2; exit 1; }
export RPC_URL="${ROBINHOOD_RPC_URL:-}"
FLAG=()
[[ "${1:-}" == "--launch" ]] && FLAG=(--broadcast)
node tools/with-key.js "$DEPLOYER_ACCOUNT" -- node launch/launch.mjs "${FLAG[@]}"
