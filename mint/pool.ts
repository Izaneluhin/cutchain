#!/usr/bin/env tsx
/**
 * pool.ts — create (and optionally seed) a Uniswap V3 pool for --token against a quote token,
 * by default the AMZN Stock Token, through the NonfungiblePositionManager.
 *
 * NOTE (Pons V2): a V2 launch's PRIMARY market is its bonding curve and, after graduation, a
 * Uniswap V4 pool (fee 0 + Pons meme hook, position locked forever) — see status.ts for its pool id.
 * This script creates an additional, independent Uniswap V3 side pool (e.g. CUT/AMZN). It is only
 * sensible once you actually hold tokens (buy them on the curve first) and it earns you regular V3
 * LP fees, not Pons creator fees.
 *
 *   tsx pool.ts --token 0x... [--quote 0x12f1...bf54] [--fee 10000] --price 0.001
 *               [--amount-token 1000000] [--amount-quote 1000] [--recipient 0x...]
 *               [--slippage-bps 100] [--from 0x...] [--dry-run]
 *
 *   --price   is QUOTE per TOKEN in human units (e.g. 0.001 = one CUT costs 0.001 AMZN).
 *             Required unless the pool already exists and is initialized.
 *   --amount-token / --amount-quote are human amounts; give one and the other is derived
 *             from the price for a balanced full-range position, or give both.
 *
 * On-chain steps (each is its own transaction; all are simulated first):
 *   1. NonfungiblePositionManager.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)
 *      - the NPM calls UniswapV3Factory.createPool if needed, then pool.initialize(sqrtPriceX96)
 *      - a no-op if the pool already exists and is initialized
 *   2. ERC20.approve(NPM, amount) for each side that lacks allowance
 *   3. NonfungiblePositionManager.mint({token0, token1, fee, tickLower, tickUpper, amount0Desired,
 *        amount1Desired, amount0Min, amount1Min, recipient, deadline})  → full-range position NFT
 *
 * ── How sqrtPriceX96 is derived (see lib/price.ts for the exact BigInt code) ──
 *   Uniswap keys a pool as (token0, token1) with token0 < token1 by address, and its price is
 *   always "raw token1 per raw token0":  sqrtPriceX96 = floor( sqrt(P) * 2^96 ).
 *   With h = quote per token (human) and decimals dT, dQ:
 *      token is token0 → P = h        * 10^dQ / 10^dT
 *      quote is token0 → P = (1 / h)  * 10^dT / 10^dQ
 *   Because the ordering flips the fraction, the script prints both orientations so the
 *   number you approve can be sanity-checked before anything is sent.
 */
