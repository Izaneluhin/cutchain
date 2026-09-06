#!/usr/bin/env tsx
/**
 * status.ts — read-only view of a Pons V2 launch.
 *
 *   tsx status.ts --token 0x… [--for 0x…]     (--for: whose snipe tax / escrow balance to show; default creator fee recipient)
 *
 * Prints: launch record (curve, phase, fees, pair), curve progress toward graduation (tokens sold vs
 * sellable allocation, quote raised vs threshold), spot price and FDV, snipe-tax status, pending
 * (unswept) fees on the curve and the creator's estimated share, accrued claimable balance in the Fee
 * Escrow, buyback vault vest, and — once graduated — the Uniswap V4 pool id and the hook's pending fees.
 */
import { formatEther, type Address } from "viem";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import { ADDRESSES, ZERO_ADDRESS, explorer, getPublicClient, hr, isAddress, probeRpc, requireAddress, shortError } from "./lib/config.js";
import { erc20Abi } from "./lib/abis.js";
import {
  GRADUATION_PHASE_NAMES,
  GraduationPhase,
  ponsV2BuybackVaultAbi,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  ponsV2FeeEscrowAbi,
  ponsV2HookAbi,
  ponsV2LockerAbi,
  ponsV2TokenAbi,
} from "./lib/abis_v2.js";
import { BPS, quoteBuy, spotPrice, v4PoolId } from "./lib/curve.js";
import { tryRead } from "./lib/tx.js";

const HELP = `
status.ts — Pons V2 token status (read-only)

  --token <0x>   launch token address (required)
  --for <0x>     address to evaluate snipe tax + escrow balance for (default: creator fee recipient)
`;

