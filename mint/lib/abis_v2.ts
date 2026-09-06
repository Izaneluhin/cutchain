/**
 * Pons V2 ABIs, written as human-readable signatures and parsed with viem.
 *
 * Provenance (see CHAIN.md §4):
 *   - Derived by hand from the official source in github.com/ponsdotdev/ponsfamily `contractsV2/src/v2/*`
 *     (factory, bonding curve, hook, token, buyback vault, locker, IPonsV2FeeEscrow) cross-checked with the
 *     function list on docs.ponsfamily.com/v2. The repo has NO compiled V2 ABI and its V2 tree is a version
 *     mix (the factory references curve functions the vendored curve lacks), so these could not be compiled.
 *   - Items marked `docs-only` exist in the docs but not in the vendored source (deployed version is newer).
 *   - The scripts verify every selector they are about to SEND against the deployed bytecode
 *     (`lib/locker.ts#selectorPresentInCode`) and refuse to send when it is missing.
 *
 * `scripts/write_abis.ts` serialises these into abi/pons_v2_*.json.
 */
import { parseAbi } from "viem";

/** Shared struct fragments (parseAbi resolves struct names across the same array). */
const SOCIALS = "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }";
const TOKEN_PARAMS =
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }";
const LAUNCH_CONFIG =
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }";
const LAUNCHED_TOKEN =
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }";
const FEE_POLICY =
  "struct FeePolicySnapshot { address protocolFeeRecipient; uint16 protocolFeeShareBps; uint16 buybackBurnBps; uint16 hookFeeBps; uint16 maxInternalPriceImpactBps; }";

export const ponsV2FactoryHuman = [
  SOCIALS,
  TOKEN_PARAMS,
  LAUNCH_CONFIG,
  LAUNCHED_TOKEN,
  FEE_POLICY,
  // ---- reads ----
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function whitelistedLaunchers(address launcher) view returns (bool)",
  "function canLaunch(address launcher) view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function getLaunchFeePolicy(address token) view returns (FeePolicySnapshot)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)",
  "function pendingCreatorFeeRecipient(address token) view returns (address newRecipient, uint256 effectiveAt, uint256 expiresAt)",
  "function poolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function permit2() view returns (address)",
  "function locker() view returns (address)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function buybackVault() view returns (address)",
  "function graduationExecutor() view returns (address)",
  "function launchDeployer() view returns (address)",
  "function launchForwarder() view returns (address)",
  "function graduationGuard() view returns (address)",
  "function owner() view returns (address)",
  "function CREATOR_FEE_RECIPIENT_TIMELOCK() view returns (uint256)",
  "function GRADUATION_RESCUE_DELAY() view returns (uint256)",
  // ---- writes ----
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function launchTokenFor(TokenParams params, uint256 launchConfigId, address pairToken, address originalDeployer, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function transferCreatorFeeRecipient(address token, address newRecipient)",
  "function setBuybackEnabled(address token, bool enabled)",
  "function executeCreatorFeeRecipientChange(address token)",
  "function graduate(address token)",
  "function createGraduatedPool(address token) returns (uint256 positionId)",
  // ---- events ----
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)",
  "event LaunchForceSwept(address indexed token)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)",
  "event CreatorFeeRecipientChangeProposed(address indexed token, address indexed currentRecipient, address indexed proposedRecipient, uint256 effectiveAt, uint256 expiresAt)",
  "event CreatorFeeRecipientChangeCancelled(address indexed token, address indexed proposedRecipient)",
  "event BuybackEnabledUpdated(address indexed token, bool enabled, address indexed controller)",
  "event GraduationTokensPermanentlyLocked(address indexed token, uint256 amount)",
  "event LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)",
  "event LaunchConfigAdded(uint256 indexed id)",
  "event LaunchConfigUpdated(uint256 indexed id)",
  "event LaunchFeeUpdated(uint256 launchFee)",
  "event LaunchEnabledUpdated(bool enabled)",
  "event MaxCreatorTaxUpdated(uint256 bps)",
  "event SnipeTaxStartBpsUpdated(uint256 bps)",
  "event SnipeTaxSecondsUpdated(uint256 secondsWindow)",
  "event PairTokenApprovalUpdated(address indexed pairToken, bool approved)",
  // ---- errors ----
  "error InvalidLaunchConfigId()",
  "error LaunchConfigDisabled()",
  "error InvalidBasisPoints()",
  "error ExemptionListTooLong()",
  "error InvalidSnipeTaxWindow()",
  "error CurveFeeTooHigh()",
  "error CreatorTaxTooHigh()",
  "error CombinedFeeTooHigh()",
  "error SupplyTooLow()",
  "error SupplyTooHigh()",
  "error InvalidTickSpacing()",
  "error LaunchFeeNotPaid()",
  "error NotWhitelisted()",
  "error FeeTransferFailed()",
  "error ZeroAddress()",
  "error AlreadySet()",
  "error InvalidTokenParams()",
  "error TokenNotFound()",
  "error WrongGraduationPhase()",
  "error GraduationStillViable()",
  "error NothingToGraduate()",
  "error SqrtPriceOutOfBounds()",
  "error GraduationExecutorNotSet()",
  "error LaunchDeployerNotSet()",
  "error NotLaunchForwarder()",
  "error NotCreatorFeeRecipient()",
  "error NoPendingChange()",
  "error TimelockNotElapsed(uint256 effectiveAt)",
  "error TimelockExpired(uint256 expiresAt)",
  "error LaunchDependenciesNotWired()",
  "error PairTokenNotApproved()",
  "error PairTokenValidationFailed()",
  "error NotBuybackController()",
  "error CoreLpFeeMustBeZero()",
  "error InvalidGraduationThreshold()",
  "error InvalidPhantomQuote()",
  "error CurveNotQuotable()",
  "error PairTokenEconomicsInvalid()",
  "error PairTokenDecimalsMismatch(uint8 expected, uint8 actual)",
  "error PairTokenDecimalsUnavailable()",
  "error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual)",
  "error InexactTransfer(address token, uint256 expected, uint256 received)",
  "error GraduationSeedNotViable()",
  "error GraduationRescueTooEarly(uint256 availableAt)",
  "error NotReadyToGraduate()",
  "error OwnableUnauthorizedAccount(address account)",
  "error ReentrancyGuardReentrantCall()",
] as const;