import {
  encodeAbiParameters,
  formatUnits,
  getContractAddress,
  keccak256,
  maxUint256,
  parseEventLogs,
  parseUnits,
  type Address,
} from "viem";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import {
  ADDRESSES,
  PLACEHOLDER_SENDER,
  V3_POOL_INIT_CODE_HASH,
  explorer,
  getPublicClient,
  getWalletClient,
  hr,
  isAddress,
  probeRpc,
  requireAddress,
  shortError,
} from "./lib/config.js";
import { FEE_TICK_SPACING, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "./lib/abis.js";
import {
  computeSqrtPriceX96,
  fullRangeTicks,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  sortTokens,
  sqrtPriceToHuman,
} from "./lib/price.js";
import { planAndMaybeSend, tryRead } from "./lib/tx.js";

const HELP = `
pool.ts — create a Uniswap V3 pool (default quote: AMZN ${ADDRESSES.AMZN})

  --token <0x>          base token (required)
  --quote <0x>          quote token (default AMZN Stock Token)
  --fee <n>             pool fee in hundredths of a bip: 100 | 500 | 3000 | 10000 (default 10000 = 1%)
  --price <decimal>     initial price, QUOTE per TOKEN (required unless pool already initialized)
  --amount-token <dec>  token amount to deposit (human units)
  --amount-quote <dec>  quote amount to deposit (human units)
  --recipient <0x>      position NFT recipient (default sender)
  --slippage-bps <n>    amountMin tolerance for mint (default 100 = 1%)
  --from <0x>           simulation sender when PRIVATE_KEY is absent
  --dry-run             print calldata + simulate, send nothing
`;

/** Off-chain CREATE2 of the pool address (UniswapV3PoolDeployer: salt = keccak(abi.encode(token0, token1, fee))). */
function computePoolAddress(token0: Address, token1: Address, fee: number): Address {
  const salt = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [token0, token1, fee]),
  );
  return getContractAddress({ opcode: "CREATE2", from: ADDRESSES.UNISWAP_V3_FACTORY, salt, bytecodeHash: V3_POOL_INIT_CODE_HASH });
}

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const dryRun = has(args, "dry-run");

  const token = requireAddress(req(args, "token"), "--token");
  const quote = requireAddress(opt(args, "quote", ADDRESSES.AMZN), "--quote");
  const fee = Number(opt(args, "fee", "10000"));
  if (!(fee in FEE_TICK_SPACING)) throw new Error(`--fee must be one of ${Object.keys(FEE_TICK_SPACING).join(", ")}`);
  const slippageBps = BigInt(opt(args, "slippage-bps", "100")!);

  const client = getPublicClient();
  const walletInfo = getWalletClient();
  const fromArg = opt(args, "from");
  const from: Address = walletInfo?.address ?? (isAddress(fromArg) ? fromArg : PLACEHOLDER_SENDER);
  const recipient = requireAddress(opt(args, "recipient", from), "--recipient");
  if (!dryRun && !walletInfo) throw new Error("PRIVATE_KEY is required unless --dry-run");

  hr(`Uniswap V3 pool ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  const chainId = await probeRpc(client);
  const online = chainId !== null;
  console.log(`rpc      : ${online ? `online (chain ${chainId})` : "OFFLINE — calldata only"}`);
  console.log(`sender   : ${from}${walletInfo ? "" : "  (no PRIVATE_KEY — placeholder / --from)"}`);

  /* ------------------------------------------------------------ */
  /* token metadata                                               */
  /* ------------------------------------------------------------ */
  const meta = async (addr: Address, label: string) => {
    let decimals = 18;
    let symbol = label;
    if (online) {
      const d = await tryRead(`${label}.decimals`, () => client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }));
      const s = await tryRead(`${label}.symbol`, () => client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }));
      if (d !== undefined) decimals = Number(d);
      if (s) symbol = s;
    }
    return { decimals, symbol };
  };
  const tokenMeta = await meta(token, "TOKEN");
  const quoteMeta = await meta(quote, "QUOTE");
  if (!online) console.log("! offline: assuming 18 decimals for both tokens (Pons tokens and Stock Tokens are 18-decimal)");
  console.log(`token    : ${token} (${tokenMeta.symbol}, ${tokenMeta.decimals} dec)`);
  console.log(`quote    : ${quote} (${quoteMeta.symbol}, ${quoteMeta.decimals} dec)`);

  const [token0, token1] = sortTokens(token, quote);
  const tokenIsToken0 = token0.toLowerCase() === token.toLowerCase();
  const dec0 = tokenIsToken0 ? tokenMeta.decimals : quoteMeta.decimals;
  const dec1 = tokenIsToken0 ? quoteMeta.decimals : tokenMeta.decimals;
  const sym0 = tokenIsToken0 ? tokenMeta.symbol : quoteMeta.symbol;
  const sym1 = tokenIsToken0 ? quoteMeta.symbol : tokenMeta.symbol;
  console.log(`ordering : token0=${token0} (${sym0})  token1=${token1} (${sym1})  ← token0 is the lower address`);
  console.log(`fee tier : ${fee} (${fee / 10000}%)  tick spacing ${FEE_TICK_SPACING[fee]}`);

  const predictedPool = computePoolAddress(token0, token1, fee);
  console.log(`pool addr: ${predictedPool} (CREATE2 prediction)  ${explorer.address(predictedPool)}`);

  /* ------------------------------------------------------------ */
  /* existing pool?                                               */
  /* ------------------------------------------------------------ */
  let existingPool: Address | undefined;
  let existingSqrtPrice: bigint | undefined;
  let tickSpacing = FEE_TICK_SPACING[fee];
  if (online) {
    const p = await tryRead("factory.getPool", () =>
      client.readContract({ address: ADDRESSES.UNISWAP_V3_FACTORY, abi: uniswapV3FactoryAbi, functionName: "getPool", args: [token0, token1, fee] }),
    );
    if (p && p !== "0x0000000000000000000000000000000000000000") {
      existingPool = p;
      const slot0 = await tryRead("pool.slot0", () => client.readContract({ address: p, abi: uniswapV3PoolAbi, functionName: "slot0" }));
      if (slot0 && slot0[0] !== 0n) existingSqrtPrice = slot0[0];
      console.log(`existing : pool ${p} ${existingSqrtPrice ? `initialized (sqrtPriceX96=${existingSqrtPrice})` : "exists but NOT initialized"}`);
      if (existingSqrtPrice) {
        const h = sqrtPriceToHuman(existingSqrtPrice, dec0, dec1);
        console.log(`           current price: ${h.price1per0} ${sym1}/${sym0}  |  ${h.price0per1} ${sym0}/${sym1}`);
      }
    } else {
      console.log("existing : none");
    }
    const ts = await tryRead("factory.feeAmountTickSpacing", () =>
      client.readContract({ address: ADDRESSES.UNISWAP_V3_FACTORY, abi: uniswapV3FactoryAbi, functionName: "feeAmountTickSpacing", args: [fee] }),
    );
    if (ts !== undefined) {
      if (ts === 0) throw new Error(`fee tier ${fee} is not enabled on this Uniswap V3 factory`);
      tickSpacing = ts;
    }
  }

  /* ------------------------------------------------------------ */
  /* price → sqrtPriceX96                                         */
  /* ------------------------------------------------------------ */
  hr("Price");
  let priceArg = opt(args, "price");
  if (!priceArg && !existingSqrtPrice) {
    if (!dryRun) throw new Error("--price (quote per token) is required to initialize a new pool");
    priceArg = "1";
    console.log("  ! no --price given; DRY RUN uses a placeholder of 1 QUOTE per TOKEN. Live runs require --price.");
  }
  let sqrtPriceX96: bigint;
  if (priceArg) {
    const pr = computeSqrtPriceX96({
      token,
      tokenDecimals: tokenMeta.decimals,
      quote,
      quoteDecimals: quoteMeta.decimals,
      priceQuotePerToken: priceArg,
    });
    sqrtPriceX96 = pr.sqrtPriceX96;
    console.log(`  input          : ${priceArg} ${quoteMeta.symbol} per ${tokenMeta.symbol}`);
    console.log(`  P (raw t1/t0)  : ${pr.pNum} / ${pr.pDen}`);
    console.log(`  sqrtPriceX96   : ${sqrtPriceX96}`);
    console.log(`  tick (approx)  : ${pr.tick}`);
    const back = sqrtPriceToHuman(sqrtPriceX96, dec0, dec1);
    console.log(`  round-trip     : ${back.price1per0} ${sym1}/${sym0}  |  ${back.price0per1} ${sym0}/${sym1}`);
    if (existingSqrtPrice && existingSqrtPrice !== sqrtPriceX96) {
      console.log("  ! pool is already initialized; --price is ignored by createAndInitializePoolIfNecessary and the mint uses the live price");
      sqrtPriceX96 = existingSqrtPrice;
    }
  } else {
    sqrtPriceX96 = existingSqrtPrice!;
    console.log("  using live pool price (no --price given)");
  }

  const ctx = { client, rpcOnline: online, dryRun, from, wallet: walletInfo?.wallet };

  /* ------------------------------------------------------------ */
  /* 1. create + initialize                                       */
  /* ------------------------------------------------------------ */
  let poolAddress: Address = existingPool ?? predictedPool;
  if (!existingSqrtPrice) {
    const r = await planAndMaybeSend(ctx, {
      label: "NonfungiblePositionManager.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)",
      address: ADDRESSES.NONFUNGIBLE_POSITION_MANAGER,
      abi: nonfungiblePositionManagerAbi,
      functionName: "createAndInitializePoolIfNecessary",
      args: [token0, token1, fee, sqrtPriceX96],
    });
    if (typeof r.simulationResult === "string") poolAddress = r.simulationResult as Address;
    if (r.receipt) {
      const created = parseEventLogs({ abi: uniswapV3FactoryAbi, logs: r.receipt.logs, eventName: "PoolCreated" });
      if (created.length) poolAddress = (created[0].args as { pool: Address }).pool;
      console.log(`  pool created/initialized: ${poolAddress}  ${explorer.address(poolAddress)}`);
    }
  } else {
    console.log("\n▶ createAndInitializePoolIfNecessary: skipped (pool already initialized)");
  }

  /* ------------------------------------------------------------ */
  /* 2+3. optional liquidity                                      */
  /* ------------------------------------------------------------ */
  const amtTokenArg = opt(args, "amount-token");
  const amtQuoteArg = opt(args, "amount-quote");
  if (!amtTokenArg && !amtQuoteArg) {
    hr("Done");
    console.log(`  pool: ${poolAddress}  ${explorer.address(poolAddress)}`);
    console.log("  (no --amount-token/--amount-quote given → no liquidity added)");
    return;
  }

  hr("Liquidity (full range)");
  const { tickLower, tickUpper } = fullRangeTicks(tickSpacing);
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  console.log(`  ticks          : [${tickLower}, ${tickUpper}] (spacing ${tickSpacing})`);

  // amounts in raw units, oriented as token0/token1
  let amountToken = amtTokenArg ? parseUnits(amtTokenArg, tokenMeta.decimals) : undefined;
  let amountQuote = amtQuoteArg ? parseUnits(amtQuoteArg, quoteMeta.decimals) : undefined;
  const toT0T1 = (t: bigint, q: bigint) => (tokenIsToken0 ? [t, q] : [q, t]) as [bigint, bigint];

  if (amountToken !== undefined && amountQuote === undefined) {
    // derive the quote side so the position is balanced at the current price
    const [a0, a1] = toT0T1(amountToken, maxUint256 / 4n);
    const L = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, a0, a1);
    const used = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, L);
    amountQuote = tokenIsToken0 ? used.amount1 : used.amount0;
    console.log(`  derived quote  : ${formatUnits(amountQuote, quoteMeta.decimals)} ${quoteMeta.symbol}`);
  } else if (amountQuote !== undefined && amountToken === undefined) {
    const [a0, a1] = toT0T1(maxUint256 / 4n, amountQuote);
    const L = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, a0, a1);
    const used = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, L);
    amountToken = tokenIsToken0 ? used.amount0 : used.amount1;
    console.log(`  derived token  : ${formatUnits(amountToken, tokenMeta.decimals)} ${tokenMeta.symbol}`);
  }
  const [amount0Desired, amount1Desired] = toT0T1(amountToken!, amountQuote!);
  const L = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0Desired, amount1Desired);
  const used = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, L);
  console.log(`  desired        : ${formatUnits(amount0Desired, dec0)} ${sym0} + ${formatUnits(amount1Desired, dec1)} ${sym1}`);
  console.log(`  will consume   : ${formatUnits(used.amount0, dec0)} ${sym0} + ${formatUnits(used.amount1, dec1)} ${sym1}  (liquidity ${L})`);
  const leftover0 = amount0Desired - used.amount0;
  const leftover1 = amount1Desired - used.amount1;
  if (leftover0 > amount0Desired / 100n || leftover1 > amount1Desired / 100n) {
    console.log(`  ! amounts are not balanced for this price: leftover ${formatUnits(leftover0, dec0)} ${sym0} / ${formatUnits(leftover1, dec1)} ${sym1} stays in your wallet`);
  }
  const amount0Min = (used.amount0 * (10_000n - slippageBps)) / 10_000n;
  const amount1Min = (used.amount1 * (10_000n - slippageBps)) / 10_000n;

  if (online) {
    for (const [addr, need, m] of [
      [token0, amount0Desired, tokenIsToken0 ? tokenMeta : quoteMeta],
      [token1, amount1Desired, tokenIsToken0 ? quoteMeta : tokenMeta],
    ] as const) {
      const bal = await tryRead(`${m.symbol}.balanceOf`, () => client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [from] }));
      if (bal !== undefined && bal < need) {
        console.log(`  ! insufficient ${m.symbol}: have ${formatUnits(bal, m.decimals)}, need ${formatUnits(need, m.decimals)}${addr.toLowerCase() === ADDRESSES.WETH.toLowerCase() ? " (wrap ETH via WETH.deposit first)" : ""}`);
      }
    }
  }

  // approvals
  for (const [addr, need, m] of [
    [token0, amount0Desired, tokenIsToken0 ? tokenMeta : quoteMeta],
    [token1, amount1Desired, tokenIsToken0 ? quoteMeta : tokenMeta],
  ] as const) {
    if (need === 0n) continue;
    let allowance = 0n;
    if (online) {
      allowance =
        (await tryRead(`${m.symbol}.allowance`, () =>
          client.readContract({ address: addr, abi: erc20Abi, functionName: "allowance", args: [from, ADDRESSES.NONFUNGIBLE_POSITION_MANAGER] }),
        )) ?? 0n;
    }
    if (allowance >= need) {
      console.log(`\n▶ ${m.symbol}.approve: skipped (allowance ${formatUnits(allowance, m.decimals)} ≥ needed)`);
      continue;
    }
    await planAndMaybeSend(ctx, {
      label: `${m.symbol}.approve(NonfungiblePositionManager, amount)`,
      address: addr,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDRESSES.NONFUNGIBLE_POSITION_MANAGER, need],
    });
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const mintParams = {
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
  };
  const r = await planAndMaybeSend(ctx, {
    label: "NonfungiblePositionManager.mint(MintParams)",
    address: ADDRESSES.NONFUNGIBLE_POSITION_MANAGER,
    abi: nonfungiblePositionManagerAbi,
    functionName: "mint",
    args: [mintParams],
  });

  hr(dryRun ? "Dry run summary" : "Done");
  console.log(`  pool           : ${poolAddress}  ${explorer.address(poolAddress)}`);
  if (r.receipt) {
    const inc = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs: r.receipt.logs, eventName: "IncreaseLiquidity" });
    if (inc.length) {
      const a = inc[0].args as { tokenId: bigint; liquidity: bigint; amount0: bigint; amount1: bigint };
      console.log(`  position NFT   : #${a.tokenId} → ${recipient}`);
      console.log(`  deposited      : ${formatUnits(a.amount0, dec0)} ${sym0} + ${formatUnits(a.amount1, dec1)} ${sym1}`);
    }
    console.log(`  tx             : ${explorer.tx(r.receipt.transactionHash)}`);
  } else if (dryRun) {
    console.log("  nothing sent");
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${shortError(err)}`);
  process.exit(1);
});
