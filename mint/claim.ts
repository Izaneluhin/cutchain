#!/usr/bin/env tsx
/**
 * claim.ts — withdraw accrued creator fees from the Pons V2 Fee Escrow.
 *
 *   tsx claim.ts --token 0x… [--sweep] [--amount 0.1] [--from 0x…] [--force] [--dry-run]
 *
 * Fees are not pushed to the creator: every curve trade (and, after graduation, every hooked V4 swap)
 * accrues quote-denominated fees that a sweep credits to the Fee Escrow under the creator fee
 * recipient's address. The recipient withdraws with `claim()` (native ETH) or `claimToken(pairToken)`.
 *
 * Safety: the escrow ABI is the official IPonsV2FeeEscrow interface, but it was not fetched from the
 * explorer, so before a live send the script (1) checks the claim selector exists in the escrow bytecode,
 * (2) requires the simulation to succeed, and (3) requires a non-zero claimable balance.
 *
 * --sweep first calls curve.sweepFees(0) (allowed for the creator recipient when no buyback swap is
 * pending) so unswept curve fees land in the escrow before the claim.
 */
import { formatEther, parseEther, type Address } from "viem";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import { ADDRESSES, PLACEHOLDER_SENDER, ZERO_ADDRESS, explorer, getPublicClient, getWalletClient, hr, isAddress, probeRpc, requireAddress, shortError } from "./lib/config.js";
import { erc20Abi } from "./lib/abis.js";
import { V2_SIGNATURES, ponsV2CurveAbi, ponsV2FactoryAbi, ponsV2FeeEscrowAbi } from "./lib/abis_v2.js";
import { BPS } from "./lib/curve.js";
import { selectorPresentInCode } from "./lib/locker.js";
import { describeRevert, planAndMaybeSend, tryRead } from "./lib/tx.js";