export const ponsV2CurveHuman = [
  // ---- immutables / state (public getters) ----
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function deployer() view returns (address)",
  "function factory() view returns (address)",
  "function feePolicy() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function buybackVault() view returns (address)",
  "function protocolFeeRecipient() view returns (address)",
  "function buybackCreatorRecipient() view returns (address)",
  "function protocolFeeShareBps() view returns (uint16)",
  "function buybackBurnBps() view returns (uint16)",
  "function maxInternalPriceImpactBps() view returns (uint16)",
  "function phantomQuote() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function buybackEnabled() view returns (bool)",
  "function quoteFeeBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function trackedQuote() view returns (uint256)",
  "function trackedTokens() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function reservedTokens() view returns (uint256)",
  // ---- views ----
  "function isNativeQuote() view returns (bool)",
  "function sellableTokens() view returns (uint256)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function quoteReserve() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  // docs-only (deployed curve is newer than the vendored source)
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  // ---- writes ----
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  // ---- events ----
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveBuyRefunded(address indexed buyer, uint256 refund)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
  "event BuybackLocked(uint256 quoteSpent, uint256 tokensLocked)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "event Initialized(address token)",
  "event CreatorFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient)",
  "event BuybackEnabledUpdated(bool enabled)",
  "event AutoGraduationFailed(address indexed token, uint256 gasRemaining)",
  // ---- errors ----
  "error CurveGraduated()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error NotFactory()",
  "error TransferFailed()",
  "error AlreadyGraduated()",
  "error AlreadyInitialized()",
  "error NotInitialized()",
  "error InvalidLaunchEconomics()",
  "error NotReadyToGraduate()",
  "error NotFeeSweepOperator()",
  "error InternalSwapRequiresOperator()",
  "error InvalidFeePolicy()",
  "error MinimumOutputRequired()",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()",
  "error InsufficientInputAmount()",
  "error InsufficientLiquidity()",
  "error InsufficientOutputAmount()",
] as const;

/** IPonsV2FeeEscrow — official interface (contractsV2/src/v2/interfaces/ILaunchpadV2.sol) + docs "Claiming fees". */
export const ponsV2FeeEscrowHuman = [
  "function credit(address recipient) payable",
  "function creditToken(address recipient, address token, uint256 amount)",
  "function claim() returns (uint256 amount)",
  "function claim(uint256 amount) returns (uint256)",
  "function claimToken(address token) returns (uint256 amount)",
  "function claimToken(address token, uint256 amount) returns (uint256)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  // docs-only event names (not in the vendored interface)
  "event Credited(address indexed recipient, uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
  "event CreditedToken(address indexed recipient, address indexed token, uint256 amount)",
  "event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)",
] as const;

