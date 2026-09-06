# Robinhood Chain / Pons research notes

Everything the `mint/` scripts rely on, with where it came from. Researched 2026-09-06 from a sandbox
that could reach docs sites, GitHub (raw + clone) and search, but **not** the chain RPC and **not**
the block explorer APIs (Blockscout / Robinscan). Items are marked **VERIFIED** (two independent
sources, or the official source of truth) or **NOT VERIFIED**.

The module targets **Pons V2** (the current launchpad). V1 notes are kept in §5 because the
`*-v1.ts` scripts still work against the V1 factory.

## 1. Network

| Item | Value | Status | Source |
|---|---|---|---|
| Chain id (mainnet) | `4663` | VERIFIED | [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting), [add-network-to-wallet](https://docs.robinhood.com/chain/add-network-to-wallet), [chainlist.org/chain/4663](https://chainlist.org/chain/4663) |
| Chain id (testnet) | `46630` | VERIFIED | same |
| Public RPC (rate-limited) | `https://rpc.mainnet.chain.robinhood.com` | VERIFIED | docs.robinhood.com (both pages above) |
| Recommended RPC | `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` (+ `wss://`) | VERIFIED | docs.robinhood.com/chain/connecting |
| Testnet RPC | `https://rpc.testnet.chain.robinhood.com` | VERIFIED | docs.robinhood.com |
| Sequencer endpoint | `https://sequencer.mainnet.chain.robinhood.com`; feed `wss://feed.mainnet.chain.robinhood.com` | VERIFIED (docs only) | docs.robinhood.com/chain/connecting |
| Currency | ETH (18 dec) | VERIFIED | docs.robinhood.com |
| Explorer (official) | `https://robinhoodchain.blockscout.com` (Blockscout) | VERIFIED | docs.robinhood.com; Uniswap deployment file links to a Blockscout instance |
| Explorer (third party) | `https://robinscan.io` | VERIFIED (exists, lists stock tokens) | [robinscan.io/stocks](https://robinscan.io/stocks) |
| Testnet explorer | `https://explorer.testnet.chain.robinhood.com` | VERIFIED | docs.robinhood.com |
| Stack | Arbitrum (Nitro) L2 on Ethereum, launched July 2026 | VERIFIED | docs.robinhood.com/chain/connecting, robinhood.com support article |

Explorer API: Blockscout exposes `/api?module=contract&action=getabi&address=…` and
`/api/v2/smart-contracts/{address}` — **could not be called from this sandbox** (egress denied), so
no ABI was fetched from the explorer.

## 2. Core token / DEX addresses (mainnet 4663)

| Contract | Address | Status | Sources |
|---|---|---|---|
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | VERIFIED | [docs.robinhood.com/chain/contracts](https://docs.robinhood.com/chain/contracts), [Uniswap deployments/4663.md](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) (WETH9 constructor arg), [docs.ponsfamily.com](https://docs.ponsfamily.com/) |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | VERIFIED (docs) | docs.robinhood.com/chain/contracts |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | VERIFIED | Uniswap deployments/4663.md, docs.ponsfamily.com, Mobula almanac |
| NonfungiblePositionManager (V3) | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | VERIFIED | Uniswap deployments/4663.md, docs.ponsfamily.com |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` | VERIFIED | Uniswap deployments/4663.md, docs.ponsfamily.com |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| UniswapInterfaceMulticall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| UniversalRouter | `0x7332D11BD10d18A04B119Cd4671a96f3148002c4` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| Uniswap **V4** PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| Uniswap **V4** PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| Uniswap V4 StateView / V4Quoter | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` / `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | VERIFIED (Uniswap file) | Uniswap deployments/4663.md |
| V3 pool init code hash | `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` (canonical) | VERIFIED | Uniswap deployments/4663.md |

## 3. Stock Tokens

| Token | Address | Status | Sources |
|---|---|---|---|
| AMZN ("Amazon • Robinhood Token") | `0x12f190a9f9d7d37a250758b26824b97ce941bf54` | VERIFIED | [robinscan.io/stocks](https://robinscan.io/stocks), [opensea.io/token/robinhood/0x12f1…bf54](https://opensea.io/token/robinhood/0x12f190a9f9d7d37a250758b26824b97ce941bf54) |
| AAPL / MSFT / NVDA / TSLA / GOOGL | `0xaf3d…93f9` / `0xe932…2e74` / `0xd060…9eec` / `0x322f…3b2d` / `0x2e08…4fe3` | robinscan only | robinscan.io/stocks |

Decimals: assumed 18 (task statement); `pool.ts` reads `decimals()` live. **NOT VERIFIED**: whether
Stock Tokens carry transfer restrictions that could make V3 LP minting revert.

## 4. Pons V2 (current launchpad — used by `launch.ts`, `status.ts`, `claim.ts`)

### 4.1 Addresses (chain 4663)

All from the "Deployed addresses" table on [docs.ponsfamily.com/v2](https://docs.ponsfamily.com/v2)
(also at `/docs/v2`). Independent confirmations noted per row.

| Contract | Address | Status | Extra source |
|---|---|---|---|
| `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | VERIFIED | official repo README "Deployed factories"; Bitquery/Coinmonks article |
| `PonsV2MemeHook` | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | VERIFIED | Bitquery/Coinmonks article |
| Fee Escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | docs only (`launch.ts`/`claim.ts` cross-check `factory.feeEscrow()` live) | — |
| `PonsV2BuybackVault` | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | docs only (`launch.ts` cross-checks `factory.buybackVault()`) | — |
| `PonsV2LaunchLocker` | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | VERIFIED | Bitquery/Coinmonks article; `factory.locker()` cross-checked live |
| `PonsV2LaunchAndBuy` (router) | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | address VERIFIED (docs + Bitquery); **ABI NOT VERIFIED** | — |
| `PonsV2LaunchDeployer` | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | docs only | — |
| Graduation Executor / Guard | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` / `0xf5695117b99B6f6401e67d4195BD653628176C6C` | docs only | — |

### 4.2 Source & ABI status

* Official source: `github.com/ponsdotdev/ponsfamily` `contractsV2/src/v2/` (commit `845bd54`, 2026-08-27):
  `PonsV2LaunchFactory.sol`, `PonsV2BondingCurve.sol`, `PonsV2LauncherToken.sol`, `PonsV2LaunchDeployer.sol`,
  `PonsV2LaunchLocker.sol`, `PonsV2BuybackVault.sol`, `hooks/PonsV2MemeHook.sol`, `interfaces/ILaunchpadV2*.sol`,
  libraries. README: "both factories are verified on chain".
* **No compiled V2 ABI is published** (the repo's `abi.json` is V1 only) and the V2 tree is a **version mix**:
  the factory source references `PonsV2BondingCurve.exemptFromSnipeTax`, `TokenParams.salt` and
  `PonsV2LaunchDeployer.predictLaunchAddresses`, none of which exist in the vendored curve/deployer. So it
  cannot be compiled to a bytecode-exact ABI. The factory source is the newest piece and matches the docs'
  function list exactly.
* `abi/pons_v2_*.json` are therefore **hand-derived from the factory/hook/vault/locker/escrow source + docs**
  (generated from `lib/abis_v2.ts` by `npm run abis`). Status per file: **NOT VERIFIED against explorer bytecode**.
  Mitigation built into the scripts: before any live send they fetch the target's bytecode and check the
  4-byte selector of the function they are about to call is present (`launchToken`, `buy`, `sweepFees`,
  `claim`/`claimToken`, `launchAndBuy`), and abort otherwise.
* `abi/pons_v2_fee_escrow.json` = the official `IPonsV2FeeEscrow` interface (source + docs) — event names docs-only.
* `abi/pons_v2_launch_and_buy.json` = **docs-only** signature; no source anywhere public.
* `currentSnipeTaxBps(address)` on the curve = docs-only (deployed curve is newer than the vendored source).
* Audits: docs say "No audit has closed. Treat v2 as unaudited" (SB Security, Dingbats, Pashov in progress).

### 4.3 Launch (verified against `PonsV2LaunchFactory.sol`)

```solidity
struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }
struct TokenParams {
  string name; string symbol; string logo; string description; Socials socials;
  address creatorFeeRecipient;   // 0 → launcher
  uint16  creatorTaxBps;         // <= maxCreatorTaxBps() (source ceiling 1000 = 10%), 100% to the creator
  bool    buybackEnabled;        // creator can toggle later via setBuybackEnabled
  bytes32 expectedEconomics;     // 0 = no pin; else must equal previewLaunchEconomics(configId, pairToken)
  bytes32 salt;                  // CREATE2 salt, namespaced per launcher
}
struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }

function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve);                 // 0xf35abbcf
function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address, address); // 0xa72101af
event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold);
```

Rules enforced on-chain: `canLaunch(sender)`; **`msg.value == launchFee()` exactly** (V2, unlike V1, refuses
extra value — the dev buy is a separate `curve.buy` or the Launch-and-Buy router); `creatorTaxBps <=
maxCreatorTaxBps`; `curveFeeBps + creatorTaxBps <= 2000` and `hookFeeBps + creatorTaxBps <= 2000`; ERC-20
`pairToken` must be `approvedPairTokens` (then `phantomQuote`/`threshold` come from `pairTokenEconomics`);
metadata caps name 64 / symbol 16 / logo 512 / description 2048 / social 256 chars; the launcher and the
creator fee recipient are exempted from the snipe tax; up to 32 extra exemptions.

Launch fee: **not stated as a number for V2** — read `launchFee()` live (scripts do). Offline dry runs fall
back to the V1 figure 0.0005 ETH and say so.

Launch configs: `launchConfigCount()` + `getLaunchConfig(i)` (append-only list). Which id is "the" public
preset and its `supply / curveFeeBps / phantomQuote / graduationThreshold`: **NOT VERIFIED** (need RPC);
`launch.ts` lists them and picks the first enabled one unless `--launch-config` is given.

### 4.4 Curve economics (verified: `PonsV2BondingCurve.sol`, `PonsV2BondingCurveMath.sol`)

* Constant product over `(phantomQuote + trackedQuote − pendingFees, trackedTokens)`; `phantomQuote` is virtual.
* `reservedTokens = supply × phantomQuote / (phantomQuote + threshold)` are never sold; the curve completes
  exactly when `realQuoteReserve == graduationThreshold`. Opening price `phantomQuote / supply`.
* Buy: `fee = spent×feeBps/1e4`, `tax = spent×creatorTaxBps/1e4`, `tokensOut = getAmountOut(spent−fee−tax)`;
  the last buy is clamped to the sellable allocation and the excess refunded. Sells are closed once ready to graduate.
* Snipe tax (docs; not in vendored source): 99% → 0 exponentially over the first **5 s** (source default field says
  15 s, factory owner-settable; scripts read `snipeTaxSeconds()`), buys only, buyer nets ≥ 1%.
* Fee split at sweep: `protocol = fee×protocolFeeShareBps/1e4`; `bucket = fee − protocol`;
  `buyback = buybackEnabled ? bucket×buybackBurnBps/1e4 : 0` (swapped for the token and locked in the vault, 5-year
  linear vest); `creator = bucket − buyback + creatorTax`. All credited to the Fee Escrow. Numbers of
  `protocolFeeShareBps / buybackBurnBps / hookFeeBps`: **NOT VERIFIED** (read live from `memeHook.currentFeePolicy()`;
  snapshotted per launch in `factory.getLaunchFeePolicy(token)`).

### 4.5 Graduation & Uniswap V4 (verified: factory source + docs)

`buy` calls `factory.graduate(token)` when `sellableTokens()==0` (failure is swallowed → `AutoGraduationFailed`,
anyone can call `graduate` then `createGraduatedPool(token)`). The pool key is
`(currency0, currency1 sorted asc — native ETH = address(0) first, fee 0, tickSpacing from the launch record,
hooks = meme hook)`; `poolId = keccak256(abi.encode(key))`. The full-range position NFT goes to
`PonsV2LaunchLocker` (no withdrawal path). The hook's `afterSwap` charges `hookFeeBps` + creator tax, accrues in
`pendingFees/pendingCreatorTax(poolId, currency)` and `sweepPoolFees` pays the Fee Escrow.

### 4.6 Claiming (verified: `IPonsV2FeeEscrow` + docs)

`claim()` / `claim(uint256)` for native ETH, `claimToken(address)` / `claimToken(address,uint256)` for ERC-20 pairs;
balances via `balanceOf(recipient)` / `balanceOfToken(recipient, token)`. Balances are **per recipient
address**, pooled across all their launches. Unswept curve fees need `curve.sweepFees(0)` first (creator may
call it unless a buyback swap is pending → sweep operator only).

## 5. Pons V1 (legacy — `launch-v1.ts`, `claim-v1.ts`, `status-v1.ts`)

| Item | Value | Status |
|---|---|---|
| Active factory `PonsLaunchFactory` | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | VERIFIED (docs + repo `contract-meta.json` + source header) |
| Active locker | `0x736D76699C26D0d966744cAe304C000d471f7F35` | address VERIFIED; **claim ABI NOT VERIFIED** (`abi/pons_v1_locker.json` partial) |
| Legacy factory / locker | `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` / `0x31ca5E101941A93A7DD6d0497928700625CF54B5` | docs |
| ABI | `abi/pons_v1_factory.json` verbatim from the official repo `abi.json` | VERIFIED (official), not explorer-checked |
| Launch | `launchToken((name,symbol,logo,description,socials,feeWallet), launchConfigId, dexId, salt) payable`, `msg.value >= 0.0005 ETH` (excess = dev buy), token address must end in `0xbbbb` (salt precomputed via `predictVanityTokenAddress`), one-sided full-supply Uniswap V3 position locked in the locker, 70/30 creator/protocol LP fees | VERIFIED (source) |

## 6. Sources consulted

* https://docs.ponsfamily.com/v2 , https://docs.ponsfamily.com/docs/v2 , https://docs.ponsfamily.com/ , https://docs.ponsfamily.com/docs
* https://github.com/ponsdotdev/ponsfamily (cloned; `abi.json`, `contract-meta.json`, `contractsV1/`, `contractsV2/`)
* https://medium.com/coinmonks/pons-api-on-robinhood-chain-how-to-track-the-pons-launchpad-on-chain-91b91e6b6a4b (Bitquery; V2 addresses)
* https://docs.mobula.io/almanac/robinhood-launchpads/pons (V1)
* https://docs.robinhood.com/chain/connecting , /add-network-to-wallet , /contracts
* https://github.com/Uniswap/contracts/blob/main/deployments/4663.md
* https://robinscan.io/stocks , https://opensea.io/token/robinhood/0x12f190a9f9d7d37a250758b26824b97ce941bf54
* Blocked from the sandbox: robinhoodchain.blockscout.com (all API paths), robinscan.io API, rpc.mainnet.chain.robinhood.com
