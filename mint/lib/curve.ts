/**
 * Pons V2 bonding-curve maths and Uniswap V4 pool identity, ported 1:1 from
 * contractsV2/src/v2/libraries/PonsV2BondingCurveMath.sol, PonsV2BondingCurve.sol and
 * PonsV2LaunchFactory._poolIdFor (github.com/ponsdotdev/ponsfamily).
 *
 * The curve is constant-product over (quoteReserve, tokenReserve) where
 *   quoteReserve = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance
 *   tokenReserve = trackedTokens
 * `phantomQuote` is virtual liquidity that sets the opening price; it is never held.
 *
 * Fees on a BUY (all on the quote leg, before the swap):
 *   fee = spent * feeBps / 1e4            (launch config curveFeeBps → protocol / buyback / creator split)
 *   tax = spent * creatorTaxBps / 1e4     (creator-chosen at launch, 100% to the creator)
 *   tokensOut = getAmountOut(spent - fee - tax, quoteReserve, tokenReserve, 0)
 * Snipe tax (deployed curve; docs): an extra bps on the quote leg for non-exempt recipients that
 * starts at snipeTaxStartBps (99%) and decays exponentially to 0 over snipeTaxSeconds (docs: 5 s).
 * The launcher and the creator fee recipient are exempt.
 *
 * Fee split at sweep (per launch snapshot of the hook's FeePolicySnapshot):
 *   protocolAmount = pendingFee * protocolFeeShareBps / 1e4
 *   creatorBucket  = pendingFee - protocolAmount
 *   buybackAmount  = buybackEnabled ? creatorBucket * buybackBurnBps / 1e4 : 0   (bought back + vested 5y)
 *   creatorAmount  = creatorBucket - buybackAmount + creatorTax
 * Everything credited to the Fee Escrow, claimable by the creator fee recipient at any time.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const BPS = 10_000n;

/** PonsV2BondingCurveMath.getAmountOut (returns 0n where the contract would revert). */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 0n): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n || feeBps >= BPS) return 0n;
  const amountInWithFee = amountIn * (BPS - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
}

/** PonsV2BondingCurveMath.getAmountIn. */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 0n): bigint {
  if (amountOut === 0n || reserveIn === 0n || reserveOut <= amountOut || feeBps >= BPS) return 0n;
  return (amountOut * reserveIn * BPS) / ((reserveOut - amountOut) * (BPS - feeBps)) + 1n;
}

export interface CurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  reservedTokens: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** extra snipe tax for this recipient right now (0 for exempt / after the window) */
  snipeTaxBps?: bigint;
}

export interface BuyQuote {
  spent: bigint;
  fee: bigint;
  tax: bigint;
  snipe: bigint;
  tokensOut: bigint;
  /** true when the buy would overshoot the sellable allocation and be clamped + refunded */
  clamped: boolean;
  refund: bigint;
}

/** Mirrors PonsV2BondingCurve.buy, including the partial-fill clamp on the last buy. */
/** Docs: "the snipe tax is capped so the buyer always nets at least 1% of spend". */
export const SNIPE_MIN_NET_BPS = 100n;

