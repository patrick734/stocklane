#!/usr/bin/env bash
# After launching $LANE on Pons: sets it (once) in DrawdownRetire through the 48h timelock.
#   ./set-token.sh 0xTOKEN              check the token; write Safe files (Safe admin) or show the next command
#   ./set-token.sh 0xTOKEN --schedule   plain-wallet admin: schedule it now (signs with ADMIN_ACCOUNT)
#   ./set-token.sh 0xTOKEN --execute    plain-wallet admin: execute it after 48 hours
set -euo pipefail
cd "$(dirname "$0")"
[[ -n "${1:-}" ]] || { echo "usage: ./set-token.sh <\$LANE token address> [--schedule|--execute]" >&2; exit 1; }
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
TOKEN="$1"
MODE="${2:-}"
cd contracts
if [[ "$MODE" == "--schedule" || "$MODE" == "--execute" ]]; then
  [[ -n "${ADMIN_ACCOUNT:-}" ]] || { echo "STOPPED: set ADMIN_ACCOUNT in launch.env to the admin wallet's name (node tools/import-key.js <name>)" >&2; exit 1; }
  GOVERN_SEND="${MODE#--}" KEY_ENV=ADMIN_PRIVATE_KEY node ../tools/with-key.js "$ADMIN_ACCOUNT" -- node scripts/govern.js set-token "$TOKEN"
else
  node scripts/govern.js set-token "$TOKEN"
fi
