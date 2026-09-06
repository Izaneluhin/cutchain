# Launch day

Checklist for the CUT launch on Robinhood Chain (chain id 4663) through Pons V2. Tick every box in
order. Commands run from the repository root unless a `cd` is shown.

## Decisions, written down before launch

Fill this table and commit it with the launch. The values are read live by `mint/launch.ts`; nothing
here is decided by the code.

| Decision | Value | Where it goes |
|---|---|---|
| Token name / symbol | `____` / `CUT` | `--name --symbol` (max 64 / 16 chars) |
| Creator tax (bps) | `____` | `--creator-tax-bps`; must be `<= factory.maxCreatorTaxBps()` (source ceiling 1000). 100% of it goes to the creator. |
| Buybacks | on / off | `--buybacks`; togglable later by the creator |
| Creator fee recipient | dev wallet (mode A) or CutPool (mode B) | `--creator-fee-recipient` |
| Launch config id | `____` | `--launch-config`; the dry run lists the enabled presets |
| Dev buy | none / `____` ETH | `--dev-buy-eth`, sent as a second tx after the launch |
| CutPool split (bps) | dev `____` / clippers `____` / team `____` | `contracts/.env` `BPS_DEV BPS_CLIPPER BPS_TEAM`, sum 10000, immutable after deploy |
| Distributor owner | `0x____` | `contracts/.env` `DISTRIBUTOR_OWNER` |
| First payout | Sunday `____` 20:00 UTC | announcement, site countdown |
| Per-account weekly cap | `____` views | `docs/PAYOUTS.md` step 1, announcement |

## T-1 day

- [ ] `node bin/cutchain.js doctor` prints OK for python3, node, forge, `mint/node_modules`, and the RPC (chainId 4663).
- [ ] `node bin/cutchain.js test` passes: watch tests, 52 Foundry tests, mint typecheck.
- [ ] Repo is public with the root README, `docs/`, `rounds/README.md`, `LICENSE`. No `.env` committed (`git ls-files | grep -c '\.env$'` prints 0).
- [ ] Site is live at https://cutchain.live with the rules, the form, and the "link at launch" placeholder ready to be replaced by the repo URL.
- [ ] Two X accounts exist and are logged in on the launch machine: the personal account and the project account. Both have header, icon, bio with the site URL.
- [ ] Contracts deployed and verified on Blockscout (`contracts/deploy.md` sections 2 to 5). `CUTPOOL` and `DISTRIBUTOR` addresses written down.
- [ ] `cast call CUTPOOL "split()(address[],uint16[])" --rpc-url $RPC_URL` shows the agreed recipients and bps.
- [ ] `cast call $DISTRIBUTOR "owner()(address)" --rpc-url $RPC_URL` is the owner wallet.
- [ ] Watermark template (`CUT`, bottom right, from second 3, 1080p) sent to every network account with the caption rule: no ticker in the text.
- [ ] Carrier post and the article drafted. Contract-address field left blank.
- [ ] Wallet: launcher key in `mint/.env`, funded with ETH on Robinhood Chain for `launchFee()` + gas + the dev buy.
- [ ] Throwaway launch done earlier (e.g. `CUTTEST`, no dev buy) and `node bin/cutchain.js status --token <test token>` showed a sane curve. `mint/README.md` requires this before the real launch.

## Launch hour

Order matters. Nothing is posted before the transaction is confirmed.

- [ ] Dry run and read every line of the output:

```bash
node bin/cutchain.js launch --name "<name>" --symbol CUT \
  --creator-tax-bps <bps> [--buybacks] \
  --creator-fee-recipient <dev wallet or CUTPOOL> \
  --website https://cutchain.live --twitter <project handle> \
  --image <ipfs://... or https://...> --description "<one line>" \
  [--launch-config <id>] [--dev-buy-eth <eth>] --dry-run
```

  The dry run prints the factory state, the live launch fee, the selected config, the fee split with the live
  policy, the ABI self-check and the simulation. A failed simulation aborts a live send.

- [ ] Live send: same command without `--dry-run`. The script prints the token and curve addresses with explorer links.
- [ ] `node bin/cutchain.js status --token <CUT_TOKEN>` shows the launch record, the phase `NotGraduated`, the creator tax and buybacks you decided.
- [ ] Verify on Blockscout: open `https://robinhoodchain.blockscout.com/address/<CUT_TOKEN>`, check name, symbol, the `TokenLaunched` event, and that the creator fee recipient in the launch record is the intended wallet. The token contract is deployed by Pons; CutPool and MerkleDistributor were verified with `forge verify-contract` in `contracts/deploy.md` section 4.
- [ ] Mode B only: confirm the fee recipient is CutPool in the launch record before the first trade.
- [ ] Post the contract address from the project account, then repost from the personal account. Template:

```
CUT is live on Robinhood Chain.
Contract: 0x<CUT_TOKEN>
Explorer: https://robinhoodchain.blockscout.com/address/0x<CUT_TOKEN>
Code: github.com/<org>/cutchain
Clip, watermark, get paid every Sunday 20:00 UTC by views. Rules: cutchain.live
```

- [ ] "Only this contract" post, both accounts, pinned on the project account:

```
Warning: the only CUT contract is
0x<CUT_TOKEN>
on Robinhood Chain (chain id 4663).
Any other address, chain, or presale is not us. We will never DM you a link.
```

- [ ] Same hour: the first carrier post (a clip with the watermark) from the project account and the article with the contract, the rules, and the repo link. Update the site: replace "link at launch" with the repo URL and the buy link.
- [ ] Send the final watermark template and the contract to the network accounts. They post from their own accounts, no special lane.
- [ ] Start the watcher and the board so the board shows live moments: `node bin/cutchain.js watch --twitch <channels> --kick <slugs>` and `node bin/cutchain.js board`.

## Within 12 hours

- [ ] DexScreener: pay for the token profile and complete verification: header image, icon, website `https://cutchain.live`, both X accounts (project and personal).
- [ ] Check the token page shows the right contract and the right socials, and that the "only this contract" post is still pinned.
- [ ] `node bin/cutchain.js status --token <CUT_TOKEN>` again: curve progress, unswept fees, escrow balance.
- [ ] Read the clipper registrations (the form on the site posts to a Google Apps Script endpoint). Start hand-verifying accounts.

## First payout

- [ ] Announce the date: the first Sunday 20:00 UTC after launch, or the date in the table above. The site countdown points to the next Sunday 20:00 UTC.
- [ ] Follow `docs/PAYOUTS.md` on that day. The first weeks pay the network's own accounts and hand-verified clippers (rule 4).

## What not to promise

The token's trading fees are the only source of payouts. Do not say or imply anything else.

| Do not | Say instead |
|---|---|
| Any price talk, targets, "early", "cheap", "moon" | Nothing. The clip is the product. |
| "Guaranteed payouts", fixed amounts per view, a fixed weekly total | "Paid by views from the token's trading fees. The weekly total depends on volume." |
| A payout to accounts that are not registered or verified | "Register on cutchain.live. Verified accounts first, then open." |
| Payout in anything other than what the round file says | "Paid in CUT on Robinhood Chain, one claim per week." |
| Audited contracts | "Small, tested, open source, unaudited. 52 Foundry tests." |
| Mode B trustlessness before it is deployed and verified | "Mode A: the dev wallet forwards the share. Every distribution is on the explorer." |
| Kick clip creation by the watcher | "The watcher detects Kick moments. Clips on Kick are made by hand." |

The rule from the site applies to the team too: no shilling in captions, the ticker lives in the watermark.
