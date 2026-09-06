#!/usr/bin/env tsx
/**
 * status.ts — read-only view of a Pons v1 token: launch record, Uniswap V3 pool, price,
 * WETH/token balances in the pool, locked-position principal (graduation), uncollected LP fees.
 *
 *   tsx status.ts --token 0x...bbbb
 *
 * Everything here goes through VERIFIED ABIs (Pons factory + token source, Uniswap V3 core/periphery).
 * The only unverified piece is the locker; it is probed, never assumed.
 */
import { formatEther, formatUnits, type Address } from "viem";
import { has, parseArgs, req, usage } from "./lib/cli.js";
import { ADDRESSES, CREATOR_FEE_SHARE_BPS, explorer, getPublicClient, hr, probeRpc, requireAddress, shortError } from "./lib/config.js";
import { erc20Abi, nonfungiblePositionManagerAbi, ponsV1FactoryAbi, ponsV1LockerKnownAbi, ponsV1TokenAbi, uniswapV3PoolAbi } from "./lib/abis.js";
import { probeLockerSelectors, readUncollectedFees } from "./lib/locker.js";
import { getAmountsForLiquidity, getSqrtRatioAtTick, sqrtPriceToHuman } from "./lib/price.js";
import { tryRead } from "./lib/tx.js";

const HELP = `
status.ts — read-only status of a Pons v1 token

  --token <0x>   Pons token address (required)
`;