export const ponsV2HookHuman = [
  FEE_POLICY,
  "function currentFeePolicy() view returns (FeePolicySnapshot)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function buybackBurnBps() view returns (uint256)",
  "function hookFeeBps() view returns (uint256)",
  "function maxInternalPriceImpactBps() view returns (uint256)",
  "function protocolFeeRecipient() view returns (address)",
  "function feeSweepOperator() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function factory() view returns (address)",
  "function buybackVault() view returns (address)",
  "function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)",
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)",
  "function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)",
  "event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)",
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackSpent, uint256 creatorAmount, uint256 tokensLocked)",
  "event BuybackEnabledUpdated(bytes32 indexed poolId, bool enabled)",
  "event PoolBuybackSkipped(bytes32 indexed poolId, uint256 foldedBackQuote)",
  "event PoolConversionSkipped(bytes32 indexed poolId, uint256 retainedMemecoin)",
  "error UnknownPool()",
  "error NotFeeSweepOperator()",
  "error InternalSwapRequiresOperator()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error MinimumOutputRequired()",
] as const;

export const ponsV2TokenHuman = [
  SOCIALS,
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function burn(uint256 amount)",
  "function deployer() view returns (address)",
  "function launchFactory() view returns (address)",
  "function curve() view returns (address)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;

export const ponsV2BuybackVaultHuman = [
  "function VESTING_DURATION() view returns (uint256)",
  "function factory() view returns (address)",
  "function totalLocked(address token) view returns (uint256)",
  "function totalReleased(address token) view returns (uint256)",
  "function vestingStart(address token) view returns (uint256)",
  "function vestedAmount(address token) view returns (uint256)",
  "function releasable(address token) view returns (uint256)",
  "function vestingTerms(address token) view returns (address creatorRecipient, address protocolRecipient, uint16 protocolFeeShareBps)",
  "function release(address token) returns (uint256 released)",
  "event Locked(address indexed token, address indexed depositor, uint256 amount, uint256 newVestingStart)",
  "event Released(address indexed token, uint256 creatorAmount, uint256 protocolAmount)",
  "error NotVestBeneficiary()",
] as const;

export const ponsV2LockerHuman = [
  "function factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function isLocked(address token) view returns (bool)",
  "event PositionLocked(address indexed token, uint256 indexed tokenId)",
  "event TokenSupplyLocked(address indexed token, uint256 amount)",
] as const;

/** PonsV2LaunchAndBuy — docs-only (no source in the repo). UNVERIFIED. */
export const ponsV2LaunchAndBuyHuman = [
  SOCIALS,
  TOKEN_PARAMS,
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
] as const;

export const ponsV2FactoryAbi = parseAbi(ponsV2FactoryHuman);
export const ponsV2CurveAbi = parseAbi(ponsV2CurveHuman);
export const ponsV2FeeEscrowAbi = parseAbi(ponsV2FeeEscrowHuman);
export const ponsV2HookAbi = parseAbi(ponsV2HookHuman);
export const ponsV2TokenAbi = parseAbi(ponsV2TokenHuman);
export const ponsV2BuybackVaultAbi = parseAbi(ponsV2BuybackVaultHuman);
export const ponsV2LockerAbi = parseAbi(ponsV2LockerHuman);
export const ponsV2LaunchAndBuyAbi = parseAbi(ponsV2LaunchAndBuyHuman);

/** Canonical signatures the scripts verify against deployed bytecode before sending. */
export const V2_SIGNATURES = {
  launchToken:
    "launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)",
  launchTokenWithExemptions:
    "launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])",
  launchAndBuy:
    "launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])",
  curveBuy: "buy(uint256,uint256,address)",
  curveSweepFees: "sweepFees(uint256)",
  escrowClaim: "claim()",
  escrowClaimToken: "claimToken(address)",
  escrowBalanceOf: "balanceOf(address)",
  escrowBalanceOfToken: "balanceOfToken(address,address)",
  previewLaunchEconomics: "previewLaunchEconomics(uint256,address)",
  currentSnipeTaxBps: "currentSnipeTaxBps(address)",
} as const;

export enum GraduationPhase {
  NotGraduated = 0,
  Swept = 1,
  PoolCreated = 2,
  Rescued = 3,
}
export const GRADUATION_PHASE_NAMES = ["NotGraduated (trading on curve)", "Swept (curve drained, V4 pool pending)", "PoolCreated (graduated, trading on Uniswap V4)", "Rescued (terminal)"];