const HELP = `
claim.ts — claim creator fees from the Pons V2 Fee Escrow (${ADDRESSES.PONS_V2_FEE_ESCROW})

  --token <0x>     launch token (used to find the pair asset and the creator fee recipient)
  --sweep          call curve.sweepFees(0) first to move unswept curve fees into the escrow
  --amount <dec>   partial claim (default: full balance via claim() / claimToken(token))
  --from <0x>      simulation sender when PRIVATE_KEY is absent
  --force          send even if the selector is not found in the escrow bytecode
  --dry-run        print calldata + simulate, send nothing
`;

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const dryRun = has(args, "dry-run");
  const force = has(args, "force");
  const token = requireAddress(req(args, "token"), "--token");

  const client = getPublicClient();
  const walletInfo = getWalletClient();
  const fromArg = opt(args, "from");
  const from: Address = walletInfo?.address ?? (isAddress(fromArg) ? fromArg : PLACEHOLDER_SENDER);
  if (!dryRun && !walletInfo) throw new Error("PRIVATE_KEY is required unless --dry-run");
  const ctx = { client, rpcOnline: false, dryRun, from, wallet: walletInfo?.wallet };

  hr(`Pons V2 fee claim ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  const chainId = await probeRpc(client);
  const online = chainId !== null;
  ctx.rpcOnline = online;
  console.log(`rpc      : ${online ? `online (chain ${chainId})` : "OFFLINE — calldata only"}`);
  console.log(`token    : ${token}  ${explorer.token(token)}`);
  console.log(`sender   : ${from}${walletInfo ? "" : "  (no PRIVATE_KEY — placeholder / --from)"}`);
  console.log(`escrow   : ${ADDRESSES.PONS_V2_FEE_ESCROW}  ${explorer.address(ADDRESSES.PONS_V2_FEE_ESCROW)}`);

  let pairToken: Address = ZERO_ADDRESS;
  let curve: Address | undefined;
  let creatorFeeRecipient: Address | undefined;
  let balance: bigint | undefined;
  let escrowCode: `0x${string}` | undefined;
  let escrow: Address = ADDRESSES.PONS_V2_FEE_ESCROW;

  if (online) {
    hr("Launch record");
    const f = { address: ADDRESSES.PONS_V2_FACTORY, abi: ponsV2FactoryAbi } as const;
    const rec = await tryRead("getLaunchedToken", () => client.readContract({ ...f, functionName: "getLaunchedToken", args: [token] }));
    if (!rec?.exists) {
      console.log("  ! token is not a Pons V2 launch (exists=false)");
    } else {
      pairToken = rec.pairToken;
      curve = rec.curve;
      creatorFeeRecipient = rec.creatorFeeRecipient;
      console.log(`  curve            : ${curve}`);
      console.log(`  pair token       : ${pairToken === ZERO_ADDRESS ? "native ETH" : pairToken}`);
      console.log(`  creator recipient: ${creatorFeeRecipient}${creatorFeeRecipient.toLowerCase() === from.toLowerCase() ? " (= sender ✓)" : "  ! sender is NOT the creator fee recipient — escrow balances are per address, this claim would withdraw the sender's own balance"}`);
      const liveEscrow = await tryRead("factory.feeEscrow", () => client.readContract({ ...f, functionName: "feeEscrow" }));
      if (liveEscrow && liveEscrow.toLowerCase() !== escrow.toLowerCase()) {
        console.log(`  ! factory.feeEscrow() = ${liveEscrow} differs from CHAIN.md; using the live one`);
        escrow = liveEscrow;
      }
    }

    /* ---------------------------------------------------------- */
    /* pending on the curve (unswept)                             */
    /* ---------------------------------------------------------- */
    if (curve) {
      const c = { address: curve, abi: ponsV2CurveAbi } as const;
      const graduated = await tryRead("graduated", () => client.readContract({ ...c, functionName: "graduated" }));
      const feeBal = (await tryRead("quoteFeeBalance", () => client.readContract({ ...c, functionName: "quoteFeeBalance" }))) ?? 0n;
      const taxBal = (await tryRead("creatorTaxBalance", () => client.readContract({ ...c, functionName: "creatorTaxBalance" }))) ?? 0n;
      const bbBal = (await tryRead("buybackQuoteBalance", () => client.readContract({ ...c, functionName: "buybackQuoteBalance" }))) ?? 0n;
      const share = BigInt((await tryRead("protocolFeeShareBps", () => client.readContract({ ...c, functionName: "protocolFeeShareBps" }))) ?? 0);
      const bucket = feeBal - (feeBal * share) / BPS;
      const creatorPending = bucket - (bbBal < bucket ? bbBal : bucket) + taxBal;
      console.log(`  unswept on curve : ${formatEther(feeBal)} fee + ${formatEther(taxBal)} tax → creator ≈ ${formatEther(creatorPending)}${graduated ? " (curve graduated; nothing more accrues here)" : ""}`);
      if (has(args, "sweep") && !graduated && (feeBal > 0n || taxBal > 0n)) {
        if (bbBal > 0n) console.log("  ! a buyback slice is pending: sweepFees requires the protocol's sweep operator (InternalSwapRequiresOperator). Skipping --sweep.");
        else {
          const code = await client.getCode({ address: curve });
          const ok = selectorPresentInCode(code, V2_SIGNATURES.curveSweepFees);
          console.log(`  curve.sweepFees selector ${ok ? "present ✓" : "NOT FOUND ✗"}`);
          if (dryRun || ok || force) {
            await planAndMaybeSend(ctx, { label: "PonsV2BondingCurve.sweepFees(0)", address: curve, abi: ponsV2CurveAbi, functionName: "sweepFees", args: [0n] });
          }
        }
      }
    }

    /* ---------------------------------------------------------- */
    /* escrow balance                                             */
    /* ---------------------------------------------------------- */
    hr("Fee Escrow balance");
    const e = { address: escrow, abi: ponsV2FeeEscrowAbi } as const;
    balance =
      pairToken === ZERO_ADDRESS
        ? await tryRead("balanceOf", () => client.readContract({ ...e, functionName: "balanceOf", args: [from] }))
        : await tryRead("balanceOfToken", () => client.readContract({ ...e, functionName: "balanceOfToken", args: [from, pairToken] }));
    const sym = pairToken === ZERO_ADDRESS ? "ETH" : ((await tryRead("pair.symbol", () => client.readContract({ address: pairToken, abi: erc20Abi, functionName: "symbol" }))) ?? "PAIR");
    console.log(`  claimable by sender: ${balance !== undefined ? `${formatEther(balance)} ${sym}` : "unavailable"}`);
    if (creatorFeeRecipient && creatorFeeRecipient.toLowerCase() !== from.toLowerCase()) {
      const creator = creatorFeeRecipient;
      const cb =
        pairToken === ZERO_ADDRESS
          ? await tryRead("balanceOf(creator)", () => client.readContract({ ...e, functionName: "balanceOf", args: [creator] }))
          : await tryRead("balanceOfToken(creator)", () => client.readContract({ ...e, functionName: "balanceOfToken", args: [creator, pairToken] }));
      console.log(`  claimable by creator recipient: ${cb !== undefined ? `${formatEther(cb)} ${sym}` : "unavailable"}`);
    }
    escrowCode = await client.getCode({ address: escrow });
  } else {
    console.log("\n! offline: assuming a native-ETH launch → claim()");
  }

  /* ------------------------------------------------------------ */
  /* build + guard + send                                         */
  /* ------------------------------------------------------------ */
  hr("Claim");
  const amountArg = opt(args, "amount");
  const amount = amountArg ? parseEther(amountArg) : undefined;
  const isNative = pairToken === ZERO_ADDRESS;
  const sig = isNative ? (amount ? "claim(uint256)" : V2_SIGNATURES.escrowClaim) : amount ? "claimToken(address,uint256)" : V2_SIGNATURES.escrowClaimToken;
  const callArgs = isNative ? (amount ? [amount] : []) : amount ? [pairToken, amount] : [pairToken];
  const present = escrowCode ? selectorPresentInCode(escrowCode, sig) : false;
  console.log(`  function         : ${sig}  ${escrowCode ? (present ? "(selector present in escrow bytecode ✓)" : "(! selector NOT found in escrow bytecode)") : "(bytecode unchecked — offline)"}`);
  if (!dryRun) {
    if (!present && !force) throw new Error(`refusing to send: ${sig} selector not found in the escrow bytecode (pass --force to override)`);
    if (balance === 0n) throw new Error("refusing to send: claimable balance is 0");
  }
  await planAndMaybeSend(ctx, {
    label: `PonsV2FeeEscrow.${sig}`,
    address: escrow,
    abi: ponsV2FeeEscrowAbi,
    functionName: sig.startsWith("claimToken") ? "claimToken" : "claim",
    args: callArgs,
  });
  if (dryRun) {
    hr("Dry run summary");
    console.log("  nothing sent.");
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${describeRevert(err) || shortError(err)}`);
  process.exit(1);
});
