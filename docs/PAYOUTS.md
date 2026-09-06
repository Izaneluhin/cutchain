# Weekly payout runbook

For the operator. One round per week. Payouts go out Sunday 20:00 UTC (rule 6 on the site), so
everything below the "Publish" heading is done by that hour.

Contracts: `contracts/src/CutPool.sol` (fee splitter) and `contracts/src/MerkleDistributor.sol` (rounds).
Tool: `contracts/tooling/build_round.py`. Commands are the ones in `contracts/deploy.md` section 7.

## Shell setup

Run from the repository root with `contracts/.env` loaded.

```bash
set -a; source contracts/.env; set +a        # RPC_URL, PRIVATE_KEY (distributor owner), CHAIN_ID
export CUTPOOL=0x...                          # from the deploy
export DISTRIBUTOR=0x...
export CUT_TOKEN=0x...                        # CUT (the Pons V2 launch token)
export ROUND=202637                           # ISO week YYYYWW, used as roundId on-chain
export TOKEN=CUT_TOKEN                       # payout token; 0x0000000000000000000000000000000000000000 for an ETH round
cast chain-id --rpc-url $RPC_URL              # expect 4663
```

`PRIVATE_KEY` must be the distributor owner (`cast call $DISTRIBUTOR "owner()(address)" --rpc-url $RPC_URL`).
`setRound` and `sweep` are owner-only. Everything else is permissionless.

The `mint/` scripts read `mint/.env`, but an exported `PRIVATE_KEY` in the shell takes precedence over it.
If the distributor owner and the Pons creator fee recipient are different wallets, run step 2 (a) in a
shell where `contracts/.env` is not sourced.

## Timeline

| When (UTC) | Step |
|---|---|
| Sunday, before 20:00 | 1. Export views. 2. Fund the distributor. 3. Build the round. 4. Review. |
| Sunday 20:00 | 5. Publish the round file. 6. `setRound`. 7. Announce. |
| Until `claimDeadline` | Clippers claim. |
| After `claimDeadline` | 8. `sweep` the unclaimed remainder into the next round. |

## 1. Export views

Produce `rounds/views_$ROUND.csv` with exactly these columns:

```csv
address,handle,views
0x70997970C51812dc3A010C7d01b50e0d17dc79C8,@clipper_one,120000
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,@clipper_two,45000
```

| Column | Meaning |
|---|---|
| `address` | the wallet the account registered on cutchain.live (Robinhood Chain) |
| `handle` | the X handle, informational |
| `views` | the account's counted views for the week, integer (`120,000` and `120_000` are accepted) |

How `views` is computed, per the rules on the site:

- Only clips with the `CUT` watermark bottom right from second 3, no other logos.
- Only clips with at least 10,000 views in X analytics. Read the numbers from X analytics, not from screenshots.
- Drop clips whose caption reads like an ad or names the ticker.
- Sum the remaining clips per account, then apply the per-account weekly cap.
- Only registered, verified accounts. One wallet per account.

Tool behaviour to know: duplicate addresses are merged (views summed, a warning is printed), rows with
`views = 0` are excluded from the tree and listed under `excluded`, the CSV must have a header.
Keep the CSV; it is published with the round so anyone can rebuild the root.

## 2. Fund the distributor

The distributor only accepts a round if it already holds `total` of the payout token on top of what
older open rounds still owe (`reserved[token]`). Move this week's budget in first.

Mode A (dev wallet is the Pons creator fee recipient, the deployed configuration unless `CLAIM_TARGET` was set):

```bash
# (a) claim creator fees from the Pons V2 Fee Escrow to the dev wallet (mint/, sender = creator fee recipient)
node bin/cutchain.js claim --token CUT_TOKEN --sweep --dry-run     # read the balance and the simulation first
node bin/cutchain.js claim --token CUT_TOKEN --sweep

# fees arrive as ETH (native pair). If the round pays CUT, swap the clipper share to CUT from the dev wallet,
# then send the budget to CutPool:
cast send CUTPOOL --value <wei> --private-key $PRIVATE_KEY --rpc-url $RPC_URL             # ETH
cast send CUT_TOKEN "transfer(address,uint256)" CUTPOOL <amount> --private-key $PRIVATE_KEY --rpc-url $RPC_URL   # CUT

# (b) split everything in CutPool between dev / distributor / team (anyone can call)
cast send CUTPOOL "unwrapWETH(address)" $WETH --private-key $PRIVATE_KEY --rpc-url $RPC_URL   # only if WETH arrived
cast send CUTPOOL "distribute()"                --private-key $PRIVATE_KEY --rpc-url $RPC_URL   # ETH balance
cast send CUTPOOL "distributeToken(address)" CUT_TOKEN --private-key $PRIVATE_KEY --rpc-url $RPC_URL   # CUT balance
```

Mode B (CutPool is the creator fee recipient; `CLAIM_TARGET`/`CLAIM_SELECTOR` set at deploy) replaces (a) with:

