# Clippers

How to get paid for clips on the CUT network. These are the rules published on
[cutchain.live](https://cutchain.live), with the claim procedure added.

## The rules

| # | Rule | Detail |
|---|---|---|
| 1 | Watermark from second three | `CUT` bottom right, visible from second 3 of the clip. Never on the first frame. X uses the first frame as the poster, so a clip with the tag on frame one does not count. 1080p. No other logos. |
| 2 | Real views only | A clip counts from 10,000 views. There is a cap per account per week. Views are read from X analytics, not from screenshots. |
| 3 | One wallet per account | Register once. The wallet is on Robinhood Chain and it is the only place the payout goes. One account per wallet. |
| 4 | Verified accounts first | The first weeks pay the network's own accounts and clippers verified by hand. After that registration is open to anyone who clears the view minimum. |
| 5 | No shilling in the caption | The clip is the product. The ticker lives in the watermark, not in the text. Captions that read like ads are excluded from the week. |
| 6 | Sunday 20:00 UTC | Views are counted, the table is published, and payouts go out the same hour. |

Any Twitch or Kick stream, any editing tool. Your account, your caption, your audience.

## What disqualifies a clip

A clip is left out of the week when any of these is true:

- The watermark is missing, is not bottom right, or appears before second 3 (on the first frame).
- The clip carries another logo.
- The clip has fewer than 10,000 views in X analytics when views are counted.
- The views cannot be read from X analytics. Screenshots are not accepted.
- The caption reads like an ad or names the ticker in the text.
- The account is not registered, or the clip was posted from a different account than the registered one.
- The views were bought, or the account is a compilation channel.

Views above the weekly per-account cap are not counted. They do not disqualify the account.

## Register

Use the form in the "For clippers" section of [cutchain.live](https://cutchain.live).

| Field | Value |
|---|---|
| X handle | the account that posts the clips, e.g. `@yourclips` |
| Wallet on Robinhood Chain | a `0x` address you control (40 hex characters). Payouts go here and nowhere else. |
| Streams you clip | optional, e.g. `clavicular, adinross, jynxzi` |

Every account is checked by hand and confirmed before its first payout. One account per wallet, one wallet per account.

## How a round works

1. Every Sunday the operator exports the views of every watermarked clip per registered account into a CSV (`address,handle,views`).
2. `contracts/tooling/build_round.py` splits the week's budget across accounts in proportion to views and builds a Merkle tree. Your amount is `floor(total * yourViews / totalViews)`; the last row in the file absorbs the rounding remainder.
3. The result is `rounds/round_<roundId>.json`, published in this repo together with the input CSV. The round id is the ISO week, for example `202637`.
4. The operator calls `MerkleDistributor.setRound(roundId, token, merkleRoot, total, claimDeadline)`. The contract must already hold `total` of the payout token for that call to succeed, so a published round is always funded.
5. You claim. Claims are accepted until `claimDeadline` (inclusive). After the deadline the operator may sweep what was not claimed into the next round.

The round file looks like this (from `rounds/round_example.json`):

```json
{
  "round": 202637,
  "token": "0x000000000000000000000000000000000000BbBB",
  "total": "5000000000000000000000",
  "merkleRoot": "0x0bf0...5037",
  "claims": [
    {
      "index": 0,
      "account": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "handle": "@clipper_one",
      "views": 120000,
      "amount": "1263160554022218994145",
      "proof": ["0xa832...91e5", "0x1be0...911c"]
    }
  ]
}
```

`token` is the payout token address. `null` means native ETH. Amounts are in the token's smallest unit (wei; Pons tokens have 18 decimals).

## Claim

Find your entry in `rounds/round_<roundId>.json` by your wallet address, then call `claim` on the MerkleDistributor with the five values from the file.

```
claim(uint256 roundId, uint256 index, address account, uint256 amount, bytes32[] proof)
```

With Foundry's `cast`:

```bash
RPC_URL=https://rpc.mainnet.chain.robinhood.com
DISTRIBUTOR=0x...   # published at launch and on the board

cast send $DISTRIBUTOR "claim(uint256,uint256,address,uint256,bytes32[])" \
  <roundId> <index> <account> <amount> "[<proof0>,<proof1>,...]" \
  --private-key <your key> --rpc-url $RPC_URL
```

Facts about `claim`:

- Anyone can submit the transaction. The tokens always go to `account`, the wallet in the round file.
- One claim per entry. A second claim reverts with `AlreadyClaimed`.
- A wrong `index`, `account`, `amount` or `proof` reverts with `InvalidProof`. Copy the values exactly.
- Claims revert with `RoundClosed` after `claimDeadline`.
- The sender pays the gas in ETH on Robinhood Chain.

Check whether an entry was already claimed:

```bash
cast call $DISTRIBUTOR "isClaimed(uint256,uint256)(bool)" <roundId> <index> --rpc-url $RPC_URL
```

The distributor's source is verified on Blockscout at deploy time (`contracts/deploy.md`), so the same call can be made with a wallet from `https://robinhoodchain.blockscout.com/address/<DISTRIBUTOR>`.

## Verify a round yourself

The root is reproducible. With the published CSV and the values in the round file:

```bash
python3 contracts/tooling/build_round.py --csv rounds/views_<roundId>.csv \
  --total <total from the round file> --round <roundId> --token <token> --out /tmp/check.json
```

The printed `merkle root` must equal `merkleRoot` in the published file and the root stored on-chain:

```bash
cast call $DISTRIBUTOR "round(uint256)((address,uint64,bool,bytes32,uint256,uint256))" <roundId> --rpc-url $RPC_URL
```

The struct fields are `token, claimDeadline, swept, merkleRoot, total, unclaimed`.

## Where things are

| Item | Location |
|---|---|
| Rules and registration form | https://cutchain.live |
| Round files | `rounds/` in this repo |
| Round file format | `rounds/README.md` |
| Distributor contract | `contracts/src/MerkleDistributor.sol` |
| Round tool | `contracts/tooling/build_round.py` |
| Explorer | https://robinhoodchain.blockscout.com |
