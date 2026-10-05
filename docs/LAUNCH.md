# Launching StockLane

Everything runs from the repo folder on your Mac. Nothing here ever asks you to paste a private key into a file.

## What "rug-proof" means here

None of these wallets can touch a trader's tokens: the router holds nothing between transactions.

| Wallet | What it is | Power |
|---|---|---|
| **Dev wallet** | A new MetaMask account. It pays the deploy gas and launches $LANE. | **None after deploy.** The contracts refuse to deploy if it would keep any role. |
| **Admin Safe** | A Safe multisig (for example 2 of 3 owners). | Proposes changes to the **timelock**. Every change waits **48 hours in public** before it can run. |
| **Guardian Safe** | A second Safe. | Can only **pause** swaps and **halt** the burn. It cannot unpause, raise anything or move funds. |
| **Keeper** | A hot wallet whose key lives only in GitHub Actions. | Forwards fees and runs buy-and-burn, within per-run caps, at most once an hour. |

The timelock is the admin of every contract. If anyone tries something bad, even the admin owners, the change
is visible on-chain for 48 hours first. The swap fee is capped in code at 0.30%, so not even the timelock can
raise it further. Run `./verify.sh` after deploying and post its output: it proves all of this on-chain.

## Before you start

- Node.js 22 (`node -v`), git, and the GitHub CLI: `brew install gh && gh auth login`
- The repo cloned: `git clone https://github.com/patrick734/stocklane && cd stocklane`
- About 0.03 ETH on Robinhood Chain for the dev wallet, and 0.01 ETH for the keeper

## 1. Admin and guardian

Pick one:

- **Two Safes** on [app.safe.global](https://app.safe.global) (network: Robinhood Chain). Click "Activate account"
  on each, so it exists on-chain. Strongest option: you can add co-signers later without redeploying.
- **Two plain MetaMask wallets**, both new and different from the dev wallet and the keeper. Set
  `ALLOW_PLAIN_WALLETS=1` in `launch.env`, and save the admin wallet so the scripts can sign timelock actions:

  ```bash
  node tools/import-key.js stocklane-admin
  ```

  Then set `ADMIN_ACCOUNT=stocklane-admin` in `launch.env`. The guardian wallet only needs its address; you use
  it in MetaMask if you ever need to pause.

## 2. Dev wallet

In MetaMask: Add account > Create a new account. Send it 0.03 ETH on Robinhood Chain (straight from an exchange
is fine). Then save it as an encrypted keystore:

```bash
cd contracts && npm ci && cd ..
node tools/import-key.js stocklane-dev
```

Copy the key in MetaMask (Account details > Show private key) and press Enter. The tool reads it from the
clipboard, clears the clipboard, and asks for a password to encrypt it with. It shows only the address.

## 3. Keeper

```bash
node tools/wallet.js keeper-secret
```

This creates a new keeper wallet, stores its key **only** as the `KEEPER_PRIVATE_KEY` secret of your GitHub repo,
sets the repo variable `KEEPER_LIVE=0`, writes `KEEPER_ADDRESS` into `launch.env`, and prints the address. Send
that address 0.01 ETH.

## 4. Settings

```bash
cp -n launch.env.example launch.env
open -e launch.env
```

Fill in `ADMIN_MULTISIG` and `GUARDIAN_MULTISIG`, check `KEEPER_ADDRESS` and `DEPLOYER_ACCOUNT=stocklane-dev`,
and leave `LANE_TOKEN_ADDRESS` empty. If you have a private RPC (Alchemy), put it on the `ROBINHOOD_RPC_URL=`
line without the `#`.

## 5. Rehearse, then deploy

```bash
./launch.sh --rehearsal
```

This runs the complete deploy on a local copy of Robinhood Chain with your real settings and checks. It is free
and sends nothing. It must end with `REHEARSAL PASSED`. The preflight also lists every stock with its Chainlink
price and the Uniswap v3 pools it found, so you can see where liquidity is.

Optional, to watch real swaps on the copy: `cd contracts && FORK=1 npx hardhat test` quotes 100 USDG into every
stock across Uniswap v3 and v4 and executes the best routes.

Then run the real deploy:

```bash
./launch.sh
```

Type `DEPLOY` and enter the dev wallet's password. It ends by verifying that the deployer holds no power.

```bash
git add -A && git commit -m "Mainnet deployment" && git push
./verify.sh
```

The push makes Vercel publish the site with the live addresses. Post the `./verify.sh` output.

## 6. Launch $LANE on Pons

Launch it on the Pons website from the dev wallet, or run `./launch-token.sh` (preflight) and then
`./launch-token.sh --launch`. Copy the token address, then:

```bash
./set-token.sh 0xTOKEN
```

This checks the token. Then:

- **Plain-wallet admin:** `./set-token.sh 0xTOKEN --schedule` now, and `./set-token.sh 0xTOKEN --execute`
  48 hours later. Each asks for the admin wallet's password.
- **Safe admin:** it writes two files to `safe-txs/`. In the Safe, open Apps > Transaction Builder, drag in
  `set-token-1-schedule.json` and sign. 48 hours later, do the same with `set-token-2-execute.json`.

`./govern.sh status` shows when it is ready. There is no second step: the Pons hook is already allowed in the
router, so once the token is set the keeper buys $LANE through its Pons pool (USDG → ETH → $LANE) and burns it.
Until then, swap fees wait safely in `DrawdownRetire`.

## 7. Keeper

GitHub > Actions > **Keeper** > Run workflow. While `KEEPER_LIVE` is `0`, it only simulates and logs. When a few
runs look healthy, set the repo variable `KEEPER_LIVE` to `1` (Settings > Secrets and variables > Actions >
Variables). It then runs every 15 minutes.

## 8. Website on Vercel

Vercel > Add New > Project > import `stocklane` > **Root Directory: `app`** > Deploy. Then Settings > Domains >
add `stocklane.fun` and set the DNS records Vercel shows at your registrar. Every `git push` republishes the
site, so pushing `contracts/deployments/robinhood.json` after the deploy is what makes it live.

## Changing the fee later

`./govern.sh set-fee 10` (basis points; 10 = 0.10%, the code cap is 30). Same flow as set-token:
`--schedule`, then `--execute` 48 hours later, or the two Safe files.

## Troubleshooting

- **`BadRecordMac` or a dropped connection:** the public RPC is flaky. Set `ROBINHOOD_RPC_URL` in `launch.env`.
- **Prices stale in the preflight:** outside US market hours. That is only a warning: deploying is fine.
- **`already deployed`:** `contracts/deployments/robinhood.json` exists. Use `FORCE=1 ./launch.sh` only if you
  really want a second, separate deployment.
