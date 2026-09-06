/**
 * Uniswap V3 price maths (BigInt only, no floating point on the hot path).
 *
 * ── Token ordering ────────────────────────────────────────────────────────────
 * A Uniswap V3 pool is keyed by (token0, token1, fee) where token0 is the token
 * with the numerically LOWER address (`token0 < token1` as uint160). This is not
 * a preference, it is enforced by the factory (`require(tokenA < tokenB)`), so
 * every price in the pool is expressed as "token1 per token0".
 *
 * ── sqrtPriceX96 ──────────────────────────────────────────────────────────────
 * The pool stores price as sqrtPriceX96 = floor( sqrt(P) * 2^96 ), where
 *     P = (raw amount of token1) / (raw amount of token0)
 * i.e. P is in *base units* (wei-like), not human units. If the human price is
 * `h` = quote per token (e.g. 0.001 AMZN per CUT) then:
 *
 *   case A  token is token0, quote is token1:
 *       P = h * 10^decQuote / 10^decToken
 *   case B  quote is token0, token is token1:
 *       P = (1/h) * 10^decToken / 10^decQuote
 *
 * We keep `h` as an exact rational num/den parsed from the decimal string, so
 *   sqrtPriceX96 = isqrt( P * 2^192 )
 *               = isqrt( num * 10^dec1 * 2^192 / (den * 10^dec0) )
 * and the only rounding is the final integer square root.
 *
 * ── tick ──────────────────────────────────────────────────────────────────────
 * tick = floor( log_{1.0001}(P) ). We compute it with floating point purely for
 * display (the pool derives its own tick from sqrtPriceX96 on-chain).
 */
import type { Address } from "viem";

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** Integer square root (Newton), exact floor for BigInt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  // Seed with 2^(ceil(bits/2)), which is always >= sqrt(n); Newton then decreases
  // monotonically and stops at floor(sqrt(n)). No float involved, so no precision trap.
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Parses "123.456" (or "1e-5") into an exact rational { num, den }. */
export function parseDecimalRational(s: string): { num: bigint; den: bigint } {
  const t = s.trim().toLowerCase();
  const m = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`not a decimal number: ${s}`);
  const intPart = m[1] || "0";
  const fracPart = m[2] ?? "";
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  let num = BigInt(intPart + fracPart);
  let den = 10n ** BigInt(fracPart.length);
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  if (num === 0n) throw new Error("price must be > 0");
  return { num, den };
}

export function sortTokens(a: Address, b: Address): [Address, Address] {
  if (a.toLowerCase() === b.toLowerCase()) throw new Error("token and quote are the same address");
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

export interface PriceInput {
  token: Address;
  tokenDecimals: number;
  quote: Address;
  quoteDecimals: number;
  /** human price: quote units per 1 token unit */
  priceQuotePerToken: string;
}

export interface PriceResult {
  token0: Address;
  token1: Address;
  tokenIsToken0: boolean;
  /** P = token1 raw per token0 raw, as an exact rational */
  pNum: bigint;
  pDen: bigint;
  sqrtPriceX96: bigint;
  /** display-only, floor(log_1.0001(P)) */
  tick: number;
}

export function computeSqrtPriceX96(input: PriceInput): PriceResult {
  const { num, den } = parseDecimalRational(input.priceQuotePerToken);
  const [token0, token1] = sortTokens(input.token, input.quote);
  const tokenIsToken0 = token0.toLowerCase() === input.token.toLowerCase();
  const dec0 = tokenIsToken0 ? input.tokenDecimals : input.quoteDecimals;
  const dec1 = tokenIsToken0 ? input.quoteDecimals : input.tokenDecimals;

  // P = token1_raw / token0_raw
  //  A: token0=token → P = h * 10^dec1 / 10^dec0
  //  B: token0=quote → P = (1/h) * 10^dec1 / 10^dec0
  const pNum = (tokenIsToken0 ? num : den) * 10n ** BigInt(dec1);
  const pDen = (tokenIsToken0 ? den : num) * 10n ** BigInt(dec0);

  const sqrtPriceX96 = isqrt((pNum * Q192) / pDen);
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(`price out of Uniswap V3 range (sqrtPriceX96=${sqrtPriceX96})`);
  }
  const tick = Math.floor(Math.log(Number(pNum) / Number(pDen)) / Math.log(1.0001));
  return { token0, token1, tokenIsToken0, pNum, pDen, sqrtPriceX96, tick };
}

/** Full-range usable ticks for a tick spacing (matches Uniswap's TickMath / NPM behaviour). */
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  // Truncation toward zero, exactly like `(MIN_TICK / tickSpacing) * tickSpacing` in Solidity.
  const tickLower = Math.trunc(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper = Math.trunc(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

/**
 * Turns a pool sqrtPriceX96 back into human prices for display.
 * Returns token1-per-token0 and token0-per-token1 in human units.
 */
export function sqrtPriceToHuman(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number,
): { price1per0: number; price0per1: number } {
  const ratio = Number(sqrtPriceX96) / 2 ** 96; // sqrt(P)
  const p = ratio * ratio; // token1_raw per token0_raw
  const price1per0 = p * 10 ** (dec0 - dec1);
  return { price1per0, price0per1: price1per0 === 0 ? Infinity : 1 / price1per0 };
}

/** Uniswap LiquidityAmounts.getAmountsForLiquidity, ported for status display. */
export function getAmountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtP <= sqrtA) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtA)) / sqrtB / sqrtA;
  } else if (sqrtP < sqrtB) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtP)) / sqrtB / sqrtP;
    amount1 = (liquidity * (sqrtP - sqrtA)) / Q96;
  } else {
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
  }
  return { amount0, amount1 };
}

/** LiquidityAmounts.getLiquidityForAmounts (v3-periphery), used to preview a mint. */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const l0 = (a: bigint, b: bigint, amt: bigint) => (amt * ((a * b) / Q96)) / (b - a);
  const l1 = (a: bigint, b: bigint, amt: bigint) => (amt * Q96) / (b - a);
  if (sqrtP <= sqrtA) return l0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const x = l0(sqrtP, sqrtB, amount0);
    const y = l1(sqrtA, sqrtP, amount1);
    return x < y ? x : y;
  }
  return l1(sqrtA, sqrtB, amount1);
}

/** TickMath.getSqrtRatioAtTick ported to BigInt (exact port of the Solidity constants). */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error("tick out of range");
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const mul = (v: bigint) => (ratio = (ratio * v) >> 128n);
  if ((absTick & 0x2n) !== 0n) mul(0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4n) !== 0n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8n) !== 0n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10n) !== 0n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20n) !== 0n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40n) !== 0n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80n) !== 0n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100n) !== 0n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200n) !== 0n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400n) !== 0n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800n) !== 0n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000n) !== 0n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000n) !== 0n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000n) !== 0n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000n) !== 0n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000n) !== 0n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000n) !== 0n) mul(0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000n) !== 0n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000n) !== 0n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // downcast from Q128.128 to Q64.96, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
