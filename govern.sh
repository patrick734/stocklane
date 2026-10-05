#!/usr/bin/env bash
# Timelock actions (read-only unless --schedule/--execute is given).
#   ./govern.sh status                         what is scheduled, ready or executed
#   ./govern.sh set-fee 10                     change the swap fee (basis points, 0 to 30; launch value 5)
#   ./govern.sh set-fee 10 --schedule          plain-wallet admin: schedule it now (signs with ADMIN_ACCOUNT)
#   ./govern.sh set-fee 10 --execute           plain-wallet admin: execute it after 48 hours
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
CMD="${1:-status}"
ARG=""
if [[ "$CMD" == "set-fee" ]]; then ARG="${2:-}"; MODE="${3:-}"; else MODE="${2:-}"; fi
cd contracts
if [[ "$MODE" == "--schedule" || "$MODE" == "--execute" ]]; then
  [[ -n "${ADMIN_ACCOUNT:-}" ]] || { echo "STOPPED: set ADMIN_ACCOUNT in launch.env to the admin wallet's name (node tools/import-key.js <name>)" >&2; exit 1; }
  GOVERN_SEND="${MODE#--}" KEY_ENV=ADMIN_PRIVATE_KEY node ../tools/with-key.js "$ADMIN_ACCOUNT" -- node scripts/govern.js "$CMD" $ARG
else
  node scripts/govern.js "$CMD" $ARG
fi