const pct = (a: bigint, b: bigint) => (b === 0n ? "n/a" : `${((Number(a) / Number(b)) * 100).toFixed(2)}%`);

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const token = requireAddress(req(args, "token"), "--token");

  hr("Pons V2 token status");
  console.log(`token     : ${token}`);
  console.log(`explorer  : ${explorer.token(token)}`);
  console.log(`robinscan : ${explorer.robinscanAddress(token)}`);

  const client = getPublicClient();
  const chainId = await probeRpc(client);
  if (chainId === null) {
    console.log("\nRPC offline — nothing to read. Would query: factory.getLaunchedToken/getLaunchFeePolicy, token metadata, curve reserves/fees/");
    console.log("snipe tax, feeEscrow.balanceOf(creator), buybackVault, and after graduation hook.launches/pendingFees for the V4 pool id.");
    return;
  }

  /* ------------------------------------------------------------ */
  /* launch record                                                */
  /* ------------------------------------------------------------ */
  hr("Launch record (PonsV2LaunchFactory.getLaunchedToken)");
  const f = { address: ADDRESSES.PONS_V2_FACTORY, abi: ponsV2FactoryAbi } as const;
  const rec = await tryRead("getLaunchedToken", () => client.readContract({ ...f, functionName: "getLaunchedToken", args: [token] }));
  if (!rec || !rec.exists) {
    console.log("  not a Pons V2 launch (exists=false). For V1 tokens use status-v1.ts.");
    return;
  }
  const isNative = rec.pairToken === ZERO_ADDRESS;
  const q = isNative ? "ETH" : ((await tryRead("pair.symbol", () => client.readContract({ address: rec.pairToken, abi: erc20Abi, functionName: "symbol" }))) ?? "PAIR");
  console.log(`  curve            : ${rec.curve}  ${explorer.address(rec.curve)}`);
  console.log(`  deployer         : ${rec.deployer}`);
  console.log(`  creator recipient: ${rec.creatorFeeRecipient}`);
  console.log(`  pair token       : ${isNative ? "native ETH" : rec.pairToken}`);
  console.log(`  phase            : ${rec.phase} = ${GRADUATION_PHASE_NAMES[rec.phase] ?? "?"}`);
  console.log(`  creator tax      : ${rec.creatorTaxBps} bps   buybacks: ${rec.buybackEnabled ? "ON" : "off"}`);
  console.log(`  graduation       : ${formatEther(rec.graduationThreshold)} ${q} threshold; V4 pool fee ${rec.poolFee} tickSpacing ${rec.tickSpacing}`);
  const policy = await tryRead("getLaunchFeePolicy", () => client.readContract({ ...f, functionName: "getLaunchFeePolicy", args: [token] }));
  if (policy) {
    console.log(`  fee policy (snap): protocol ${policy.protocolFeeShareBps} bps of fee, buyback ${policy.buybackBurnBps} bps of remainder, hook fee ${policy.hookFeeBps} bps, recipient ${policy.protocolFeeRecipient}`);
  }
  const pending = await tryRead("pendingCreatorFeeRecipient", () => client.readContract({ ...f, functionName: "pendingCreatorFeeRecipient", args: [token] }));
  if (pending && pending[0] !== ZERO_ADDRESS) console.log(`  ! pending creator-recipient override → ${pending[0]} effective ${new Date(Number(pending[1]) * 1000).toISOString()}`);

  /* ------------------------------------------------------------ */
  /* token                                                        */
  /* ------------------------------------------------------------ */
  hr("Token (PonsV2LauncherToken)");
  const t = { address: token, abi: ponsV2TokenAbi } as const;
  const name = await tryRead("name", () => client.readContract({ ...t, functionName: "name" }));
  const symbol = (await tryRead("symbol", () => client.readContract({ ...t, functionName: "symbol" }))) ?? "TOKEN";
  const supply = (await tryRead("totalSupply", () => client.readContract({ ...t, functionName: "totalSupply" }))) ?? 0n;
  const logo = await tryRead("logo", () => client.readContract({ ...t, functionName: "logo" }));
  const description = await tryRead("description", () => client.readContract({ ...t, functionName: "description" }));
  const socials = await tryRead("socials", () => client.readContract({ ...t, functionName: "socials" }));
  console.log(`  name/symbol      : ${name} (${symbol})   supply ${formatEther(supply)}`);
  console.log(`  logo             : ${logo || "(none)"}`);
  console.log(`  description      : ${description || "(none)"}`);
  if (socials) console.log(`  socials          : ${JSON.stringify(socials)}`);

  /* ------------------------------------------------------------ */
  /* curve                                                        */
  /* ------------------------------------------------------------ */
  hr("Bonding curve");
  const c = { address: rec.curve, abi: ponsV2CurveAbi } as const;
  const reserves = await tryRead("getReserves", () => client.readContract({ ...c, functionName: "getReserves" }));
  const reserved = (await tryRead("reservedTokens", () => client.readContract({ ...c, functionName: "reservedTokens" }))) ?? 0n;
  const sellable = (await tryRead("sellableTokens", () => client.readContract({ ...c, functionName: "sellableTokens" }))) ?? 0n;
  const realQuote = (await tryRead("realQuoteReserve", () => client.readContract({ ...c, functionName: "realQuoteReserve" }))) ?? 0n;
  const graduated = await tryRead("graduated", () => client.readContract({ ...c, functionName: "graduated" }));
  const ready = await tryRead("readyToGraduate", () => client.readContract({ ...c, functionName: "readyToGraduate" }));
  const feeBps = (await tryRead("feeBps", () => client.readContract({ ...c, functionName: "feeBps" }))) ?? 0n;
  const taxBps = (await tryRead("creatorTaxBps", () => client.readContract({ ...c, functionName: "creatorTaxBps" }))) ?? 0n;
  const phantom = (await tryRead("phantomQuote", () => client.readContract({ ...c, functionName: "phantomQuote" }))) ?? 0n;
  const quoteFeeBalance = (await tryRead("quoteFeeBalance", () => client.readContract({ ...c, functionName: "quoteFeeBalance" }))) ?? 0n;
  const creatorTaxBalance = (await tryRead("creatorTaxBalance", () => client.readContract({ ...c, functionName: "creatorTaxBalance" }))) ?? 0n;
  const buybackQuoteBalance = (await tryRead("buybackQuoteBalance", () => client.readContract({ ...c, functionName: "buybackQuoteBalance" }))) ?? 0n;
  const protocolShare = BigInt((await tryRead("protocolFeeShareBps", () => client.readContract({ ...c, functionName: "protocolFeeShareBps" }))) ?? 0);
  const forAddr: Address = isAddress(opt(args, "for")) ? (opt(args, "for") as Address) : rec.creatorFeeRecipient;
  const snipe = await tryRead("currentSnipeTaxBps", () => client.readContract({ ...c, functionName: "currentSnipeTaxBps", args: [forAddr] }));

  const sellableAllocation = supply - reserved;
  const sold = sellableAllocation > sellable ? sellableAllocation - sellable : 0n;
  console.log(`  state            : ${graduated ? "GRADUATED (curve closed)" : ready ? "ready to graduate (push with factory.graduate/createGraduatedPool)" : "trading"}`);
  console.log(`  progress (tokens): ${formatEther(sold)} / ${formatEther(sellableAllocation)} ${symbol} sold = ${pct(sold, sellableAllocation)}`);
  console.log(`  progress (quote) : ${formatEther(realQuote)} / ${formatEther(rec.graduationThreshold)} ${q} raised = ${pct(realQuote, rec.graduationThreshold)}`);
  console.log(`  reserved for LP  : ${formatEther(reserved)} ${symbol} (${pct(reserved, supply)} of supply)`);
  if (reserves) {
    const [qr, tr] = reserves;
    const price = spotPrice(qr, tr);
    console.log(`  reserves         : quote ${formatEther(qr)} ${q} (incl. phantom ${formatEther(phantom)}) / tokens ${formatEther(tr)} ${symbol}`);
    console.log(`  spot price       : ${price.toExponential(6)} ${q} per ${symbol}   |   ${(1 / price).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol} per ${q}`);
    console.log(`  FDV              : ${((price * Number(supply)) / 1e18).toFixed(6)} ${q}`);
    const oneEth = 10n ** 18n;
    const qb = quoteBuy({ quoteReserve: qr, tokenReserve: tr, reservedTokens: reserved, feeBps, creatorTaxBps: taxBps, snipeTaxBps: snipe ?? 0n }, oneEth);
    console.log(`  1 ${q} buys       : ≈ ${formatEther(qb.tokensOut)} ${symbol} after ${feeBps} bps fee + ${taxBps} bps creator tax${qb.snipe ? ` + ${formatEther(qb.snipe)} ${q} snipe tax (for ${forAddr})` : ""}${qb.clamped ? " — would complete the curve (partial fill + refund)" : ""}`);
  }
  console.log(`  snipe tax now    : ${snipe === undefined ? "unavailable" : `${snipe} bps for ${forAddr}${snipe === 0n ? " (exempt or window over)" : ""}`}`);
  const pendingProtocol = (quoteFeeBalance * protocolShare) / BPS;
  const pendingBucket = quoteFeeBalance - pendingProtocol;
  const pendingBuyback = buybackQuoteBalance < pendingBucket ? buybackQuoteBalance : pendingBucket;
  const pendingCreator = pendingBucket - pendingBuyback + creatorTaxBalance;
  console.log(`  unswept fees     : base ${formatEther(quoteFeeBalance)} + creator tax ${formatEther(creatorTaxBalance)} ${q} → on sweep: protocol ${formatEther(pendingProtocol)}, buyback ${formatEther(pendingBuyback)}, creator ${formatEther(pendingCreator)} ${q}`);

  /* ------------------------------------------------------------ */
  /* fee escrow + buyback vault                                   */
  /* ------------------------------------------------------------ */
  hr("Fee Escrow (claimable now) & Buyback Vault");
  const escrow = ADDRESSES.PONS_V2_FEE_ESCROW;
  for (const who of [...new Set([rec.creatorFeeRecipient, forAddr])]) {
    const bal = isNative
      ? await tryRead("escrow.balanceOf", () => client.readContract({ address: escrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [who] }))
      : await tryRead("escrow.balanceOfToken", () => client.readContract({ address: escrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOfToken", args: [who, rec.pairToken] }));
    console.log(`  claimable by ${who}: ${bal !== undefined ? `${formatEther(bal)} ${q}` : "unavailable"}${who.toLowerCase() === rec.creatorFeeRecipient.toLowerCase() ? " (creator fee recipient — all their launches combined)" : ""}`);
  }
  const vault = { address: ADDRESSES.PONS_V2_BUYBACK_VAULT, abi: ponsV2BuybackVaultAbi } as const;
  const locked = await tryRead("vault.totalLocked", () => client.readContract({ ...vault, functionName: "totalLocked", args: [token] }));
  const releasable = await tryRead("vault.releasable", () => client.readContract({ ...vault, functionName: "releasable", args: [token] }));
  const released = await tryRead("vault.totalReleased", () => client.readContract({ ...vault, functionName: "totalReleased", args: [token] }));
  console.log(`  buyback vault    : locked ${locked !== undefined ? formatEther(locked) : "?"} ${symbol}, released ${released !== undefined ? formatEther(released) : "?"}, releasable now ${releasable !== undefined ? formatEther(releasable) : "?"} (5-year linear vest)`);

  /* ------------------------------------------------------------ */
  /* graduated pool                                               */
  /* ------------------------------------------------------------ */
  const poolId = v4PoolId(token, rec.pairToken, rec.tickSpacing, ADDRESSES.PONS_V2_MEME_HOOK, 0);
  hr("Uniswap V4 pool (meme hook)");
  console.log(`  pool id          : ${poolId}  (currency0/1 sorted, fee 0, tickSpacing ${rec.tickSpacing}, hooks ${ADDRESSES.PONS_V2_MEME_HOOK})`);
  if (rec.phase === GraduationPhase.PoolCreated) {
    const h = { address: ADDRESSES.PONS_V2_MEME_HOOK, abi: ponsV2HookAbi } as const;
    const info = await tryRead("hook.launches", () => client.readContract({ ...h, functionName: "launches", args: [poolId] }));
    if (info) {
      console.log(`  registered       : ${info[0]}   memecoin is currency0: ${info[1]}   creator ${info[4]}   hook fee ${info[10]} bps + creator tax ${info[7]} bps   buybacks ${info[12] ? "ON" : "off"}`);
    }
    const pq = await tryRead("hook.pendingFees(quote)", () => client.readContract({ ...h, functionName: "pendingFees", args: [poolId, rec.pairToken] }));
    const pt = await tryRead("hook.pendingFees(token)", () => client.readContract({ ...h, functionName: "pendingFees", args: [poolId, token] }));
    const tq = await tryRead("hook.pendingCreatorTax(quote)", () => client.readContract({ ...h, functionName: "pendingCreatorTax", args: [poolId, rec.pairToken] }));
    const tt = await tryRead("hook.pendingCreatorTax(token)", () => client.readContract({ ...h, functionName: "pendingCreatorTax", args: [poolId, token] }));
    console.log(`  unswept hook fees: base ${formatEther(pq ?? 0n)} ${q} + ${formatEther(pt ?? 0n)} ${symbol}; creator tax ${formatEther(tq ?? 0n)} ${q} + ${formatEther(tt ?? 0n)} ${symbol} (token side is converted to ${q} at sweep)`);
    const lockedPos = await tryRead("locker.isLocked", () => client.readContract({ address: ADDRESSES.PONS_V2_LAUNCH_LOCKER, abi: ponsV2LockerAbi, functionName: "isLocked", args: [token] }));
    console.log(`  LP locked        : ${lockedPos} (PonsV2LaunchLocker, permanent)`);
  } else if (rec.phase === GraduationPhase.Swept) {
    console.log(`  swept ${formatEther(rec.sweptQuote)} ${q} + ${formatEther(rec.sweptTokens)} ${symbol} at ${new Date(Number(rec.sweptAt) * 1000).toISOString()} — pool not created yet: anyone can call factory.createGraduatedPool(token)`);
  } else {
    console.log("  not graduated yet");
  }
  console.log();
}

main().catch((err) => {
  console.error(`\nERROR: ${shortError(err)}`);
  process.exit(1);
});
