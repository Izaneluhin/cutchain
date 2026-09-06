#!/usr/bin/env tsx
/**
 * launch.ts — launch a token on Pons V2 (bonding curve → Uniswap V4) on Robinhood Chain.
 *
 *   tsx launch.ts --name CutTest --symbol CUTT [--image ipfs://…] [--description "…"]
 *                 [--twitter URL] [--telegram URL] [--discord URL] [--website URL] [--farcaster URL]
 *                 [--creator-fee-recipient 0x…]  where creator fees accrue (default: sender)
 *                 [--creator-tax-bps 0]          extra trade tax paid 100% to the creator (capped by factory.maxCreatorTaxBps)
 *                 [--buybacks]                   route the creator's buyback slice into buy-back-and-lock (5y vest)
 *                 [--dev-buy-eth 0.01]           first buy by the launcher (snipe-tax exempt), sent as a 2nd tx after the launch
 *                 [--atomic]                     do the dev buy atomically via the Launch-and-Buy router (ABI UNVERIFIED, docs only)
 *                 [--launch-config N]            factory preset id (default: first enabled)
 *                 [--pair-token 0x…]             quote asset (default: native ETH = 0x0; ERC-20s must be factory-approved)
 *                 [--exempt 0x…,0x…]             extra snipe-tax-exempt wallets (max 32)
 *                 [--salt 0x…]                   CREATE2 salt (default random; namespaced per launcher)
 *                 [--no-pin]                     do not pin the launch economics (expectedEconomics = 0)
 *                 [--slippage-bps 100] [--from 0x…] [--force] [--dry-run]
 *
 * What one `launchToken` call does on-chain (verified against contractsV2/src/v2/PonsV2LaunchFactory.sol):
 *   1. requires canLaunch(sender) (launchEnabled || whitelisted) and msg.value == launchFee() EXACTLY
 *   2. requires creatorTaxBps <= maxCreatorTaxBps, pairToken approved (if not ETH), config enabled,
 *      expectedEconomics == previewLaunchEconomics(...) when non-zero
 *   3. PonsV2LaunchDeployer deploys the bonding curve and the token (CREATE2 with your salt);
 *      the ENTIRE supply mints to the curve; curve.initialize fixes reservedTokens = supply*phantom/(phantom+threshold)
 *   4. the launcher and the creator fee recipient are exempted from the snipe tax (+ your --exempt list)
 *   5. the launch record + fee-policy snapshot are stored, the launch fee goes to the protocol recipient
 *   6. TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)
 *   Trading opens immediately on the curve. The buy that exhausts the sellable allocation auto-graduates:
 *   reserves sweep to the factory, a full-range Uniswap V4 position (fee 0 + meme hook) is minted and
 *   locked forever in the Launch Locker. Anyone can call factory.createGraduatedPool(token) to retry.
 */
