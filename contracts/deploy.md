# Deploying cutchain contracts to Robinhood Chain

Step-by-step, copy-paste-able. Everything runs from this folder (`contracts/`).

## 0. Chain details

Taken from the official Robinhood Chain docs on 2026-09-06:

| | Mainnet | Testnet |
|---|---|---|
| Network name | Robinhood Chain | Robinhood Chain Testnet |
| Chain ID | **4663** | **46630** |
| Native currency | ETH | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Alchemy RPC | `https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>` | `https://robinhood-testnet.g.alchemy.com/v2/<API_KEY>` |
| Sequencer feed (WS) | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Explorer (Blockscout) | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Blockscout verifier API | `https://robinhoodchain.blockscout.com/api/` | `https://explorer.testnet.chain.robinhood.com/api/` |
| Stack | Arbitrum (Nitro) L2 settling to Ethereum | same |

Sources:
- https://docs.robinhood.com/chain/connecting (chain IDs, RPC/WS endpoints, explorers)
- https://docs.robinhood.com/chain/deploy-smart-contracts (forge deploy + Blockscout verify commands)

Pons addresses (from https://docs.ponsfamily.com/ and the public `ponsdotdev/ponsfamily` repo README;
**verify on the explorer before relying on them**):

| Contract | Address |
|---|---|
| Pons V1 `PonsLaunchFactory` (active, 70/30 creator/protocol split) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |
| Pons V1 active locker (holds LP NFTs, routes creator fees) | `0x736D76699C26D0d966744cAe304C000d471f7F35` |
| WETH (quote token of every Pons V1 pool) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |

Not verified in this environment: the Robinhood Chain ArbOS version (which decides whether
`evm_version = "cancun"` is safe). `foundry.toml` uses `shanghai`, which every Nitro chain
since ArbOS 11 supports. If `cast call` on a freshly deployed contract reverts with an invalid
opcode, that is the thing to check.

## 1. Prerequisites

```bash
# Foundry (forge, cast, anvil)
curl -L https://foundry.paradigm.xyz | bash && foundryup
# forge-std (pinned; the repo ships remappings.txt already)
cd contracts
forge install foundry-rs/forge-std@v1.9.7 --no-commit
# Python 3.11+ for tooling/build_round.py (no mandatory deps; optional: pip install pycryptodome)
python3 --version
```

Alternative Foundry install when the installer domain is blocked (this is what was used to run the
tests here): `npm i -g @foundry-rs/forge @foundry-rs/cast @foundry-rs/anvil`.

## 2. Wallet + funds

