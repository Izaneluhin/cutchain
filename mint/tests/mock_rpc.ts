/**
 * tests/mock_rpc.ts — a tiny JSON-RPC server that impersonates Robinhood Chain well enough to exercise
 * the ONLINE code paths of launch/pool/claim/status without touching a real network.
 *
 *   tsx tests/mock_rpc.ts            # listens on 127.0.0.1:8555 (MOCK_PORT to change)
 *   RPC_URL=http://127.0.0.1:8555 tsx launch.ts --name X --symbol Y --dry-run
 *
 * Responses are canned and ABI-encoded with the same ABIs the scripts use. It is NOT a chain
 * simulator: it does not validate anything, it just proves that decoding/encoding/event parsing work.
 */
import { createServer } from "node:http";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseEther,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ADDRESSES } from "../lib/config.js";
import { erc20Abi, nonfungiblePositionManagerAbi, ponsV1FactoryAbi, ponsV1TokenAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../lib/abis.js";
import {
  V2_SIGNATURES,
  ponsV2BuybackVaultAbi,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  ponsV2FeeEscrowAbi,
  ponsV2HookAbi,
  ponsV2LaunchAndBuyAbi,
  ponsV2LockerAbi,
  ponsV2TokenAbi,
} from "../lib/abis_v2.js";
import { getAmountOut, reservedTokensFor } from "../lib/curve.js";

const TOKEN: Address = "0x1111111111111111111111111111111111116bbb".replace("6bbb", "bbbb") as Address;
const POOL: Address = "0x2222222222222222222222222222222222222222";
const DEPLOYER: Address = "0x000000000000000000000000000000000000dEaD";
const LOCKER = ADDRESSES.PONS_LOCKER;
const SQRT_1E9 = 2505414483750479311864138015n; // price 0.001 t1/t0 style value, arbitrary but valid

const sel = (sig: string) => toFunctionSelector(`function ${sig}`);
const lower = (a: string) => a.toLowerCase();

function encodeFor(abi: readonly unknown[], functionName: string, result: unknown): Hex {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeFunctionResult({ abi, functionName, result } as any);
}

const launchConfig = {
  pairToken: ADDRESSES.WETH,
  graduationThreshold: parseEther("10"),
  initialTick: -230400,
  supply: parseEther("1000000000"),
  maxWalletBps: 200,
  maxTxBps: 220,
  restrictionBlocks: 2,
  reservedFee: 0,
  enabled: true,
  routerRequiresDeadline: false,
};
const dexConfig = {
  name: "Uniswap V3",
  factory: ADDRESSES.UNISWAP_V3_FACTORY,
  positionManager: ADDRESSES.NONFUNGIBLE_POSITION_MANAGER,
  swapRouter: ADDRESSES.SWAP_ROUTER_02,
  poolFee: 10000,
  tickSpacing: 200,
  enabled: true,
};
const launchedToken = {
  token: TOKEN,
  deployer: DEPLOYER,
  pairedToken: ADDRESSES.WETH,
  positionManager: ADDRESSES.NONFUNGIBLE_POSITION_MANAGER,
  positionId: 42n,
  dexId: 0n,
  launchConfigId: 0n,
  restrictionsEndBlock: 258n,
  supply: parseEther("1000000000"),
  isToken0: true,
  poolFee: 10000,
  exists: true,
  initialBuyAmount: 0n,
};

/** Locker "bytecode": a few PUSH4 selectors so claim.ts discovery has something to find. */
const LOCKER_CODE: Hex = ("0x6080604052" +
  ["claimFees(address)", "feeRedirects(address)", "protocolFeeRecipient()", "lockPosition(address)", "setFeeRedirect(address,address)"]
    .map((s) => "63" + sel(s).slice(2))
    .join("") +
  "00") as Hex;

/* ----------------------------------------------------------------------------------------------- */
/* Pons V2 fixtures                                                                                */
/* ----------------------------------------------------------------------------------------------- */
const V2_TOKEN: Address = "0x3333333333333333333333333333333333333333";
const V2_CURVE: Address = "0x4444444444444444444444444444444444444444";
const SNIPER: Address = "0x000000000000000000000000000000000000beef";
const V2_SUPPLY = parseEther("1000000000");
const V2_PHANTOM = parseEther("2");
const V2_THRESHOLD = parseEther("6");
const V2_RESERVED = reservedTokensFor(V2_SUPPLY, V2_PHANTOM, V2_THRESHOLD);
const v2Config = { supply: V2_SUPPLY, curveFeeBps: 100n, phantomQuote: V2_PHANTOM, graduationThreshold: V2_THRESHOLD, poolFee: 0, tickSpacing: 60, enabled: true };
const v2Policy = { protocolFeeRecipient: "0x5555555555555555555555555555555555555555" as Address, protocolFeeShareBps: 3000, buybackBurnBps: 5000, hookFeeBps: 100, maxInternalPriceImpactBps: 500 };
// curve state: 1.5 ETH raised so far, ~ part of the supply sold
const v2TrackedQuote = parseEther("1.5");
const v2QuoteReserve = V2_PHANTOM + v2TrackedQuote; // fee balances excluded for simplicity
const v2TokenReserve = (V2_PHANTOM * V2_SUPPLY) / v2QuoteReserve; // constant product
const v2Launched = {
  token: V2_TOKEN, curve: V2_CURVE, deployer: DEPLOYER, creatorFeeRecipient: DEPLOYER, pairToken: "0x0000000000000000000000000000000000000000" as Address,
  graduationThreshold: V2_THRESHOLD, poolFee: 0, tickSpacing: 60, creatorTaxBps: 100, buybackEnabled: true, phase: 0, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true,
};
const codeWith = (sigs: readonly string[]): Hex => ("0x6080604052" + sigs.map((s) => "63" + sel(s).slice(2)).join("") + "00") as Hex;
const V2_FACTORY_CODE = codeWith([V2_SIGNATURES.launchToken, V2_SIGNATURES.launchTokenWithExemptions, V2_SIGNATURES.previewLaunchEconomics, "launchFee()", "maxCreatorTaxBps()", "canLaunch(address)"]);
const V2_ESCROW_CODE = codeWith([V2_SIGNATURES.escrowClaim, "claim(uint256)", V2_SIGNATURES.escrowClaimToken, "claimToken(address,uint256)", V2_SIGNATURES.escrowBalanceOf, V2_SIGNATURES.escrowBalanceOfToken]);
const V2_CURVE_CODE = codeWith([V2_SIGNATURES.curveBuy, V2_SIGNATURES.curveSweepFees, V2_SIGNATURES.currentSnipeTaxBps]);
const V2_ROUTER_CODE = codeWith([V2_SIGNATURES.launchAndBuy]);

function ethCallV2(t: string, data: Hex, _from?: string): Hex | undefined {
  const zero = "0x0000000000000000000000000000000000000000";
  if (t === lower(ADDRESSES.PONS_V2_FACTORY)) {
    const { functionName, args } = decodeFunctionData({ abi: ponsV2FactoryAbi, data }) as unknown as { functionName: string; args: readonly unknown[] };
    const A = ponsV2FactoryAbi;
    switch (functionName) {
      case "launchFee": return encodeFor(A, functionName, parseEther("0.0005"));
      case "launchEnabled": return encodeFor(A, functionName, true);
      case "canLaunch": return encodeFor(A, functionName, true);
      case "maxCreatorTaxBps": return encodeFor(A, functionName, 500n); // below the source ceiling so the live guard is exercised
      case "snipeTaxStartBps": return encodeFor(A, functionName, 9900n);
      case "snipeTaxSeconds": return encodeFor(A, functionName, 5n);
      case "feeEscrow": return encodeFor(A, functionName, ADDRESSES.PONS_V2_FEE_ESCROW);
      case "memeHook": return encodeFor(A, functionName, ADDRESSES.PONS_V2_MEME_HOOK);
      case "locker": return encodeFor(A, functionName, ADDRESSES.PONS_V2_LAUNCH_LOCKER);
      case "buybackVault": return encodeFor(A, functionName, ADDRESSES.PONS_V2_BUYBACK_VAULT);
      case "launchDeployer": return encodeFor(A, functionName, ADDRESSES.PONS_V2_LAUNCH_DEPLOYER);
      case "launchConfigCount": return encodeFor(A, functionName, 1n);
      case "getLaunchConfig": return encodeFor(A, functionName, v2Config);
      case "previewLaunchEconomics": return encodeFor(A, functionName, keccak256("0x1234"));
      case "approvedPairTokens": return encodeFor(A, functionName, lower(args[0] as string) === lower(ADDRESSES.AMZN));
      case "pairTokenEconomics": return encodeFor(A, functionName, [parseEther("500"), parseEther("1500"), 18]);
      case "launchToken": return encodeFor(A, functionName, [V2_TOKEN, V2_CURVE]);
      case "getLaunchedToken": return encodeFor(A, functionName, lower(args[0] as string) === lower(V2_TOKEN) ? v2Launched : { ...v2Launched, exists: false });
      case "getLaunchFeePolicy": return encodeFor(A, functionName, v2Policy);
      case "pendingCreatorFeeRecipient": return encodeFor(A, functionName, [zero, 0n, 0n]);
    }
  }
  if (t === lower(ADDRESSES.PONS_V2_MEME_HOOK)) {
    const { functionName } = decodeFunctionData({ abi: ponsV2HookAbi, data }) as { functionName: string };
    const A = ponsV2HookAbi;
    switch (functionName) {
      case "currentFeePolicy": return encodeFor(A, functionName, v2Policy);
      case "hookFeeBps": return encodeFor(A, functionName, 100n);
      case "launches": return encodeFor(A, functionName, [true, false, V2_TOKEN, zero, DEPLOYER, DEPLOYER, v2Policy.protocolFeeRecipient, 100, 3000, 5000, 100, 500, true]);
      case "pendingFees": return encodeFor(A, functionName, parseEther("0.01"));
      case "pendingCreatorTax": return encodeFor(A, functionName, parseEther("0.002"));
      case "pendingBuyback": return encodeFor(A, functionName, 0n);
    }
  }
  if (t === lower(V2_CURVE)) {
    const { functionName, args } = decodeFunctionData({ abi: ponsV2CurveAbi, data }) as unknown as { functionName: string; args: readonly unknown[] };
    const A = ponsV2CurveAbi;
    switch (functionName) {
      case "token": return encodeFor(A, functionName, V2_TOKEN);
      case "pairToken": return encodeFor(A, functionName, zero);
      case "getReserves": return encodeFor(A, functionName, [v2QuoteReserve, v2TokenReserve]);
      case "reservedTokens": return encodeFor(A, functionName, V2_RESERVED);
      case "sellableTokens": return encodeFor(A, functionName, v2TokenReserve - V2_RESERVED);
      case "realQuoteReserve": return encodeFor(A, functionName, v2TrackedQuote);
      case "graduated": return encodeFor(A, functionName, false);
      case "readyToGraduate": return encodeFor(A, functionName, false);
      case "feeBps": return encodeFor(A, functionName, 100n);
      case "creatorTaxBps": return encodeFor(A, functionName, 100n);
      case "phantomQuote": return encodeFor(A, functionName, V2_PHANTOM);
      case "graduationThreshold": return encodeFor(A, functionName, V2_THRESHOLD);
      case "buybackEnabled": return encodeFor(A, functionName, true);
      case "quoteFeeBalance": return encodeFor(A, functionName, parseEther("0.015"));
      case "creatorTaxBalance": return encodeFor(A, functionName, parseEther("0.015"));
      case "buybackQuoteBalance": return encodeFor(A, functionName, 0n);
      case "protocolFeeShareBps": return encodeFor(A, functionName, 3000);
      // everyone is exempt except the designated "sniper" fixture address (…beef), so launcher dev buys read 0
      case "currentSnipeTaxBps": return encodeFor(A, functionName, lower(args[0] as string) === lower(SNIPER) ? 9900n : 0n);
      case "buy": {
        const quoteIn = args[0] as bigint;
        const net = quoteIn - (quoteIn * 200n) / 10_000n;
        return encodeFor(A, functionName, getAmountOut(net, v2QuoteReserve, v2TokenReserve, 0n));
      }
      case "sweepFees": return "0x";
    }
  }
  if (t === lower(ADDRESSES.PONS_V2_FEE_ESCROW)) {
    const { functionName } = decodeFunctionData({ abi: ponsV2FeeEscrowAbi, data }) as { functionName: string };
    const A = ponsV2FeeEscrowAbi;
    switch (functionName) {
      case "balanceOf": return encodeFor(A, functionName, parseEther("0.0421"));
      case "balanceOfToken": return encodeFor(A, functionName, 0n);
      case "claim": return encodeFor(A, functionName, parseEther("0.0421"));
      case "claimToken": return encodeFor(A, functionName, 0n);
    }
  }
  if (t === lower(ADDRESSES.PONS_V2_BUYBACK_VAULT)) {
    const { functionName } = decodeFunctionData({ abi: ponsV2BuybackVaultAbi, data }) as { functionName: string };
    const A = ponsV2BuybackVaultAbi;
    switch (functionName) {
      case "totalLocked": return encodeFor(A, functionName, parseEther("1234567"));
      case "totalReleased": return encodeFor(A, functionName, 0n);
      case "releasable": return encodeFor(A, functionName, parseEther("12"));
    }
  }
  if (t === lower(ADDRESSES.PONS_V2_LAUNCH_LOCKER)) {
    const { functionName } = decodeFunctionData({ abi: ponsV2LockerAbi, data }) as { functionName: string };
    if (functionName === "isLocked") return encodeFor(ponsV2LockerAbi, functionName, true);
  }
  if (t === lower(ADDRESSES.PONS_V2_LAUNCH_AND_BUY)) {
    const { functionName, args } = decodeFunctionData({ abi: ponsV2LaunchAndBuyAbi, data }) as unknown as { functionName: string; args: readonly unknown[] };
    if (functionName === "launchAndBuy") {
      const quoteIn = args[3] as bigint;
      return encodeFor(ponsV2LaunchAndBuyAbi, functionName, [V2_TOKEN, V2_CURVE, getAmountOut(quoteIn - (quoteIn * 200n) / 10_000n, V2_PHANTOM, V2_SUPPLY, 0n)]);
    }
  }
  if (t === lower(V2_TOKEN)) {
    const { functionName } = decodeFunctionData({ abi: ponsV2TokenAbi, data }) as { functionName: string };
    const A = ponsV2TokenAbi;
    switch (functionName) {
      case "name": return encodeFor(A, functionName, "Mock V2 Token");
      case "symbol": return encodeFor(A, functionName, "MV2");
      case "decimals": return encodeFor(A, functionName, 18);
      case "totalSupply": return encodeFor(A, functionName, V2_SUPPLY);
      case "balanceOf": return encodeFor(A, functionName, parseEther("1000"));
      case "allowance": return encodeFor(A, functionName, 0n);
      case "approve": return encodeFor(A, functionName, true);
      case "logo": return encodeFor(A, functionName, "ipfs://v2logo");
      case "description": return encodeFor(A, functionName, "mock v2");
      case "socials": return encodeFor(A, functionName, ["", "", "", "", ""]);
      case "curve": return encodeFor(A, functionName, V2_CURVE);
      case "deployer": return encodeFor(A, functionName, DEPLOYER);
    }
  }
  return undefined;
}

function ethCall(to: string, data: Hex, from?: string): Hex {
  const selector = data.slice(0, 10);
  const t = lower(to);
  const v2 = ethCallV2(t, data, from);
  if (v2 !== undefined) return v2;
  // ---- Pons factory ----
  if (t === lower(ADDRESSES.PONS_FACTORY) || t === lower(ADDRESSES.PONS_FACTORY_LEGACY)) {
    const { functionName, args } = decodeFunctionData({ abi: ponsV1FactoryAbi, data }) as unknown as { functionName: string; args: readonly unknown[] };
    const legacy = t === lower(ADDRESSES.PONS_FACTORY_LEGACY);
    switch (functionName) {
      case "launchFee": return encodeFor(ponsV1FactoryAbi, functionName, parseEther("0.0005"));
      case "launchEnabled": return encodeFor(ponsV1FactoryAbi, functionName, true);
      case "whitelistedLaunchers": return encodeFor(ponsV1FactoryAbi, functionName, false);
      case "locker": return encodeFor(ponsV1FactoryAbi, functionName, LOCKER);
      case "launchConfigCount": return encodeFor(ponsV1FactoryAbi, functionName, 1n);
      case "dexConfigCount": return encodeFor(ponsV1FactoryAbi, functionName, 1n);
      case "getLaunchConfig": return encodeFor(ponsV1FactoryAbi, functionName, launchConfig);
      case "getDexConfig": return encodeFor(ponsV1FactoryAbi, functionName, dexConfig);
      case "predictVanityTokenAddress": {
        const salt = args[3] as Hex;
        return encodeFor(ponsV1FactoryAbi, functionName, [salt, TOKEN]);
      }
      case "launchToken": return encodeFor(ponsV1FactoryAbi, functionName, TOKEN);
      case "getLaunchedToken":
        return encodeFor(ponsV1FactoryAbi, functionName, legacy ? { ...launchedToken, exists: false } : launchedToken);
      case "graduationStatus": return encodeFor(ponsV1FactoryAbi, functionName, [parseEther("1.5"), parseEther("10"), false]);
    }
  }
  // ---- NPM ----
  if (t === lower(ADDRESSES.NONFUNGIBLE_POSITION_MANAGER)) {
    const { functionName } = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data });
    switch (functionName) {
      case "createAndInitializePoolIfNecessary": return encodeFor(nonfungiblePositionManagerAbi, functionName, POOL);
      case "mint": return encodeFor(nonfungiblePositionManagerAbi, functionName, [7n, 31622776601683793320037n, parseEther("1000000"), parseEther("1000")]);
      case "collect": return encodeFor(nonfungiblePositionManagerAbi, functionName, [parseEther("12345"), parseEther("0.25")]);
      case "ownerOf": return encodeFor(nonfungiblePositionManagerAbi, functionName, LOCKER);
      case "positions":
        return encodeFor(nonfungiblePositionManagerAbi, functionName, [0n, "0x0000000000000000000000000000000000000000", TOKEN, ADDRESSES.WETH, 10000, -230400, 887200, 10n ** 24n, 0n, 0n, 0n, 0n]);
    }
  }
  // ---- Uniswap V3 factory ----
  if (t === lower(ADDRESSES.UNISWAP_V3_FACTORY)) {
    const { functionName } = decodeFunctionData({ abi: uniswapV3FactoryAbi, data });
    if (functionName === "getPool") return encodeFor(uniswapV3FactoryAbi, functionName, "0x0000000000000000000000000000000000000000");
    if (functionName === "feeAmountTickSpacing") return encodeFor(uniswapV3FactoryAbi, functionName, 200);
  }
  // ---- pool ----
  if (t === lower(POOL)) {
    const { functionName } = decodeFunctionData({ abi: uniswapV3PoolAbi, data });
    switch (functionName) {
      case "slot0": return encodeFor(uniswapV3PoolAbi, functionName, [SQRT_1E9, -69082, 0, 1, 1, 0, true]);
      case "liquidity": return encodeFor(uniswapV3PoolAbi, functionName, 10n ** 24n);
      case "token0": return encodeFor(uniswapV3PoolAbi, functionName, TOKEN);
      case "token1": return encodeFor(uniswapV3PoolAbi, functionName, ADDRESSES.WETH);
    }
  }
  // ---- Pons token (mock) ----
  if (t === lower(TOKEN) && ponsV1TokenAbi.some((f) => f.type === "function" && toFunctionSelector(f) === selector)) {
    const { functionName } = decodeFunctionData({ abi: ponsV1TokenAbi, data }) as { functionName: string };
    switch (functionName) {
      case "name": return encodeFor(ponsV1TokenAbi, functionName, "Mock Pons Token");
      case "symbol": return encodeFor(ponsV1TokenAbi, functionName, "MOCK");
      case "decimals": return encodeFor(ponsV1TokenAbi, functionName, 18);
      case "totalSupply": return encodeFor(ponsV1TokenAbi, functionName, parseEther("1000000000"));
      case "logo": return encodeFor(ponsV1TokenAbi, functionName, "ipfs://logo");
      case "description": return encodeFor(ponsV1TokenAbi, functionName, "mock");
      case "socials": return encodeFor(ponsV1TokenAbi, functionName, ["", "", "", "", ""]);
      case "liquidityPool": return encodeFor(ponsV1TokenAbi, functionName, POOL);
      case "restrictionEndBlock": return encodeFor(ponsV1TokenAbi, functionName, 258n);
      case "balanceOf": return encodeFor(ponsV1TokenAbi, functionName, parseEther("999000000"));
      case "allowance": return encodeFor(erc20Abi, functionName, 0n);
    }
  }
  // ---- generic ERC20 (AMZN, WETH, anything else) ----
  try {
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
    switch (functionName) {
      case "decimals": return encodeFor(erc20Abi, functionName, 18);
      case "symbol": return encodeFor(erc20Abi, functionName, lower(to) === lower(ADDRESSES.AMZN) ? "AMZN" : lower(to) === lower(ADDRESSES.WETH) ? "WETH" : "TKN");
      case "name": return encodeFor(erc20Abi, functionName, "Mock ERC20");
      case "balanceOf": return encodeFor(erc20Abi, functionName, parseEther("1000000000"));
      case "allowance": return encodeFor(erc20Abi, functionName, 0n);
      case "approve": return encodeFor(erc20Abi, functionName, true);
      case "totalSupply": return encodeFor(erc20Abi, functionName, parseEther("1000000000"));
    }
  } catch {
    /* fallthrough */
  }
  // ---- locker: any claim candidate "succeeds" with empty return ----
  if (t === lower(LOCKER)) return "0x";
  throw Object.assign(new Error(`mock: no handler for ${to} ${selector}`), { code: -32000 });
}