import { formatEther, formatUnits, parseEther, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import {
  ADDRESSES,
  LAUNCH_FEE_DOCS,
  PLACEHOLDER_SENDER,
  V2_MAX_CREATOR_TAX_CEILING_BPS,
  V2_MAX_SNIPE_TAX_EXEMPTIONS,
  V2_MAX_TOTAL_TRADE_FEE_BPS,
  V2_METADATA_LIMITS,
  ZERO_ADDRESS,
  explorer,
  getPublicClient,
  getWalletClient,
  hr,
  isAddress,
  probeRpc,
  requireAddress,
  shortError,
} from "./lib/config.js";
import { erc20Abi } from "./lib/abis.js";
import { V2_SIGNATURES, ponsV2CurveAbi, ponsV2FactoryAbi, ponsV2HookAbi, ponsV2LaunchAndBuyAbi } from "./lib/abis_v2.js";
import { BPS, launchEconomics, quoteBuy, v4PoolId } from "./lib/curve.js";
import { selectorPresentInCode } from "./lib/locker.js";
import { describeRevert, planAndMaybeSend, tryRead } from "./lib/tx.js";

const HELP = `
launch.ts — Pons V2 launch (factory ${ADDRESSES.PONS_V2_FACTORY})

  --name --symbol                 required (max ${V2_METADATA_LIMITS.name}/${V2_METADATA_LIMITS.symbol} chars)
  --image --description           on-chain metadata (max ${V2_METADATA_LIMITS.logo}/${V2_METADATA_LIMITS.description} chars)
  --twitter --telegram --discord --website --farcaster
  --creator-fee-recipient <0x>    default sender
  --creator-tax-bps <n>           default 0; refused above factory.maxCreatorTaxBps (source ceiling ${V2_MAX_CREATOR_TAX_CEILING_BPS})
  --buybacks                      enable buy-back-and-lock of the creator's buyback slice
  --dev-buy-eth <eth>             launcher's first buy, sent right after the launch (exempt from snipe tax)
  --atomic                        use PonsV2LaunchAndBuy for the dev buy (docs-only ABI, UNVERIFIED)
  --launch-config <n>             default: first enabled config
  --pair-token <0x>               default native ETH (0x0)
  --exempt <0x,0x>                extra snipe-tax exemptions (max ${V2_MAX_SNIPE_TAX_EXEMPTIONS})
  --salt <0x32bytes>              default random
  --no-pin                        skip previewLaunchEconomics pin
  --slippage-bps <n>              dev-buy minTokensOut tolerance (default 100)
  --from <0x>  --force  --dry-run
`;

interface LaunchConfig {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}
interface FeePolicy {
  protocolFeeRecipient: Address;
  protocolFeeShareBps: number;
  buybackBurnBps: number;
  hookFeeBps: number;
  maxInternalPriceImpactBps: number;
}

function checkLen(label: string, v: string, max: number) {
  if (v.length > max) throw new Error(`${label} is ${v.length} chars; PonsV2LaunchDeployer caps it at ${max}`);
}

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const dryRun = has(args, "dry-run");
  const force = has(args, "force");

  /* ------------------------------------------------------------ */
  /* params                                                       */
  /* ------------------------------------------------------------ */
  const name = req(args, "name");
  const symbol = req(args, "symbol");
  const socials = {
    twitter: opt(args, "twitter", "")!,
    telegram: opt(args, "telegram", "")!,
    discord: opt(args, "discord", "")!,
    website: opt(args, "website", "")!,
    farcaster: opt(args, "farcaster", "")!,
  };
  const logo = opt(args, "image", "")!;
  const description = opt(args, "description", "")!;
  checkLen("--name", name, V2_METADATA_LIMITS.name);
  checkLen("--symbol", symbol, V2_METADATA_LIMITS.symbol);
  checkLen("--image", logo, V2_METADATA_LIMITS.logo);
  checkLen("--description", description, V2_METADATA_LIMITS.description);
  for (const [k, v] of Object.entries(socials)) checkLen(`--${k}`, v, V2_METADATA_LIMITS.social);

  const creatorTaxBps = BigInt(opt(args, "creator-tax-bps", "0")!);
  if (creatorTaxBps < 0n || creatorTaxBps > V2_MAX_CREATOR_TAX_CEILING_BPS) {
    throw new Error(`--creator-tax-bps must be 0..${V2_MAX_CREATOR_TAX_CEILING_BPS} (source ceiling MAX_CREATOR_TAX_CEILING_BPS)`);
  }
  const buybackEnabled = has(args, "buybacks");
  const devBuy = parseEther(opt(args, "dev-buy-eth", "0")!);
  const atomic = has(args, "atomic");
  const slippageBps = BigInt(opt(args, "slippage-bps", "100")!);
  const pairToken: Address = requireAddress(opt(args, "pair-token", ZERO_ADDRESS), "--pair-token");
  const isNative = pairToken === ZERO_ADDRESS;
  const exemptions = (opt(args, "exempt", "") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => requireAddress(s, "--exempt entry"));
  if (exemptions.length > V2_MAX_SNIPE_TAX_EXEMPTIONS) throw new Error(`--exempt allows at most ${V2_MAX_SNIPE_TAX_EXEMPTIONS} addresses`);
  let salt: Hex = (opt(args, "salt") as Hex | undefined) ?? toHex(randomBytes(32));
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("--salt must be 32 bytes hex");

  const client = getPublicClient();
  const walletInfo = getWalletClient();
  const fromArg = opt(args, "from");
  const from: Address = walletInfo?.address ?? (isAddress(fromArg) ? fromArg : PLACEHOLDER_SENDER);
  if (!dryRun && !walletInfo) throw new Error("PRIVATE_KEY is required unless --dry-run");
  const creatorFeeRecipient: Address = requireAddress(opt(args, "creator-fee-recipient", from), "--creator-fee-recipient");

  hr(`Pons V2 launch ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`token    : ${name} (${symbol})   logo: ${logo || "(none)"}`);
  console.log(`factory  : ${ADDRESSES.PONS_V2_FACTORY}  ${explorer.address(ADDRESSES.PONS_V2_FACTORY)}`);
  console.log(`sender   : ${from}${walletInfo ? "" : "  (no PRIVATE_KEY — placeholder / --from)"}`);
  console.log(`creator  : fee recipient ${creatorFeeRecipient}, creator tax ${creatorTaxBps} bps (${Number(creatorTaxBps) / 100}%), buybacks ${buybackEnabled ? "ON" : "off"}`);
  console.log(`pair     : ${isNative ? "native ETH" : pairToken}`);
  const chainId = await probeRpc(client);
  const online = chainId !== null;
  console.log(`rpc      : ${online ? `online (chain ${chainId})` : "OFFLINE — calldata only"}`);

  /* ------------------------------------------------------------ */
  /* factory state                                                */
  /* ------------------------------------------------------------ */
  let launchFee = LAUNCH_FEE_DOCS;
  let launchConfigId = BigInt(opt(args, "launch-config", "0")!);
  let config: LaunchConfig | undefined;
  let policy: FeePolicy | undefined;
  let expectedEconomics: Hex = `0x${"0".repeat(64)}`;
  let factoryCode: Hex | undefined;
  let phantomQuote = 0n;
  let graduationThreshold = 0n;
  const f = { address: ADDRESSES.PONS_V2_FACTORY, abi: ponsV2FactoryAbi } as const;

  if (online) {
    hr("Factory state");
    const liveFee = await tryRead("launchFee", () => client.readContract({ ...f, functionName: "launchFee" }));
    if (liveFee !== undefined) launchFee = liveFee;
    const can = await tryRead("canLaunch", () => client.readContract({ ...f, functionName: "canLaunch", args: [from] }));
    const maxTax = await tryRead("maxCreatorTaxBps", () => client.readContract({ ...f, functionName: "maxCreatorTaxBps" }));
    const snipeStart = await tryRead("snipeTaxStartBps", () => client.readContract({ ...f, functionName: "snipeTaxStartBps" }));
    const snipeSecs = await tryRead("snipeTaxSeconds", () => client.readContract({ ...f, functionName: "snipeTaxSeconds" }));
    const feeEscrow = await tryRead("feeEscrow", () => client.readContract({ ...f, functionName: "feeEscrow" }));
    const memeHook = await tryRead("memeHook", () => client.readContract({ ...f, functionName: "memeHook" }));
    const locker = await tryRead("locker", () => client.readContract({ ...f, functionName: "locker" }));
    const deployer = await tryRead("launchDeployer", () => client.readContract({ ...f, functionName: "launchDeployer" }));
    console.log(`  launchFee          : ${formatEther(launchFee)} ETH ${liveFee === undefined ? "(V1 docs value — live read failed!)" : "(live)"}`);
    console.log(`  canLaunch(sender)  : ${can}`);
    console.log(`  maxCreatorTaxBps   : ${maxTax}   snipe tax: ${snipeStart} bps decaying over ${snipeSecs} s`);
    const same = (a?: Address, b?: Address) => a && b && a.toLowerCase() === b.toLowerCase();
    console.log(`  feeEscrow          : ${feeEscrow}${same(feeEscrow, ADDRESSES.PONS_V2_FEE_ESCROW) ? " ✓ matches CHAIN.md" : " ! differs from CHAIN.md"}`);
    console.log(`  memeHook           : ${memeHook}${same(memeHook, ADDRESSES.PONS_V2_MEME_HOOK) ? " ✓" : " ! differs from CHAIN.md"}`);
    console.log(`  locker             : ${locker}${same(locker, ADDRESSES.PONS_V2_LAUNCH_LOCKER) ? " ✓" : " ! differs from CHAIN.md"}`);
    console.log(`  launchDeployer     : ${deployer}${deployer === ZERO_ADDRESS ? " ! not set → launches revert" : ""}`);
    if (can === false) console.log("  ! canLaunch(sender) is false → launchToken reverts NotWhitelisted()");
    if (maxTax !== undefined && creatorTaxBps > maxTax) {
      throw new Error(`--creator-tax-bps ${creatorTaxBps} exceeds the live factory maximum ${maxTax}`);
    }
    if (!isNative) {
      const approved = await tryRead("approvedPairTokens", () => client.readContract({ ...f, functionName: "approvedPairTokens", args: [pairToken] }));
      console.log(`  pair token approved: ${approved}`);
      if (approved === false) console.log("  ! pair token is not approved → PairTokenNotApproved()");
      const econ = await tryRead("pairTokenEconomics", () => client.readContract({ ...f, functionName: "pairTokenEconomics", args: [pairToken] }));
      if (econ) [phantomQuote, graduationThreshold] = [econ[0], econ[1]];
    }

    const count = Number((await tryRead("launchConfigCount", () => client.readContract({ ...f, functionName: "launchConfigCount" }))) ?? 0n);
    const configs: LaunchConfig[] = [];
    for (let i = 0; i < count; i++) {
      const c = (await client.readContract({ ...f, functionName: "getLaunchConfig", args: [BigInt(i)] })) as LaunchConfig;
      configs.push(c);
      console.log(
        `  launchConfig[${i}]    : supply=${formatEther(c.supply)} curveFee=${c.curveFeeBps}bps phantomQuote=${formatEther(c.phantomQuote)} threshold=${formatEther(c.graduationThreshold)} poolFee=${c.poolFee} tickSpacing=${c.tickSpacing} enabled=${c.enabled}`,
      );
    }
    if (!args.values.has("launch-config") && configs.length) {
      const idx = configs.findIndex((c) => c.enabled);
      launchConfigId = BigInt(Math.max(0, idx));
    }
    config = configs[Number(launchConfigId)];
    console.log(`  selected           : launchConfigId=${launchConfigId}${config && !config.enabled ? "  ! disabled" : ""}`);
    if (config && isNative) [phantomQuote, graduationThreshold] = [config.phantomQuote, config.graduationThreshold];

    const hookAddr = memeHook ?? ADDRESSES.PONS_V2_MEME_HOOK;
    const pol = await tryRead("hook.currentFeePolicy", () => client.readContract({ address: hookAddr, abi: ponsV2HookAbi, functionName: "currentFeePolicy" }));
    if (pol) policy = pol as FeePolicy;

    if (!has(args, "no-pin")) {
      const pin = await tryRead("previewLaunchEconomics", () =>
        client.readContract({ ...f, functionName: "previewLaunchEconomics", args: [launchConfigId, pairToken] }),
      );
      if (pin) {
        expectedEconomics = pin;
        console.log(`  economics pin      : ${pin}`);
      }
    }
    factoryCode = await client.getCode({ address: ADDRESSES.PONS_V2_FACTORY });
  } else {
    console.log(`\n! offline: launchConfigId=${launchConfigId} (UNVERIFIED default), launch fee ${formatEther(launchFee)} ETH (V1 docs value; V2 reads launchFee() live), no economics pin`);
  }

  /* ------------------------------------------------------------ */
  /* economics + fee model                                        */
  /* ------------------------------------------------------------ */
  if (config && phantomQuote && graduationThreshold) {
    hr("Curve economics (from the selected config)");
    const e = launchEconomics(config.supply, phantomQuote, graduationThreshold);
    const q = isNative ? "ETH" : "PAIR";
    console.log(`  supply             : ${formatEther(e.supply)} ${symbol} (100% minted to the curve)`);
    console.log(`  sellable on curve  : ${formatEther(e.sellableTokens)} ${symbol} (${((Number(e.sellableTokens) / Number(e.supply)) * 100).toFixed(2)}%)`);
    console.log(`  reserved for V4 LP : ${formatEther(e.reservedTokens)} ${symbol} (${((Number(e.reservedTokens) / Number(e.supply)) * 100).toFixed(2)}%)`);
    console.log(`  opening price      : ${e.openingPrice.toExponential(4)} ${q}/${symbol}  (FDV ${formatEther(phantomQuote)} ${q})`);
    console.log(`  graduation         : after ${formatEther(graduationThreshold)} ${q} raised → price ${e.graduationPrice.toExponential(4)} ${q}/${symbol}, FDV ≈ ${(e.graduationFdvWei / 1e18).toFixed(4)} ${q}`);
  }
  hr("Fee model for this launch");
  const curveFee = config?.curveFeeBps ?? 0n;
  console.log(`  per trade (quote leg): base fee ${curveFee} bps${config ? "" : " (unknown offline)"} + creator tax ${creatorTaxBps} bps  = ${curveFee + creatorTaxBps} bps${curveFee + creatorTaxBps > V2_MAX_TOTAL_TRADE_FEE_BPS ? "  ! exceeds 2000 bps → CombinedFeeTooHigh" : ""}`);
  if (policy) {
    const protocolShare = BigInt(policy.protocolFeeShareBps);
    const buyback = buybackEnabled ? BigInt(policy.buybackBurnBps) : 0n;
    const ex = parseEther("1");
    const fee = (ex * curveFee) / BPS;
    const tax = (ex * creatorTaxBps) / BPS;
    const protocolAmt = (fee * protocolShare) / BPS;
    const bucket = fee - protocolAmt;
    const buybackAmt = (bucket * buyback) / BPS;
    const creatorAmt = bucket - buybackAmt + tax;
    console.log(`  split of base fee    : protocol ${policy.protocolFeeShareBps} bps of fee → then ${buybackEnabled ? `${policy.buybackBurnBps} bps of the remainder bought back & locked (5y vest)` : "no buyback (disabled)"} → rest to creator`);
    console.log(`  creator tax          : 100% to the creator, on top`);
    console.log(`  post-graduation      : Uniswap V4 pool fee 0; meme hook charges ${policy.hookFeeBps} bps + creator tax, same split, accrues in the Fee Escrow`);
    console.log(`  example 1 ETH buy    : fee ${formatEther(fee)} + tax ${formatEther(tax)} → protocol ${formatEther(protocolAmt)}, buyback ${formatEther(buybackAmt)}, creator ${formatEther(creatorAmt)} ETH`);
  } else {
    console.log("  split                : protocol share / buyback slice / creator remainder — read from memeHook.currentFeePolicy() when online");
  }
  console.log(`  snipe tax            : 99% of a buy decaying to 0 over the first seconds (docs: 5 s); launcher + creator recipient exempt; buyer nets ≥ 1%`);

  /* ------------------------------------------------------------ */
  /* build launch tx                                              */
  /* ------------------------------------------------------------ */
  const params = { name, symbol, logo, description, socials, creatorFeeRecipient, creatorTaxBps: Number(creatorTaxBps), buybackEnabled, expectedEconomics, salt };
  const ctx = { client, rpcOnline: online, dryRun, from, wallet: walletInfo?.wallet };

  hr("ABI self-check");
  const launchSig = exemptions.length ? V2_SIGNATURES.launchTokenWithExemptions : V2_SIGNATURES.launchToken;
  let selectorOk = false;
  if (factoryCode) {
    selectorOk = selectorPresentInCode(factoryCode, launchSig);
    console.log(`  factory bytecode ${factoryCode.length / 2 - 1} bytes; ${launchSig.split("(")[0]} selector ${selectorOk ? "PRESENT ✓" : "NOT FOUND ✗"}`);
    for (const s of [V2_SIGNATURES.previewLaunchEconomics, "launchFee()", "maxCreatorTaxBps()", "canLaunch(address)"]) {
      console.log(`  ${s.padEnd(40)} ${selectorPresentInCode(factoryCode, s) ? "present" : "MISSING"}`);
    }
  } else {
    console.log("  skipped (offline) — hand-derived ABI, see CHAIN.md");
  }
  if (!dryRun && !selectorOk && !force) {
    throw new Error("refusing to send: launchToken selector not found in the deployed factory bytecode (ABI mismatch?). Use --force to override.");
  }

  let launchResult;
  if (atomic && devBuy > 0n) {
    // Docs-only router. value = launchFee + quoteIn for native launches.
    const routerCode = online ? await client.getCode({ address: ADDRESSES.PONS_V2_LAUNCH_AND_BUY }) : undefined;
    const ok = routerCode ? selectorPresentInCode(routerCode, V2_SIGNATURES.launchAndBuy) : false;
    console.log(`  router bytecode: launchAndBuy selector ${routerCode ? (ok ? "PRESENT ✓" : "NOT FOUND ✗") : "unchecked (offline)"}`);
    if (!dryRun && !ok && !force) throw new Error("refusing to send: launchAndBuy selector not found in the router bytecode");
    let minTokensOut = 0n;
    if (config && phantomQuote) {
      const q = quoteBuy({ quoteReserve: phantomQuote, tokenReserve: config.supply, reservedTokens: launchEconomics(config.supply, phantomQuote, graduationThreshold).reservedTokens, feeBps: config.curveFeeBps, creatorTaxBps }, devBuy);
      minTokensOut = (q.tokensOut * (BPS - slippageBps)) / BPS;
      console.log(`  dev buy quote: ${formatEther(devBuy)} ETH → ≈ ${formatEther(q.tokensOut)} ${symbol} (fee ${formatEther(q.fee)}, tax ${formatEther(q.tax)}); minTokensOut ${formatEther(minTokensOut)}`);
    }
    launchResult = await planAndMaybeSend(ctx, {
      label: "PonsV2LaunchAndBuy.launchAndBuy(params, launchConfigId, pairToken, quoteIn, minTokensOut, recipient, exemptions) [UNVERIFIED ABI]",
      address: ADDRESSES.PONS_V2_LAUNCH_AND_BUY,
      abi: ponsV2LaunchAndBuyAbi,
      functionName: "launchAndBuy",
      args: [params, launchConfigId, pairToken, devBuy, minTokensOut, from, exemptions],
      value: launchFee + (isNative ? devBuy : 0n),
    });
  } else {
    launchResult = await planAndMaybeSend(ctx, {
      label: `PonsV2LaunchFactory.launchToken(params, launchConfigId, pairToken${exemptions.length ? ", snipeTaxExemptions" : ""})`,
      address: ADDRESSES.PONS_V2_FACTORY,
      abi: ponsV2FactoryAbi,
      functionName: "launchToken",
      args: exemptions.length ? [params, launchConfigId, pairToken, exemptions] : [params, launchConfigId, pairToken],
      value: launchFee,
    });
  }

  /* ------------------------------------------------------------ */
  /* dry-run summary                                              */
  /* ------------------------------------------------------------ */
  if (dryRun) {
    hr("Dry run summary");
    console.log(`  would send exactly ${formatEther(launchFee)} ETH to ${atomic && devBuy > 0n ? ADDRESSES.PONS_V2_LAUNCH_AND_BUY : ADDRESSES.PONS_V2_FACTORY}${atomic && devBuy > 0n ? ` (+ ${formatEther(devBuy)} ETH dev buy)` : ""}`);
    const sim = launchResult.simulationResult as readonly [Address, Address] | undefined;
    if (sim) console.log(`  simulated token/curve: ${sim[0]} / ${sim[1]}`);
    if (devBuy > 0n && !atomic) {
      console.log(`  then a 2nd tx: curve.buy(${formatEther(devBuy)} ETH, minTokensOut, ${from}) value ${formatEther(devBuy)} ETH — curve address is only known after the launch`);
      if (config && phantomQuote) {
        const e = launchEconomics(config.supply, phantomQuote, graduationThreshold);
        const q = quoteBuy({ quoteReserve: phantomQuote, tokenReserve: config.supply, reservedTokens: e.reservedTokens, feeBps: config.curveFeeBps, creatorTaxBps }, devBuy);
        console.log(`  dev buy quote        : ≈ ${formatEther(q.tokensOut)} ${symbol} (${((Number(q.tokensOut) / Number(config.supply)) * 100).toFixed(2)}% of supply), fee ${formatEther(q.fee)} + creator tax ${formatEther(q.tax)} ETH${q.clamped ? " (clamped: would complete the curve!)" : ""}`);
      }
    }
    return;
  }

  /* ------------------------------------------------------------ */
  /* parse TokenLaunched                                          */
  /* ------------------------------------------------------------ */
  hr("Launched");
  const receipt = launchResult.receipt!;
  const events = parseEventLogs({ abi: ponsV2FactoryAbi, logs: receipt.logs, eventName: "TokenLaunched" });
  if (!events.length) {
    console.log(`  ! no TokenLaunched event in receipt — inspect ${explorer.tx(receipt.transactionHash)}`);
    return;
  }
  const ev = events[0].args;
  const token = ev.token;
  const curve = ev.curve;
  const tickSpacing = config?.tickSpacing ?? 0;
  const poolId = v4PoolId(token, pairToken, tickSpacing, ADDRESSES.PONS_V2_MEME_HOOK);
  console.log(`  token              : ${token}`);
  console.log(`                       ${explorer.token(token)}`);
  console.log(`                       ${explorer.robinscanAddress(token)}`);
  console.log(`  bonding curve      : ${curve}  ${explorer.address(curve)}`);
  console.log(`  deployer           : ${ev.deployer}`);
  console.log(`  pair token         : ${ev.pairToken === ZERO_ADDRESS ? "native ETH" : ev.pairToken}`);
  console.log(`  config / threshold : ${ev.launchConfigId} / ${formatEther(ev.graduationThreshold)} ${isNative ? "ETH" : "PAIR"}`);
  console.log(`  V4 pool id (after graduation): ${poolId}${tickSpacing ? "" : "  (tickSpacing unknown offline — recompute with status.ts)"}`);
  console.log(`  tx                 : ${explorer.tx(receipt.transactionHash)}`);

  /* ------------------------------------------------------------ */
  /* optional dev buy (2nd tx, launcher is snipe-tax exempt)      */
  /* ------------------------------------------------------------ */
  if (devBuy > 0n && !atomic) {
    hr("Dev buy");
    const c = { address: curve, abi: ponsV2CurveAbi } as const;
    const [quoteReserve, tokenReserve] = (await client.readContract({ ...c, functionName: "getReserves" })) as readonly [bigint, bigint];
    const reservedTokens = await client.readContract({ ...c, functionName: "reservedTokens" });
    const feeBps = await client.readContract({ ...c, functionName: "feeBps" });
    const taxBps = await client.readContract({ ...c, functionName: "creatorTaxBps" });
    const snipe = (await tryRead("currentSnipeTaxBps", () => client.readContract({ ...c, functionName: "currentSnipeTaxBps", args: [from] }))) ?? 0n;
    const q = quoteBuy({ quoteReserve, tokenReserve, reservedTokens, feeBps, creatorTaxBps: taxBps, snipeTaxBps: snipe }, devBuy);
    const minTokensOut = (q.tokensOut * (BPS - slippageBps)) / BPS;
    console.log(`  snipe tax for sender: ${snipe} bps ${snipe === 0n ? "(exempt ✓)" : "(! NOT exempt — the launcher should be; refusing the dev buy unless --force)"}`);
    console.log(`  quote               : ${formatEther(devBuy)} ETH → ≈ ${formatEther(q.tokensOut)} ${symbol}; minTokensOut ${formatEther(minTokensOut)}`);
    if (snipe > 0n && !force) {
      console.log(`  skipped. Buy later with: tsx status.ts --token ${token} (to see the tax decay) or re-run with --force.`);
      return;
    }
    if (!isNative) {
      await planAndMaybeSend(ctx, { label: "pairToken.approve(curve, quoteIn)", address: pairToken, abi: erc20Abi, functionName: "approve", args: [curve, devBuy] });
    }
    const buyRes = await planAndMaybeSend(ctx, {
      label: "PonsV2BondingCurve.buy(quoteIn, minTokensOut, recipient)",
      address: curve,
      abi: ponsV2CurveAbi,
      functionName: "buy",
      args: [devBuy, minTokensOut, from],
      value: isNative ? devBuy : 0n,
    });
    if (buyRes.receipt) {
      const buys = parseEventLogs({ abi: ponsV2CurveAbi, logs: buyRes.receipt.logs, eventName: "CurveBuy" });
      if (buys.length) {
        const b = buys[0].args;
        console.log(`  bought              : ${formatUnits(b.tokensOut, 18)} ${symbol} for ${formatEther(b.quoteIn)} (fee ${formatEther(b.fee)}, tax ${formatEther(b.tax)})`);
      }
    }
  }
  console.log(`\nNext: tsx status.ts --token ${token}`);
}

main().catch((err) => {
  console.error(`\nERROR: ${describeRevert(err) || shortError(err)}`);
  process.exit(1);
});