interface LaunchedToken {
  token: Address;
  deployer: Address;
  pairedToken: Address;
  positionManager: Address;
  positionId: bigint;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  supply: bigint;
  isToken0: boolean;
  poolFee: number;
  exists: boolean;
  initialBuyAmount: bigint;
}

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const token = requireAddress(req(args, "token"), "--token");

  hr("Pons token status");
  console.log(`token    : ${token}`);
  console.log(`explorer : ${explorer.token(token)}`);
  console.log(`robinscan: ${explorer.robinscanAddress(token)}`);

  const client = getPublicClient();
  const chainId = await probeRpc(client);
  if (chainId === null) {
    console.log("\nRPC offline — nothing to read. Would query: factory.getLaunchedToken, token metadata, pool.slot0/liquidity,");
    console.log("factory.graduationStatus, NonfungiblePositionManager.positions + simulated collect, locker probes.");
    return;
  }

  /* ------------------------------------------------------------ */
  /* launch record                                                */
  /* ------------------------------------------------------------ */
  hr("Launch record (PonsLaunchFactory.getLaunchedToken)");
  let launched: LaunchedToken | undefined;
  let factory: Address | undefined;
  for (const f of [ADDRESSES.PONS_FACTORY, ADDRESSES.PONS_FACTORY_LEGACY]) {
    const rec = await tryRead(`getLaunchedToken@${f}`, () =>
      client.readContract({ address: f, abi: ponsV1FactoryAbi, functionName: "getLaunchedToken", args: [token] }) as Promise<LaunchedToken>,
    );
    if (rec?.exists) {
      launched = rec;
      factory = f;
      break;
    }
  }
  if (!launched || !factory) {
    console.log("  not a Pons v1 token (exists=false on both the active and the legacy factory)");
  } else {
    console.log(`  factory         : ${factory}${factory === ADDRESSES.PONS_FACTORY_LEGACY ? " (LEGACY)" : " (active)"}`);
    console.log(`  deployer        : ${launched.deployer}`);
    console.log(`  paired token    : ${launched.pairedToken}${launched.pairedToken.toLowerCase() === ADDRESSES.WETH.toLowerCase() ? " (WETH)" : ""}`);
    console.log(`  supply          : ${formatEther(launched.supply)}`);
    console.log(`  pool fee        : ${launched.poolFee} (${launched.poolFee / 10000}%)   token is token${launched.isToken0 ? "0" : "1"}`);
    console.log(`  position NFT    : #${launched.positionId} on ${launched.positionManager}`);
    console.log(`  initial buy     : ${formatEther(launched.initialBuyAmount)} ETH`);
    console.log(`  config/dex ids  : ${launched.launchConfigId} / ${launched.dexId}`);
  }

  /* ------------------------------------------------------------ */
  /* token metadata                                               */
  /* ------------------------------------------------------------ */
  hr("Token (PonsLauncherToken)");
  const t = { address: token, abi: ponsV1TokenAbi } as const;
  const name = await tryRead("name", () => client.readContract({ ...t, functionName: "name" }));
  const symbol = (await tryRead("symbol", () => client.readContract({ ...t, functionName: "symbol" }))) ?? "TOKEN";
  const totalSupply = await tryRead("totalSupply", () => client.readContract({ ...t, functionName: "totalSupply" }));
  const logo = await tryRead("logo", () => client.readContract({ ...t, functionName: "logo" }));
  const description = await tryRead("description", () => client.readContract({ ...t, functionName: "description" }));
  const socials = await tryRead("socials", () => client.readContract({ ...t, functionName: "socials" }));
  const pool = await tryRead("liquidityPool", () => client.readContract({ ...t, functionName: "liquidityPool" }));
  const restrictionEnd = await tryRead("restrictionEndBlock", () => client.readContract({ ...t, functionName: "restrictionEndBlock" }));
  const block = await client.getBlockNumber();
  console.log(`  name/symbol     : ${name} (${symbol})`);
  console.log(`  total supply    : ${totalSupply !== undefined ? formatEther(totalSupply) : "?"}`);
  console.log(`  logo            : ${logo || "(none)"}`);
  console.log(`  description     : ${description || "(none)"}`);
  if (socials) console.log(`  socials         : ${JSON.stringify(socials)}`);
  if (restrictionEnd !== undefined) {
    console.log(`  anti-snipe      : until block ${restrictionEnd} (now ${block}) → ${block >= restrictionEnd ? "OVER" : `${restrictionEnd - block} blocks left`}`);
  }
  console.log(`  pool            : ${pool ?? "?"}${pool ? `  ${explorer.address(pool)}` : ""}`);

  /* ------------------------------------------------------------ */
  /* pool                                                         */
  /* ------------------------------------------------------------ */
  const pairToken = launched?.pairedToken ?? ADDRESSES.WETH;
  const pairSymbol =
    pairToken.toLowerCase() === ADDRESSES.WETH.toLowerCase()
      ? "WETH"
      : ((await tryRead("pair.symbol", () => client.readContract({ address: pairToken, abi: erc20Abi, functionName: "symbol" }))) ?? "PAIR");
  let sqrtPriceX96: bigint | undefined;
  let tokenIsToken0 = launched?.isToken0 ?? BigInt(token) < BigInt(pairToken);
  if (pool && pool !== "0x0000000000000000000000000000000000000000") {
    hr("Uniswap V3 pool");
    const p = { address: pool, abi: uniswapV3PoolAbi } as const;
    const slot0 = await tryRead("slot0", () => client.readContract({ ...p, functionName: "slot0" }));
    const liquidity = await tryRead("liquidity", () => client.readContract({ ...p, functionName: "liquidity" }));
    const token0 = await tryRead("token0", () => client.readContract({ ...p, functionName: "token0" }));
    if (token0) tokenIsToken0 = token0.toLowerCase() === token.toLowerCase();
    if (slot0) {
      sqrtPriceX96 = slot0[0];
      const h = sqrtPriceToHuman(sqrtPriceX96, 18, 18);
      const pairPerToken = tokenIsToken0 ? h.price1per0 : h.price0per1;
      const tokenPerPair = tokenIsToken0 ? h.price0per1 : h.price1per0;
      console.log(`  sqrtPriceX96    : ${sqrtPriceX96}   tick ${slot0[1]}`);
      console.log(`  price           : ${pairPerToken.toExponential(6)} ${pairSymbol} per ${symbol}   |   ${tokenPerPair.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol} per ${pairSymbol}`);
      if (totalSupply !== undefined) {
        const fdv = pairPerToken * Number(formatEther(totalSupply));
        console.log(`  FDV             : ${fdv.toFixed(4)} ${pairSymbol}`);
      }
    }
    console.log(`  liquidity (L)   : ${liquidity ?? "?"}`);
    const balPair = await tryRead("pair.balanceOf(pool)", () => client.readContract({ address: pairToken, abi: erc20Abi, functionName: "balanceOf", args: [pool] }));
    const balToken = await tryRead("token.balanceOf(pool)", () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pool] }));
    console.log(`  balances        : ${balPair !== undefined ? formatEther(balPair) : "?"} ${pairSymbol}  /  ${balToken !== undefined ? formatEther(balToken) : "?"} ${symbol}   (includes uncollected fees)`);
  }

  /* ------------------------------------------------------------ */
  /* graduation + locked position                                 */
  /* ------------------------------------------------------------ */
  if (launched && factory) {
    hr("Locked position & graduation");
    const grad = await tryRead("graduationStatus", () =>
      client.readContract({ address: factory!, abi: ponsV1FactoryAbi, functionName: "graduationStatus", args: [token] }) as Promise<readonly [bigint, bigint, boolean]>,
    );
    if (grad) {
      const [principal, threshold, graduated] = grad;
      console.log(`  ${pairSymbol} principal in LP : ${formatEther(principal)} ${pairSymbol}`);
      console.log(`  graduation      : ${threshold === 0n ? "disabled (threshold 0)" : `${formatEther(threshold)} ${pairSymbol} threshold → ${graduated ? "GRADUATED" : `${((Number(principal) / Number(threshold)) * 100).toFixed(2)}%`}`}`);
    }
    const pos = await tryRead("positions", () =>
      client.readContract({ address: launched!.positionManager, abi: nonfungiblePositionManagerAbi, functionName: "positions", args: [launched!.positionId] }),
    );
    const owner = await tryRead("ownerOf", () =>
      client.readContract({ address: launched!.positionManager, abi: nonfungiblePositionManagerAbi, functionName: "ownerOf", args: [launched!.positionId] }),
    );
    console.log(`  NFT owner       : ${owner ?? "?"}${owner && owner.toLowerCase() === ADDRESSES.PONS_LOCKER.toLowerCase() ? " (active locker)" : owner && owner.toLowerCase() === ADDRESSES.PONS_LOCKER_LEGACY.toLowerCase() ? " (legacy locker)" : ""}`);
    if (pos) {
      const [, , , , , tickLower, tickUpper, liq, , , owed0, owed1] = pos;
      console.log(`  range           : [${tickLower}, ${tickUpper}]  liquidity ${liq}`);
      if (sqrtPriceX96 !== undefined) {
        const amounts = getAmountsForLiquidity(sqrtPriceX96, getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), liq);
        const tokenAmt = tokenIsToken0 ? amounts.amount0 : amounts.amount1;
        const pairAmt = tokenIsToken0 ? amounts.amount1 : amounts.amount0;
        console.log(`  principal       : ${formatEther(pairAmt)} ${pairSymbol} + ${formatEther(tokenAmt)} ${symbol}`);
      }
      console.log(`  tokensOwed      : ${formatUnits(tokenIsToken0 ? owed1 : owed0, 18)} ${pairSymbol} + ${formatUnits(tokenIsToken0 ? owed0 : owed1, 18)} ${symbol} (already accounted, not yet collected)`);
    }
    const fees = owner ? await readUncollectedFees(client, launched.positionManager, launched.positionId, owner) : undefined;
    if (fees) {
      const tokenAmt = tokenIsToken0 ? fees.amount0 : fees.amount1;
      const pairAmt = tokenIsToken0 ? fees.amount1 : fees.amount0;
      console.log(`  uncollected fees: ${formatEther(pairAmt)} ${pairSymbol} + ${formatEther(tokenAmt)} ${symbol}  (gross, simulated collect)`);
      console.log(
        `  creator ~${Number(CREATOR_FEE_SHARE_BPS) / 100}%    : ${formatEther((pairAmt * CREATOR_FEE_SHARE_BPS) / 10_000n)} ${pairSymbol} + ${formatEther((tokenAmt * CREATOR_FEE_SHARE_BPS) / 10_000n)} ${symbol}  (docs split; locker is authoritative)`,
      );
    } else {
      console.log("  uncollected fees: unavailable (collect simulation failed)");
    }

    /* ---------------------------------------------------------- */
    /* locker probe                                               */
    /* ---------------------------------------------------------- */
    const locker = owner ?? ADDRESSES.PONS_LOCKER;
    hr(`Locker ${locker} (ABI unverified — bytecode probe)`);
    const probe = await probeLockerSelectors(client, locker);
    const fw = probe.writes.filter((p) => p.present).map((p) => p.signature);
    const fr = probe.reads.filter((p) => p.present).map((p) => p.signature);
    console.log(`  write cands     : ${fw.length ? fw.join(", ") : "none found"}`);
    console.log(`  read cands      : ${fr.length ? fr.join(", ") : "none found"}`);
    if (fr.includes("protocolFeeRecipient()")) {
      const v = await tryRead("protocolFeeRecipient", () => client.readContract({ address: locker, abi: ponsV1LockerKnownAbi, functionName: "protocolFeeRecipient" }));
      if (v) console.log(`  protocolFeeRecipient : ${v}`);
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(`\nERROR: ${shortError(err)}`);
  process.exit(1);
});