let txCounter = 0;
const receipts = new Map<string, unknown>();

function handle(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId": return toHex(4663);
    case "eth_blockNumber": return toHex(256);
    case "eth_gasPrice": return toHex(100_000_000n);
    case "eth_maxPriorityFeePerGas": return toHex(0n);
    case "eth_estimateGas": return toHex(2_000_000);
    case "eth_getTransactionCount": return toHex(txCounter);
    case "eth_getCode": {
      const a = lower(String(params[0] as string));
      if (a === lower(LOCKER)) return LOCKER_CODE;
      if (a === lower(ADDRESSES.PONS_V2_FACTORY)) return V2_FACTORY_CODE;
      if (a === lower(ADDRESSES.PONS_V2_FEE_ESCROW)) return V2_ESCROW_CODE;
      if (a === lower(V2_CURVE)) return V2_CURVE_CODE;
      if (a === lower(ADDRESSES.PONS_V2_LAUNCH_AND_BUY)) return V2_ROUTER_CODE;
      return "0x6080";
    }
    case "eth_getBlockByNumber":
      return { number: toHex(256), baseFeePerGas: toHex(100_000_000n), gasLimit: toHex(32_000_000), timestamp: toHex(Math.floor(Date.now() / 1000)), hash: keccak256("0x01"), transactions: [] };
    case "eth_call": {
      const p = params[0] as { to: string; data: Hex; from?: string };
      return ethCall(p.to, p.data, p.from);
    }
    case "eth_sendRawTransaction": {
      const hash = keccak256(params[0] as Hex);
      txCounter++;
      // fake a receipt with a TokenLaunched + PoolCreated + IncreaseLiquidity log so parsers have something
      const topicsLaunched = encodeEventTopics({ abi: ponsV1FactoryAbi, eventName: "TokenLaunched", args: { token: TOKEN, deployer: DEPLOYER, dexFactory: ADDRESSES.UNISWAP_V3_FACTORY } as never });
      const dataLaunched = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [ADDRESSES.WETH, POOL, 0n, 0n, 42n, 258n, 0n],
      );
      const topicsInc = encodeEventTopics({ abi: nonfungiblePositionManagerAbi, eventName: "IncreaseLiquidity", args: { tokenId: 7n } });
      const dataInc = encodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], [31622776601683793320037n, parseEther("1000000"), parseEther("1000")]);
      const topicsV2 = encodeEventTopics({ abi: ponsV2FactoryAbi, eventName: "TokenLaunched", args: { token: V2_TOKEN, curve: V2_CURVE, deployer: DEPLOYER } });
      const dataV2 = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], ["0x0000000000000000000000000000000000000000", 0n, V2_THRESHOLD]);
      const topicsBuy = encodeEventTopics({ abi: ponsV2CurveAbi, eventName: "CurveBuy", args: { buyer: DEPLOYER, recipient: DEPLOYER } });
      const dataBuy = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [parseEther("0.01"), parseEther("4975124"), parseEther("0.0001"), parseEther("0.0001")]);
      const mk = (address: Address, topics: readonly (Hex | Hex[] | null)[], data: Hex, i: number) => ({
        address, topics, data, blockNumber: toHex(257), transactionHash: hash, transactionIndex: "0x0", blockHash: keccak256("0x02"), logIndex: toHex(i), removed: false,
      });
      receipts.set(hash, {
        transactionHash: hash, transactionIndex: "0x0", blockHash: keccak256("0x02"), blockNumber: toHex(257), from: DEPLOYER, to: ADDRESSES.PONS_FACTORY,
        cumulativeGasUsed: toHex(1_500_000), gasUsed: toHex(1_500_000), effectiveGasPrice: toHex(100_000_000n), status: "0x1", type: "0x2", contractAddress: null,
        logsBloom: "0x" + "0".repeat(512),
        logs: [
          mk(ADDRESSES.PONS_FACTORY, topicsLaunched, dataLaunched, 0),
          mk(ADDRESSES.NONFUNGIBLE_POSITION_MANAGER, topicsInc, dataInc, 1),
          mk(ADDRESSES.PONS_V2_FACTORY, topicsV2, dataV2, 2),
          mk(V2_CURVE, topicsBuy, dataBuy, 3),
        ],
      });
      return hash;
    }
    case "eth_getTransactionReceipt": return receipts.get(params[0] as string) ?? null;
    case "eth_getTransactionByHash": return null;
    default:
      throw Object.assign(new Error(`mock: unsupported method ${method}`), { code: -32601 });
  }
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (obj: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    try {
      const msg = JSON.parse(body);
      const one = (m: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: m.id, result: handle(m.method, m.params ?? []) };
        } catch (e) {
          const err = e as { message: string; code?: number };
          return { jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32000, message: err.message } };
        }
      };
      reply(Array.isArray(msg) ? msg.map(one) : one(msg));
    } catch (e) {
      reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e) } });
    }
  });
});

const PORT = Number(process.env.MOCK_PORT ?? 8555);
server.listen(PORT, "127.0.0.1", () => console.log(`mock Robinhood Chain RPC on http://127.0.0.1:${PORT} (V1 token ${TOKEN}, pool ${POOL}; V2 token ${V2_TOKEN}, curve ${V2_CURVE})`));