```bash
cast send CUTPOOL "claim(bytes)" $(cast calldata "<claim signature from the verified fee contract>" <args>) \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

`contracts/README.md` ("Known unknowns") describes mode B against the Pons V1 locker. Before using it with the
V2 Fee Escrow, read the escrow's verified source on Blockscout and confirm the claim function pays `msg.sender`.

Then read what the distributor can assign to a new round:

```bash
TOTAL=$(cast call $DISTRIBUTOR "available(address)(uint256)" $TOKEN --rpc-url $RPC_URL | cut -d' ' -f1)
echo $TOTAL
```

`available(token)` is `balance - reserved[token]`. Funds of open rounds are never counted twice.

## 3. Build the round

```bash
node bin/cutchain.js round rounds/views_$ROUND.csv $ROUND --total $TOTAL --token $TOKEN
# same as:
# python3 contracts/tooling/build_round.py --csv rounds/views_$ROUND.csv --total $TOTAL --round $ROUND --token $TOKEN --out rounds/round_$ROUND.json
```

For an ETH round omit `--token`. The tool writes `rounds/round_$ROUND.json`, self-verifies every proof, and
prints the table and a ready `setRound` line.

## 4. Review the table

The tool prints:

```
keccak backend : pycryptodome
round          : 202637
token          : 0x...
total          : 5000000000000000000000
total views    : 474999
recipients     : 4 (excluded with 0 views: 1)
merkle root    : 0x0bf0...5037
written        : rounds/round_202637.json

 idx  account                                          views                            amount  handle
   0  0x7099...79C8                                   120000            1263160554022218994145  @clipper_one
```

Check before publishing:

- `recipients` equals the number of accounts you expect to pay. `excluded` lists 0-view rows only.
- `total views` equals the sum of the CSV.
- `total` equals `$TOTAL` and the sum of the `amount` column (the tool asserts this).
- Every `account` is the registered wallet for that `handle`. A typo here pays the wrong address and cannot be undone.
- `merkle root` is non-zero and `round` is the id you have not used before. `setRound` reverts with `RoundAlreadySet` on reuse.

If anything is wrong, fix the CSV and rebuild. Nothing is on-chain yet.

## 5. Publish the round file

1. Commit `rounds/round_$ROUND.json` and `rounds/views_$ROUND.csv` to the repo and push. This is where clippers
   read their `index`, `amount` and `proof` (see `docs/CLIPPERS.md`).
2. The board (`board/`) reads the watch API and the chain and shows every payout with its transaction. Post the
   round id, the root and the distributor address on the board's round table if it is maintained by hand.

## 6. setRound

Pick the claim deadline. `contracts/deploy.md` uses 30 days from now; the contract only requires a timestamp in the future.

```bash
ROOT=$(python3 -c "import json;print(json.load(open('rounds/round_$ROUND.json'))['merkleRoot'])")
DEADLINE=$(( $(date +%s) + 30*86400 ))

cast send $DISTRIBUTOR "setRound(uint256,address,bytes32,uint256,uint64)" \
  $ROUND $TOKEN $ROOT $TOTAL $DEADLINE \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

`setRound` reverts when: the id was used (`RoundAlreadySet`), the root is zero (`EmptyRoot`), the total is
zero (`ZeroTotal`), the deadline is not in the future (`DeadlineInPast`), or `available(token) < total`
(`InsufficientBalance`). It emits `RoundSet(roundId, token, merkleRoot, total, claimDeadline)`.

Confirm:

```bash
cast call $DISTRIBUTOR "round(uint256)((address,uint64,bool,bytes32,uint256,uint256))" $ROUND --rpc-url $RPC_URL
# token, claimDeadline, swept, merkleRoot, total, unclaimed
```

## 7. Announce

Post from the project X account, same hour. Template:

```
Round <ROUND> is live.
<recipients> accounts, <total views> counted views, <total> CUT.
Round file: github.com/<org>/cutchain/blob/main/rounds/round_<ROUND>.json
Claim on the distributor: <explorer link>. Claims close <deadline date> UTC.
Next round: Sunday 20:00 UTC.
```

State the per-account cap that was applied. No price talk. No projections of next week's total.

## Claims

Clippers call `claim(roundId, index, account, amount, proof)` with the values from the round file. Anyone can
submit on a clipper's behalf; tokens always go to `account`:

```bash
cast send $DISTRIBUTOR "claim(uint256,uint256,address,uint256,bytes32[])" \
  $ROUND <index> <account> <amount> "[<proof0>,<proof1>,...]" --private-key <any key> --rpc-url $RPC_URL
cast call $DISTRIBUTOR "isClaimed(uint256,uint256)(bool)" $ROUND <index> --rpc-url $RPC_URL
```

A claim whose ETH transfer is rejected by `account` reverts and is not marked claimed.

## 8. Sweep after the window

The rule in the contract: `sweep(roundId, to)` is owner-only, requires `block.timestamp > claimDeadline`, and
runs once per round (`AlreadySwept` afterwards). It moves that round's `unclaimed` remainder to `to` and
releases it from `reserved[token]`.

Sweep to the distributor itself to recycle the remainder into the next round's `available(token)`:

```bash
cast send $DISTRIBUTOR "sweep(uint256,address)" $ROUND $DISTRIBUTOR --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

`sweep` emits `Swept(roundId, token, to, amount)`. Note the amount in the next announcement.

## Funds not assigned to a round

Over-funding or mis-sent tokens can be pulled back with `withdrawUnreserved(token, to, amount)` (owner-only,
limited to `available(token)`). Reserved round funds cannot be touched.

## Checklist

```
[ ] views_<ROUND>.csv exported from X analytics, rules applied, cap applied
[ ] budget in CutPool, distribute()/distributeToken() called
[ ] TOTAL = available(token) read from the chain
[ ] round built, table reviewed, wallets checked against registrations
[ ] round_<ROUND>.json + views_<ROUND>.csv committed and pushed
[ ] setRound sent, RoundSet event on the explorer
[ ] announcement posted with round id, root, deadline, cap
[ ] calendar: sweep after the deadline
```
