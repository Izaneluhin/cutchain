# cutchain / mint

Scripts to launch a token on **Pons V2** (Robinhood Chain's launchpad: bonding curve → Uniswap V4),
read its **curve / graduation status**, **claim creator fees** from the Fee Escrow, and open an optional
**Uniswap V3 side pool against a Stock Token** (AMZN by default). TypeScript + [viem](https://viem.sh).

> ## ⚠️ Read before the first real run
> The V2 ABIs were derived by hand from the official Pons source and docs — **no compiled ABI is
> published and the explorer was unreachable from the build sandbox** — and nothing here has run
> against the live chain. Every write script therefore checks that the function selector it is about
> to call exists in the deployed bytecode and that `eth_call` succeeds before signing anything. Still:
> **your first real run must be a throwaway token.** `npm run launch -- … --dry-run` first, read the
> factory state / fee model / simulation it prints, then launch something like `CUTTEST` with no
> `--dev-buy-eth` and the launch fee only. Only after `npm run status` shows a sane curve should you
> launch the real thing. Pons V2 itself is unaudited per its docs. Details: `CHAIN.md`.

## Install & configure

```bash
cd mint
npm install                      # viem, dotenv, tsx, typescript (+ @types/node)
cp .env.example .env             # set RPC_URL (Alchemy recommended) and PRIVATE_KEY
npm run typecheck                # optional
npm run test:dry                 # offline dry runs of launch / pool / claim
```

`PRIVATE_KEY` is read once in `lib/config.ts`, turned into a viem account, and never logged. Every
script works without it in `--dry-run` mode (simulations then use `--from <address>` or a placeholder,
funded through an `eth_call` state override).

## Scripts

| Command | What it does |
|---|---|
| `npm run launch -- --name CutTest --symbol CUTT --image ipfs://… --dry-run` | Build + simulate the V2 launch. Drop `--dry-run` to send. |
| `npm run status -- --token 0x…` | Curve progress, price, graduation phase, escrow balance, V4 pool id. |
| `npm run claim -- --token 0x… [--sweep] --dry-run` | Withdraw creator fees from the Fee Escrow. |
| `npm run pool -- --token 0x… --price 0.001 --amount-token 1000000 --dry-run` | Uniswap **V3** side pool TOKEN/AMZN (see note below). |
| `npm run launch:v1` / `status:v1` / `claim:v1` | Legacy Pons V1 scripts (fixed supply + locked Uniswap V3). |
| `npm run abis` | Regenerate `abi/pons_v2_*.json` from `lib/abis_v2.ts`. |
| `npm run mock` | Local mock JSON-RPC for exercising the online code paths. |

All write scripts share one dry-run contract (`lib/tx.ts`): always print target, function, args, ABI
calldata and value; when the RPC is reachable also run `eth_call` (decoded return / decoded custom
error) and `eth_estimateGas`; without `--dry-run` sign, send, wait for the receipt, print explorer
links. A failed simulation aborts a live send.

### launch.ts (Pons V2)

```
--name --symbol                required (max 64 / 16 chars)
--image --description          on-chain metadata (max 512 / 2048)
--twitter --telegram --discord --website --farcaster
--creator-fee-recipient 0x…    where creator fees accrue (default sender)
--creator-tax-bps N            extra trade tax paid 100% to the creator; refused above factory.maxCreatorTaxBps
--buybacks                     enable buy-back-and-lock of the creator's buyback slice (togglable later)
--dev-buy-eth 0.01             launcher's first buy, sent as a 2nd tx right after the launch (snipe-tax exempt)
--atomic                       do the dev buy atomically through the Launch-and-Buy router (docs-only ABI)
--launch-config N              factory preset (default: first enabled; the script lists them)
--pair-token 0x…               quote asset (default native ETH; ERC-20s must be factory-approved)
--exempt 0x…,0x…               extra snipe-tax-exempt wallets (max 32)
--salt 0x…  --no-pin  --slippage-bps 100  --from 0x…  --force  --dry-run
```

**Exact on-chain steps of one `launchToken` call** (from the verified `PonsV2LaunchFactory.sol`):

1. `canLaunch(sender)` (public gate or whitelist) and **`msg.value == launchFee()` exactly** — the script
   reads the fee live; V2 does not accept extra value.
2. `creatorTaxBps <= maxCreatorTaxBps()`; pair token approved (if ERC-20); selected config enabled;
   `expectedEconomics` (fetched via `previewLaunchEconomics`) must still match, so an owner re-peg between
   quote and send reverts instead of silently changing terms.
3. `PonsV2LaunchDeployer` deploys the **bonding curve** and the **token** (CREATE2 with your salt); the
   **entire supply mints to the curve**; `curve.initialize` fixes `reservedTokens = supply × phantomQuote /
   (phantomQuote + graduationThreshold)`.
4. The launcher and the creator fee recipient are exempted from the snipe tax (plus your `--exempt` list).
5. The launch record and a snapshot of the hook's fee policy are stored; the launch fee is forwarded to
   the protocol recipient.
6. `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)`.

Trading opens immediately on the curve at `phantomQuote / supply`. **Graduation** happens inside the buy
that exhausts the sellable allocation (= when `graduationThreshold` of quote has been raised): the curve
sweeps fees, hands its reserves to the factory, which mints a full-range **Uniswap V4** position (fee 0 +
Pons meme hook) and transfers it to the Launch Locker permanently. If that step fails, anyone can call
`factory.graduate(token)` / `factory.createGraduatedPool(token)`.

**Dev buy.** With `--dev-buy-eth` the script sends a second tx `curve.buy(quoteIn, minTokensOut, you)`
after the launch. The launcher is snipe-tax exempt, so this clears at the untaxed price; the script
reads `currentSnipeTaxBps(you)` first and refuses if it is not 0 (override `--force`). `--atomic` uses
`PonsV2LaunchAndBuy.launchAndBuy` (value = fee + buy) whose ABI is docs-only; the selector is checked
against the router bytecode before sending.

**Fee model (how it is represented in the code).** Per trade the curve charges, on the quote leg,
`config.curveFeeBps` (base) **+** `params.creatorTaxBps` (creator tax). At sweep (`lib/curve.ts` mirrors
`PonsV2BondingCurve._sweepFees`):

```
protocol = fee × protocolFeeShareBps / 1e4
bucket   = fee − protocol
buyback  = buybackEnabled ? bucket × buybackBurnBps / 1e4 : 0     → swapped for the token, locked 5 years
creator  = bucket − buyback + creatorTax                          → credited to the Fee Escrow
```

`launch.ts` prints this split with the live policy and a worked 1 ETH example; `status.ts` applies it to
the curve's unswept balances; `claim.ts` shows it next to the escrow balance. After graduation the V4
pool charges 0 and the meme hook charges `hookFeeBps` + the same creator tax with the same split.

**Snipe tax.** Buys during the first seconds after launch pay an extra tax that starts at 99% and decays
exponentially to 0 (docs: 5 s; ~25% at 1 s, ~3% at 2 s), capped so the buyer nets at least 1%. Sells are
never taxed. Exempt: launcher, creator fee recipient, `--exempt` list, and (with `--atomic`) the buy
recipient. `status.ts --for 0x…` shows the current tax for any address.

**Costs.** `launchFee()` (read live; V1 was 0.0005 ETH) + gas for the launch (curve + token deploys,
expect a few million gas at Robinhood Chain prices — the dry run prints the estimate) + any dev buy.

### status.ts

Launch record (curve, deployer, creator recipient, phase `NotGraduated / Swept / PoolCreated / Rescued`,
creator tax, buybacks, snapshotted fee policy), token metadata, **curve progress** (tokens sold vs the
sellable allocation, quote raised vs the graduation threshold), reserves, spot price and FDV, what 1 ETH
buys right now (with the snipe tax for `--for`), unswept fees and how they will split, **Fee Escrow
balance** of the creator recipient, buyback vault vest, and the **Uniswap V4 pool id** (with the hook's
registration and pending fees once graduated).

### claim.ts

Reads the launch record and the escrow balance of the sender (balances are per address — the sender must
be the creator fee recipient to receive that launch's fees), optionally `--sweep`s unswept curve fees
first, then calls `claim()` (ETH) or `claimToken(pairToken)` (ERC-20 pair). Guard: refuses to send unless
the selector is present in the escrow bytecode, the simulation passes and the balance is non-zero.

### pool.ts (Uniswap V3 side pool)

A V2 launch's **primary** market is the bonding curve and, after graduation, its Uniswap **V4** pool
through the meme hook (`status.ts` prints the pool id). `pool.ts` creates an *additional* Uniswap V3 pool,
e.g. `CUT/AMZN` at 1%, and can mint a full-range position — useful for a Stock-Token pair, but it earns
ordinary V3 LP fees (to your NFT), not Pons creator fees, and you need to hold the tokens first (buy on
the curve). Ordering (`token0 < token1`), `sqrtPriceX96` derivation and full-range ticks are documented
in `lib/price.ts` and at the top of the script.

## Verified vs. not (details and sources in CHAIN.md)

| Verified | NOT verified |
|---|---|
| chain id 4663, public RPC, Blockscout explorer | current `launchEnabled` / whitelist, the live launch fee, which launch config is the public one (all read live) |
| WETH, Uniswap V3 + V4 addresses (Uniswap deployments file) | V2 ABIs against explorer bytecode (hand-derived from source + docs; runtime selector check) |
| V2 factory, hook, locker addresses (docs + 2nd source); escrow / vault (docs; cross-checked live against factory getters) | `PonsV2LaunchAndBuy` ABI (docs only), `currentSnipeTaxBps` (docs only) |
| launch flow, fee split, graduation and pool-id derivation (from the official V2 source) | live values of `protocolFeeShareBps / buybackBurnBps / hookFeeBps` (read live) |
| AMZN Stock Token address (Robinscan + OpenSea) | Stock-Token transfer restrictions that could block V3 LP minting |
| V1 factory ABI (official repo) | V1 locker claim function |

## Tests

`tests/dry_run.txt` holds the required offline dry runs plus runs against `tests/mock_rpc.ts`, a small
JSON-RPC server returning ABI-encoded canned answers (V1 and V2 fixtures) so the online paths — config
listing, economics pin, ABI self-check, simulation, receipt/event parsing, dev buy, status, escrow claim —
are exercised without a network. The mock proves nothing about the live contracts.

```bash
npm run mock &                                              # 127.0.0.1:8555
RPC_URL=http://127.0.0.1:8555 npm run launch -- --name X --symbol Y --creator-tax-bps 100 --buybacks --dev-buy-eth 0.01 --dry-run
RPC_URL=http://127.0.0.1:8555 npm run status -- --token 0x3333333333333333333333333333333333333333
```

## Files

```
launch.ts  status.ts  claim.ts     Pons V2 entry points
pool.ts                            Uniswap V3 side pool (unchanged)
launch-v1.ts  status-v1.ts  claim-v1.ts   legacy Pons V1
lib/config.ts     chain, addresses, env, clients, explorer links
lib/abis_v2.ts    V2 ABIs (human-readable source of truth) + canonical signatures for the bytecode check
lib/abis.ts       V1 factory (official JSON), V1 token/locker, Uniswap V3, ERC-20
lib/curve.ts      V2 curve maths (buy quote incl. fees/snipe tax, reserved supply, V4 poolId)
lib/price.ts      V3 sqrtPriceX96 / tick / liquidity maths
lib/tx.ts         dry-run / simulate / send helper
lib/locker.ts     bytecode selector probing (+ V1 locker helpers)
abi/pons_v2_*.json   generated by scripts/write_abis.ts (hand-derived; see CHAIN.md)
abi/pons_v1_*.json   V1 factory (official) / locker (partial)
tests/mock_rpc.ts, tests/dry_run.txt
CHAIN.md          research notes with sources
```

## Decisions made without asking

* Targeted Pons **V2** for the main scripts; V1 kept as `*-v1.ts` because it was a rename plus a few identifier changes.
* Dev buy defaults to a second `curve.buy` transaction (fully covered by source) rather than the router (docs-only ABI); `--atomic` opts into the router.
* The economics pin (`previewLaunchEconomics`) is on by default; `--no-pin` disables it.
* Live sends abort on: selector missing from bytecode, failed simulation, creator tax above the live max, dev buy not snipe-exempt, zero escrow balance.
* `--creator-tax-bps` is validated twice: against the source ceiling (1000) offline and against `maxCreatorTaxBps()` live.
