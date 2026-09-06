/**
 * ABIs used by the scripts.
 *
 * - `ponsV1FactoryAbi`  : official ABI shipped in github.com/ponsdotdev/ponsfamily (abi/pons_v1_factory.json). VERIFIED.
 * - `ponsV1TokenAbi`    : derived from contractsV1/src/PonsLauncherToken.sol in the same repo. VERIFIED (source).
 * - `ponsLockerAbi`   : ONLY the surface the factory source calls (`IPonsLaunchLocker`) plus
 *                       `feeRedirects(address)` mentioned by third parties. The claim function is
 *                       NOT VERIFIED — see claim-v1.ts and CHAIN.md §5.
 * - Uniswap V3 ABIs   : canonical v3-core / v3-periphery signatures (minimal subsets).
 */
import { parseAbi } from "viem";
import { loadAbi } from "./config.js";

export const ponsV1FactoryAbi = loadAbi("pons_v1_factory.json");

export const ponsV1TokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deployer() view returns (address)",
  "function launchFactory() view returns (address)",
  "function dexFactory() view returns (address)",
  "function positionManager() view returns (address)",
  "function pairToken() view returns (address)",
  "function poolFee() view returns (uint24)",
  "function launchBlock() view returns (uint256)",
  "function restrictionBlocks() view returns (uint256)",
  "function restrictionEndBlock() view returns (uint256)",
  "function maxWalletBps() view returns (uint16)",
  "function maxTxBps() view returns (uint16)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function liquidityPool() view returns (address)",
  "function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)",
  "function maxWalletLimit() view returns (uint256)",
  "function maxTxLimit() view returns (uint256)",
]);

/** Verified part: IPonsLaunchLocker in contractsV1/src/interfaces/ILaunchpad.sol. */
export const ponsV1LockerKnownAbi = parseAbi([
  "function protocolFeeRecipient() view returns (address)",
  "function lockPosition(address token)",
  "function setFeeRedirect(address token, address newFeeWallet)",
]);

/**
 * UNVERIFIED locker surface. `feeRedirects(address)` is referenced by the PonsVault README;
 * the claim function name is unknown. claim.ts checks which of these selectors actually exist
 * in the locker bytecode before it ever sends a transaction.
 */
export const LOCKER_CLAIM_CANDIDATES = [
  "claimFees(address)",
  "claim(address)",
  "collectFees(address)",
  "collect(address)",
  "claimCreatorFees(address)",
  "collectCreatorFees(address)",
  "claimRewards(address)",
  "harvest(address)",
  "claimFor(address)",
  "collectFor(address)",
] as const;

export const LOCKER_READ_CANDIDATES = [
  "protocolFeeRecipient()",
  "feeRedirects(address)",
  "feeRedirect(address)",
  "positions(address)",
  "positionOf(address)",
  "lockedPositions(address)",
  "tokenPositions(address)",
  "positionIds(address)",
  "creatorFeeBps()",
  "protocolFeeBps()",
  "creatorShareBps()",
  "pendingFees(address)",
  "claimable(address)",
  "claimableFees(address)",
  "factory()",
  "positionManager()",
  "owner()",
] as const;

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const uniswapV3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);

export const uniswapV3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

export const nonfungiblePositionManagerAbi = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/** Standard Uniswap V3 fee tier -> tick spacing (v3-core UniswapV3Factory constructor). */
export const FEE_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