1. Add Robinhood Chain to your wallet with the table above (or via https://docs.robinhood.com/chain/add-network-to-wallet).
2. Bridge a little ETH for gas (canonical Arbitrum bridge, see the "Bridging" page of the docs).
3. Create a **throwaway deployer key**; put it in `.env` as `PRIVATE_KEY`. Never commit `.env`.

```bash
cp .env.example .env
# edit .env: RPC_URL, PRIVATE_KEY, DEV, TEAM, BPS_*, (CLIPPER_POOL), (CLAIM_TARGET + CLAIM_SELECTOR)
set -a; source .env; set +a
cast chain-id --rpc-url $RPC_URL           # expect 4663 (mainnet) or 46630 (testnet)
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
```

## 3. Test locally

```bash
forge build
forge test -vv
```

Optional full dress rehearsal on a local chain:

```bash
anvil &                                          # prints funded keys
PRIVATE_KEY=<anvil key 0> DEV=0x... TEAM=0x... BPS_DEV=3000 BPS_CLIPPER=5000 BPS_TEAM=2000 \
  forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
```

## 4. Deploy (testnet first, then mainnet)

Mode A (dev wallet is the Pons creator, forwards our share manually) — leave `CLAIM_TARGET` and
`CLAIM_SELECTOR` empty:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify --verifier blockscout --verifier-url $VERIFIER_URL
```

Mode B (CutPool is the registered creator / fee wallet) — first read the locker's claim function
from its verified source on the explorer, then:

```bash
export CLAIM_TARGET=0x736D76699C26D0d966744cAe304C000d471f7F35
export CLAIM_SELECTOR=$(cast sig "<exact signature from the verified locker>")00000000000000000000000000000000000000000000000000000000
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast \
  --verify --verifier blockscout --verifier-url $VERIFIER_URL
```

The script prints both addresses and writes `broadcast/Deploy.s.sol/<chainId>/run-latest.json`.
Record `CUTPOOL=` and `DISTRIBUTOR=` in your shell for the commands below.

If inline verification fails, verify afterwards:

```bash
forge verify-contract $DISTRIBUTOR src/MerkleDistributor.sol:MerkleDistributor \
  --chain-id $CHAIN_ID --rpc-url $RPC_URL --verifier blockscout --verifier-url $VERIFIER_URL \
  --constructor-args $(cast abi-encode "constructor(address)" $DISTRIBUTOR_OWNER)

forge verify-contract CUTPOOL src/CutPool.sol:CutPool \
  --chain-id $CHAIN_ID --rpc-url $RPC_URL --verifier blockscout --verifier-url $VERIFIER_URL \
  --constructor-args $(cast abi-encode "constructor(address[],uint16[],address,bytes4)" \
      "[$DEV,$DISTRIBUTOR,$TEAM]" "[$BPS_DEV,$BPS_CLIPPER,$BPS_TEAM]" \
      ${CLAIM_TARGET:-0x0000000000000000000000000000000000000000} ${CLAIM_SELECTOR:-0x00000000})
```

## 5. Post-deploy sanity checks

```bash
cast call CUTPOOL "split()(address[],uint16[])" --rpc-url $RPC_URL
cast call CUTPOOL "claimTarget()(address)" --rpc-url $RPC_URL
cast call CUTPOOL "previewSplit(uint256)(uint256[])" 1000000000000000000 --rpc-url $RPC_URL
cast call $DISTRIBUTOR "owner()(address)" --rpc-url $RPC_URL
```

## 6. Point Pons creator fees at CutPool (mode B)

- **At launch**: `PonsLaunchFactory.launchToken` takes `TokenParams.feeWallet`; pass `CUTPOOL`.
  The factory then calls `locker.setFeeRedirect(token, feeWallet)` so the locker pays creator
  fees to CutPool. Check it: `cast call $PONS_V1_LOCKER "feeRedirects(address)(address)" CUT_TOKEN`.
- **After launch**: the locker exposes `setFeeRedirect(address token, address newFeeWallet)`.
  Whether the *creator* (not only the factory) may call it must be confirmed from the verified
  locker source. If the creator may, run it from the creator wallet with `CUTPOOL`.

## 7. Weekly operations

```bash
# (a) pull creator fees into CutPool
#   mode A: from the Pons UI claim to the dev wallet, then forward our share:
cast send CUTPOOL --value <wei> --private-key $PRIVATE_KEY --rpc-url $RPC_URL
#   mode B: anyone triggers the locker claim through CutPool:
cast send CUTPOOL "claim(bytes)" $(cast calldata "<locker claim signature>" <args>) --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# (b) unwrap WETH (if fees arrived as WETH) and split everything
cast send CUTPOOL "unwrapWETH(address)" $WETH --private-key $PRIVATE_KEY --rpc-url $RPC_URL
cast send CUTPOOL "distribute()"                --private-key $PRIVATE_KEY --rpc-url $RPC_URL
cast send CUTPOOL "distributeToken(address)" CUT_TOKEN --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# (c) build the round from the weekly views export
TOTAL=$(cast call $DISTRIBUTOR "available(address)(uint256)" 0x0000000000000000000000000000000000000000 --rpc-url $RPC_URL | cut -d' ' -f1)
python3 tooling/build_round.py --csv views.csv --total $TOTAL --round 202637

# (d) publish the round (ETH round shown; use the token address for token rounds)
cast send $DISTRIBUTOR "setRound(uint256,address,bytes32,uint256,uint64)" \
  202637 0x0000000000000000000000000000000000000000 <merkleRoot from round_202637.json> $TOTAL $(( $(date +%s) + 30*86400 )) \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# (e) clippers (or anyone on their behalf) claim
cast send $DISTRIBUTOR "claim(uint256,uint256,address,uint256,bytes32[])" \
  202637 <index> <account> <amount> "[<proof0>,<proof1>,...]" --private-key <any key> --rpc-url $RPC_URL

# (f) after the deadline, recycle what was not claimed (to the distributor itself = next round)
cast send $DISTRIBUTOR "sweep(uint256,address)" 202637 $DISTRIBUTOR --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

Publish `round_<n>.json` (or a per-address lookup built from it) so clippers can find their
`index`, `amount` and `proof`.