export function quoteBuy(state: CurveState, quoteIn: bigint): BuyQuote {
  let snipeBps = state.snipeTaxBps ?? 0n;
  const maxSnipe = BPS - state.feeBps - state.creatorTaxBps - SNIPE_MIN_NET_BPS;
  if (snipeBps > maxSnipe) snipeBps = maxSnipe > 0n ? maxSnipe : 0n;
  let spent = quoteIn;
  let fee = (spent * state.feeBps) / BPS;
  let tax = (spent * state.creatorTaxBps) / BPS;
  let snipe = (spent * snipeBps) / BPS;
  let tokensOut = getAmountOut(spent - fee - tax - snipe, state.quoteReserve, state.tokenReserve, 0n);
  const sellable = state.tokenReserve > state.reservedTokens ? state.tokenReserve - state.reservedTokens : 0n;
  let clamped = false;
  if (tokensOut > sellable) {
    clamped = true;
    tokensOut = sellable;
    const net = getAmountIn(sellable, state.quoteReserve, state.tokenReserve, 0n);
    const denom = BPS - state.feeBps - state.creatorTaxBps - snipeBps;
    const grossed = (net * BPS + denom - 1n) / denom; // mulDiv ceil
    spent = grossed < quoteIn ? grossed : quoteIn;
    fee = (spent * state.feeBps) / BPS;
    tax = (spent * state.creatorTaxBps) / BPS;
    snipe = (spent * snipeBps) / BPS;
  }
  return { spent, fee, tax, snipe, tokensOut, clamped, refund: quoteIn - spent };
}

/** Quote per token (human, both 18-dec) at the current marginal price. */
export function spotPrice(quoteReserve: bigint, tokenReserve: bigint): number {
  if (tokenReserve === 0n) return Infinity;
  return Number(quoteReserve) / Number(tokenReserve);
}

/** PonsV2BondingCurve.initialize: tokens held back for the graduated pool. */
export function reservedTokensFor(supply: bigint, phantomQuote: bigint, graduationThreshold: bigint): bigint {
  return (supply * phantomQuote) / (phantomQuote + graduationThreshold);
}

export interface LaunchEconomics {
  supply: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  reservedTokens: bigint;
  sellableTokens: bigint;
  /** quote per token at launch (phantomQuote / supply) */
  openingPrice: number;
  /** quote per token when the curve completes ((phantomQuote + threshold) / reserved) */
  graduationPrice: number;
  /** FDV in quote base units (wei for ETH) when the curve completes = graduationPrice * supply */
  graduationFdvWei: number;
  /** FDV in quote base units at launch = openingPrice * supply = phantomQuote */
  openingFdvWei: number;
}

export function launchEconomics(supply: bigint, phantomQuote: bigint, graduationThreshold: bigint): LaunchEconomics {
  const reservedTokens = reservedTokensFor(supply, phantomQuote, graduationThreshold);
  const graduationPrice = Number(phantomQuote + graduationThreshold) / Number(reservedTokens);
  return {
    supply,
    phantomQuote,
    graduationThreshold,
    reservedTokens,
    sellableTokens: supply - reservedTokens,
    openingPrice: Number(phantomQuote) / Number(supply),
    graduationPrice,
    graduationFdvWei: graduationPrice * Number(supply),
    openingFdvWei: Number(phantomQuote),
  };
}

/**
 * Uniswap V4 PoolKey → PoolId for a graduated launch, exactly as PonsV2LaunchFactory._poolIdFor does it:
 * currencies sorted ascending (native ETH = address(0) is always currency0), fee 0 (the hook charges instead),
 * the launch's snapshotted tickSpacing, hooks = the meme hook.
 */
export function v4PoolId(token: Address, pairToken: Address, tickSpacing: number, hook: Address, fee = 0): Hex {
  const [c0, c1] = BigInt(token) < BigInt(pairToken) ? [token, pairToken] : [pairToken, token];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0, c1, fee, tickSpacing, hook],
    ),
  );
}

/** Snipe tax decay used only for display: exponential from start to ~0 over `windowSeconds` (docs: 99% → 25% @1s → 3% @2s → 0 @5s). */
export function snipeTaxAt(elapsedSeconds: number, startBps: number, windowSeconds: number): number {
  if (elapsedSeconds >= windowSeconds || startBps === 0) return 0;
  // Fit so that 25% at 1 s from a 99% start over a 5 s window: rate ≈ ln(99/25) ≈ 1.376 per second.
  const k = Math.log(startBps / 100 / 0.25) * (5 / windowSeconds);
  return Math.max(0, startBps * Math.exp(-k * elapsedSeconds));
}
