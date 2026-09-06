# rounds/

One file per weekly payout round, produced by `contracts/tooling/build_round.py`
(`node bin/cutchain.js round <views.csv> <roundId> --total <wei> [--token 0x…]` writes here by
default). Clippers read their `index`, `amount` and `proof` from these files to call
`MerkleDistributor.claim`. Operators follow `docs/PAYOUTS.md`; clippers follow `docs/CLIPPERS.md`.

| File | Content |
|---|---|
| `round_<roundId>.json` | the published round: root, total, one entry per paid address |
| `views_<roundId>.csv` | the input the round was built from (`address,handle,views`), so anyone can rebuild the root |
| `round_example.json` | example only, a copy of `contracts/test/fixtures/round_example.json`, built from `contracts/tooling/views.example.csv` with `--total 5e21 --round 202637 --token 0x000000000000000000000000000000000000BbBB`. Not a real payout. |

Round ids are the ISO week, `YYYYWW` (the example uses `202637`). The id in the file name is the
`roundId` passed to `setRound` on-chain.

## File format

```json
{
  "round": 202637,
  "token": "0x000000000000000000000000000000000000BbBB",
  "total": "5000000000000000000000",
  "totalViews": 474999,
  "recipients": 4,
  "merkleRoot": "0x0bf055b218d9175a89c7279a6490e674e35e1126040530ea5f4d24b206245037",
  "leafEncoding": "keccak256(bytes.concat(keccak256(abi.encode(uint256 roundId, uint256 index, address account, uint256 amount))))",
  "pairHashing": "keccak256(min(a,b) ‖ max(a,b)); odd node carried up unchanged",
  "claims": [
    {
      "index": 0,
      "account": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "handle": "@clipper_one",
      "views": 120000,
      "amount": "1263160554022218994145",
      "proof": [
        "0xa832345cd0304b0cec763204b9c25189ecd30a9b2f8de2bffd39b386e90091e5",
        "0x1be02b6ed2bc91a673f5b8c01fb0573cf80f0651144dec0649d755dfeac5911c"
      ]
    }
  ],
  "excluded": [
    { "account": "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", "handle": "@clipper_five", "views": 0 }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `round` | integer | `roundId` on-chain |
| `token` | address or `null` | payout token; `null` means native ETH (`address(0)` in `setRound`) |
| `total` | string, wei | sum of all `amount` values; the `total` passed to `setRound` |
| `totalViews` | integer | sum of `views` over paid rows |
| `recipients` | integer | number of entries in `claims` |
| `merkleRoot` | bytes32 | the root passed to `setRound` |
| `leafEncoding`, `pairHashing` | string | the hashing rules, identical to `MerkleDistributor.sol` |
| `claims[].index` | integer | leaf index, the `index` argument of `claim` and of `isClaimed` |
| `claims[].account` | address | the wallet paid; checksummed |
| `claims[].handle` | string | X handle(s); duplicates of one address are merged with `,` |
| `claims[].views` | integer | counted views for the week |
| `claims[].amount` | string, wei | `floor(total * views / totalViews)`; the last paid row absorbs the remainder |
| `claims[].proof` | bytes32[] | Merkle proof for `claim` |
| `excluded[]` | list | rows with 0 views, not in the tree |

Amounts are strings because they exceed the safe integer range of JSON parsers.

## Claim from a round file

```bash
cast send $DISTRIBUTOR "claim(uint256,uint256,address,uint256,bytes32[])" \
  <round> <index> <account> <amount> "[<proof0>,<proof1>,...]" \
  --private-key <any key> --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Anyone can submit the claim; the tokens go to `account`. Claims are accepted until the round's
`claimDeadline` (inclusive), read with
`cast call $DISTRIBUTOR "round(uint256)((address,uint64,bool,bytes32,uint256,uint256))" <round>`.

## Rebuild the root

```bash
python3 contracts/tooling/build_round.py --csv rounds/views_<round>.csv --total <total> --round <round> \
  [--token <token>] --out /tmp/check.json
```

The printed `merkle root` must match the file and the on-chain round. `contracts/test` loads
`round_example.json` and asserts that Solidity rebuilds the same root and every proof.
