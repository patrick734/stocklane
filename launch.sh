#!/usr/bin/env bash
# StockLane launch.
#   ./launch.sh --rehearsal   full deploy on a local copy of Robinhood Chain: free, sends nothing
#   ./launch.sh               real deploy from the dev wallet named in launch.env
# Settings come from launch.env (copy launch.env.example). Keys never go in that file: the dev wallet is a
# password-encrypted keystore made with `node tools/import-key.js <name>`.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n== %s\n' "$1"; }
stop() { printf 'STOPPED: %s\n' "$1" >&2; exit 1; }

REHEARSAL=0
[[ "${1:-}" == "--rehearsal" ]] && REHEARSAL=1

command -v node >/dev/null || stop "Node.js is not installed. Get version 22 from https://nodejs.org"
[[ -f launch.env ]] || stop "launch.env is missing. Run: cp launch.env.example launch.env, then fill it in."

step "Settings"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
echo "Loaded launch.env"
for v in ADMIN_MULTISIG GUARDIAN_MULTISIG KEEPER_ADDRESS DEPLOYER_ACCOUNT; do
  [[ -n "${!v:-}" ]] || stop "$v is not set in launch.env"
done
DEPLOYER_ADDRESS=$(node tools/wallet.js address "$DEPLOYER_ACCOUNT")
export DEPLOYER_ADDRESS
echo "Dev wallet:   $DEPLOYER_ADDRESS ($DEPLOYER_ACCOUNT) deploys, then holds no power"
echo "Admin:        $ADMIN_MULTISIG (proposes to the 48h timelock)"
echo "Guardian:     $GUARDIAN_MULTISIG (can only pause)"
[[ "${ALLOW_PLAIN_WALLETS:-}" == "1" ]] && echo "              admin and guardian are plain wallets (ALLOW_PLAIN_WALLETS=1)"
echo "Keeper:       $KEEPER_ADDRESS"
if [[ -n "${LANE_TOKEN_ADDRESS:-}" ]]; then echo "\$LANE:       $LANE_TOKEN_ADDRESS"; else echo "\$LANE:       not launched yet; set it later with ./set-token.sh"; fi
[[ -n "${ROBINHOOD_RPC_URL:-}" ]] && echo "RPC:          private RPC from launch.env" || echo "RPC:          public Robinhood RPC (set ROBINHOOD_RPC_URL if it keeps dropping)"

if [[ $REHEARSAL == 0 && -f contracts/deployments/robinhood.json && "${FORCE:-}" != "1" ]]; then
  stop "contracts/deployments/robinhood.json exists, so StockLane is already deployed. Use FORCE=1 only for a second, separate deployment."
fi

cd contracts
step "Compiling"
npx hardhat compile --quiet

step "Preflight checks"
[[ $REHEARSAL == 1 ]] && export MIN_DEPLOYER_ETH=0
node scripts/preflight.js || stop "Preflight failed. Fix the FAIL lines above and run again."

if [[ $REHEARSAL == 1 ]]; then
  step "Rehearsal deploy on a local copy of Robinhood Chain"
  rm -f deployments/fork.json
  if ! FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js; then
    rm -f deployments/fork.json
    stop "The rehearsal failed (see above). A dropped connection shows up here too: set ROBINHOOD_RPC_URL to a private RPC and run again."
  fi
  [[ -f deployments/fork.json ]] || stop "The rehearsal ended without writing its record, so it did not complete. Run again."
  rm -f deployments/fork.json deployments/hardhat.json
  printf '\nREHEARSAL PASSED. Nothing was sent. Deploy for real with: ./launch.sh\n'
  exit 0
fi

step "Real deploy"
echo "This deploys StockLane to Robinhood Chain mainnet, paying gas from $DEPLOYER_ADDRESS."
echo "Deploy during US market hours (6:30 AM to 1:00 PM PT) so stock prices are fresh."
read -r -p "Type DEPLOY to continue: " answer </dev/tty
[[ "$answer" == "DEPLOY" ]] || stop "Cancelled. Nothing was sent."
if ! node ../tools/with-key.js "$DEPLOYER_ACCOUNT" -- npx hardhat run scripts/deploy.js --network robinhood; then
  if [[ -f deployments/robinhood.json ]]; then
    node scripts/export-abis.js
    stop "StockLane IS deployed (deployments/robinhood.json); only the checks after it failed. Do not deploy again: run ./verify.sh."
  fi
  stop "The deploy did not finish (see above). Contracts from a half-finished attempt hold nothing and are never listed by the app; once the cause is fixed, run ./launch.sh again for a full fresh set."
fi

step "Publishing addresses to the app"
node scripts/export-abis.js

step "Deployed"
cat <<'EOF'
Addresses: contracts/deployments/robinhood.json

Next:
  1. git add -A && git commit -m "Mainnet deployment" && git push      (Vercel publishes the live site)
  2. ./verify.sh                                                        (post the output: proof the deployer holds nothing)
  3. Keep ETH in the dev wallet: it launches $LANE on Pons next.
  4. Launch $LANE on Pons, then: ./set-token.sh <token address>   (48h timelock, then buy-and-burn starts)
  5. Keeper: GitHub > Actions > "Keeper" > Run workflow (dry run). When it looks healthy, set KEEPER_LIVE=1.
  6. Vercel: import the repo, Root Directory "app", then add your domain (stocklane.fun).
EOF
