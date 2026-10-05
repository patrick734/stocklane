# StockLane

**Every pool. One lane.** Best-price swaps for tokenized stocks on Robinhood Chain, routed across Uniswap v3
and v4, checked against Chainlink. The 0.05% swap fee buys $LANE on Pons and burns it.

- `contracts/`: LaneRouter (split, multi-hop v3 + v4 router with a Chainlink price guard), LaneOracle,
  FeeRouter, DrawdownRetire and LaneRouterAdapter (buy-and-burn), all governed by a 48h timelock from block one.
- `app/`: Next.js swap app. Finds routes in the browser by quoting every candidate through `LaneRouter.quote`.
- `keeper/`: forwards fees and burns $LANE; runs on GitHub Actions every 15 minutes (`KEEPER_LIVE`).
- `launch/`: launches $LANE on the Pons V2 launchpad from the dev wallet.
- `tools/`: encrypted keystores for wallets imported from MetaMask; keys never sit in files or chat.

Launch guide: [docs/LAUNCH.md](docs/LAUNCH.md). Security model: [docs/SECURITY.md](docs/SECURITY.md).

## Develop

```bash
cd contracts && npm ci && npx hardhat test          # unit tests
FORK=1 npx hardhat test                             # real pools on a Robinhood Chain fork
npx hardhat node                                    # terminal 1
npx hardhat run scripts/deploy.js --network localhost && node scripts/export-abis.js
cd ../app && npm ci && NEXT_PUBLIC_ENABLE_LOCAL=1 npm run dev
```

Independent software, not affiliated with Robinhood, Uniswap, Chainlink or any issuer. Not investment advice.
