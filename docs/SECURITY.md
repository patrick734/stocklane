# StockLane security model

## Roles

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Admin | OpenZeppelin `TimelockController`, 48h minimum delay, proposer and executor = admin wallet or Safe, no external admin | change the swap fee (0 to 0.30%), the price-guard band (0.01% to 10%), allowed v4 hooks, oracle feeds and breaker, burn limits; set $LANE once; unpause; sweep tokens sent to the router by mistake. All after 48h in public | touch a trader's tokens; raise the fee above 0.30%; change $LANE once set; withdraw from DrawdownRetire |
| Guardian | A second wallet or Safe | pause swaps, halt the burn | unpause, raise anything, move funds |
| Keeper | Hot wallet, key only in GitHub Actions | forward fees, buy and burn $LANE within per-run caps and a 1-hour minimum interval | anything else |
| Deployer | Fresh wallet | launch $LANE on Pons | **nothing after deployment**: no role, no ownership, no timelock rights |

Every constructor runs `GovernanceChecks`: the admin must be a timelock with at least 48h delay that the deployer
cannot administer, propose to, execute on or cancel; guardian, keeper and admin must be distinct and none may be
the deployer. `scripts/verify.js` also checks the timelock bytecode against OpenZeppelin's and replays every role
event, so it proves the full set of role holders.

## LaneRouter

Exact-input swaps, split across up to 4 legs of up to 3 hops each, through Uniswap v3 and v4.

- **No custody.** Input is pulled, routed, and the output (measured as the router's balance change) is sent to
  the recipient in one transaction. Fee-on-transfer inputs are rejected.
- **Full fills only.** Each hop must consume exactly its input, otherwise `PartialFill`. This also means v4
  flash-accounting deltas net to zero for every intermediate currency.
- **Callbacks.** `uniswapV3SwapCallback` is accepted only from the pool the router is calling at that moment,
  which must also be `factory.getPool(tokenIn, tokenOut, fee)`. `unlockCallback` is accepted only from the
  PoolManager while the router itself holds the unlock.
- **Hooks.** v4 hops must be hookless or use a timelock-allowlisted hook. At launch only the Pons hook is
  allowed, so the keeper can reach the $LANE pool.
- **Native ETH** may appear only between two v4 hops (inside one unlock), never as input or output.
- **Price guard.** When both tokens have a fresh Chainlink price (`LaneOracle.isFresh`), the output's USDG value
  may be at most `maxOracleDeviationBps` (3% at launch) below the input's after fee. When a price is not fresh
  (market closed, corporate action, circuit breaker), the guard is skipped and only the trader's `minOut`
  protects the swap. The app shows which case applies before signing.
- **Reentrancy.** `swap`, `quote` and `sweep` are `nonReentrant`; `quoteSegment` only runs when the router calls
  itself during `quote`.

## Buy-and-burn

Fees go `LaneRouter → FeeRouter → DrawdownRetire`. FeeRouter's destination can change only after a 48h delay
inside FeeRouter itself, plus the timelock's 48h. DrawdownRetire has no withdraw path: assets leave only as
burned $LANE. It swaps through `LaneRouterAdapter` (stateless, no owner) and LaneRouter, so the same routing
and full-fill checks apply. $LANE has no oracle: the keeper's `minLaneOut` comes from a quote of the same pool,
so a manipulated Pons pool is bounded by the per-run caps (250 USDG or 1 stock token) and the 1-hour interval.

## Oracle

`LaneOracle` adds to Chainlink's freshness check: per-feed answer bounds (a tenth to ten times the launch price),
USDG bounds ($0.95 to $1.05), a round-to-round circuit breaker (15% within 30 minutes at launch), the sequencer
check and the stock token's corporate-action flag. `status()` says why a token is unpriced.

## Known limitations

- **Routes are found off-chain.** A buggy or malicious front end could propose a poor route. The router still
  enforces `minOut` and the price guard, and the app shows both before signing.
- **Outside market hours** there is no fresh stock price, so the guard is off and the trader's slippage setting
  is the only protection.
- **`GovernanceChecks` trusts the admin's own answers.** `verify.js` closes this off-chain by comparing bytecode.
- **Pons hook.** The $LANE pool uses a third-party hook. Only that hook is allowlisted; the timelock can revoke it.
- **Unaudited.** No third-party audit yet. Start with modest volumes.

## Audit scope

`src/LaneRouter.sol`, `src/LaneRouterAdapter.sol`, `src/LaneOracle.sol`, `src/DrawdownRetire.sol`,
`src/FeeRouter.sol`, `src/governance/GovernanceChecks.sol`.
