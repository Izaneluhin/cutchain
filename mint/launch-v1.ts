#!/usr/bin/env tsx
/**
 * launch.ts — launch a fixed-supply memecoin on Pons v1 (Robinhood Chain).
 *
 *   tsx launch.ts --name CutTest --symbol CUTT [--image ipfs://... | https://...] [--description "..."]
 *                 [--twitter URL] [--telegram URL] [--discord URL] [--website URL] [--farcaster URL]
 *                 [--fee-wallet 0x...]      creator-fee payout wallet (default: sender)
 *                 [--initial-buy 0.01]      extra ETH swapped into the token in the same tx (default 0)
 *                 [--launch-config N]       factory launch preset id (default: auto = first enabled WETH preset)
 *                 [--dex-id N]              factory DEX profile id  (default: auto = first enabled Uniswap V3 profile)
 *                 [--salt 0x...]            bytes32 salt search start (default: random)
 *                 [--from 0x...]            simulate as this address when no PRIVATE_KEY is set
 *                 [--skip-predict]          do not precompute the vanity salt off-chain (NOT recommended)
 *                 [--dry-run]               print + simulate only, send nothing
 *
 * What one successful `launchToken` call does on-chain (verified against
 * contractsV1/src/PonsLaunchFactory.sol, github.com/ponsdotdev/ponsfamily):
 *   1. checks launchEnabled || whitelistedLaunchers[msg.sender]
 *   2. requires msg.value >= launchFee()   (docs: 0.0005 ETH; read live here)
 *   3. resolves a CREATE2 salt so the token address ends in 0xbbbb
 *   4. forwards launchFee to locker.protocolFeeRecipient()
 *   5. CREATE2-deploys PonsLauncherToken (full supply minted to the factory)
 *   6. NonfungiblePositionManager.createAndInitializePoolIfNecessary(token, pairToken, poolFee, sqrtPrice(initialTick))
 *   7. mints ONE one-sided full-supply position (token side only), recipient = factory
 *   8. transfers the position NFT to the locker + locker.lockPosition(token) (+ setFeeRedirect if fee wallet given)
 *   9. emits TokenLaunched(token, deployer, dexFactory, pairToken, pool, dexId, launchConfigId, positionId, restrictionsEndBlock, initialBuyAmount)
 *  10. if msg.value > launchFee: swaps the remainder into the token via the DEX swap router (creator "dev buy")
 */
import { formatEther, parseEther, parseEventLogs, toHex, type Address, type Hex, decodeFunctionResult, encodeFunctionData } from "viem";
import { randomBytes } from "node:crypto";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import {
  ADDRESSES,
  LAUNCH_FEE_DOCS,
  PLACEHOLDER_SENDER,
  explorer,
  getPublicClient,
  getWalletClient,
  hr,
  isAddress,
  probeRpc,
  requireAddress,
  shortError,
} from "./lib/config.js";
import { ponsV1FactoryAbi } from "./lib/abis.js";
import { describeRevert, planAndMaybeSend, tryRead } from "./lib/tx.js";

const HELP = `
launch.ts — launch a token on Pons v1 (factory ${ADDRESSES.PONS_FACTORY})

  --name <str>            token name (required)
  --symbol <str>          token symbol (required)
  --image <url>           logo URL / ipfs:// (stored on-chain as string "logo")
  --description <str>     stored on-chain
  --twitter/--telegram/--discord/--website/--farcaster <url>
  --fee-wallet <0x>       creator fee recipient (default: sender; also receives the initial buy)
  --initial-buy <eth>     extra ETH swapped into the token in the launch tx (default 0)
  --launch-config <n>     preset id (default: auto-detect first enabled WETH preset, offline fallback 0)
  --dex-id <n>            DEX profile id (default: auto-detect Uniswap V3 profile, offline fallback 0)
  --salt <0x32bytes>      salt search start (default random)
  --from <0x>             simulation sender when PRIVATE_KEY is absent
  --skip-predict          skip off-chain vanity-salt precompute (factory then searches on-chain: very gas heavy)
  --dry-run               print calldata + simulate, send nothing
`;

interface DexConfig {
  name: string;
  factory: Address;
  positionManager: Address;
  swapRouter: Address;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}
interface LaunchConfig {
  pairToken: Address;
  graduationThreshold: bigint;
  initialTick: number;
  supply: bigint;
  maxWalletBps: number;
  maxTxBps: number;
  restrictionBlocks: number;
  reservedFee: number;
  enabled: boolean;
  routerRequiresDeadline: boolean;
}

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const dryRun = has(args, "dry-run");

  const name = req(args, "name");
  const symbol = req(args, "symbol");
  const feeWalletRaw = opt(args, "fee-wallet", process.env.FEE_WALLET);
  const feeWallet: Address = feeWalletRaw ? requireAddress(feeWalletRaw, "--fee-wallet") : "0x0000000000000000000000000000000000000000";
  const initialBuy = parseEther(opt(args, "initial-buy", "0")!);

  const params = {
    name,
    symbol,
    logo: opt(args, "image", "") ?? "",
    description: opt(args, "description", "") ?? "",
    socials: {
      twitter: opt(args, "twitter", "") ?? "",
      telegram: opt(args, "telegram", "") ?? "",
      discord: opt(args, "discord", "") ?? "",
      website: opt(args, "website", "") ?? "",
      farcaster: opt(args, "farcaster", "") ?? "",
    },
    feeWallet,
  };

  hr(`Pons v1 launch ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`token   : ${name} (${symbol})`);
  console.log(`logo    : ${params.logo || "(none)"}`);
  console.log(`factory : ${ADDRESSES.PONS_FACTORY}  ${explorer.address(ADDRESSES.PONS_FACTORY)}`);

  const client = getPublicClient();
  const walletInfo = getWalletClient();
  const fromArg = opt(args, "from");
  const from: Address = walletInfo?.address ?? (isAddress(fromArg) ? fromArg : PLACEHOLDER_SENDER);
  console.log(`sender  : ${from}${walletInfo ? "" : "  (no PRIVATE_KEY — placeholder / --from)"}`);
  if (!dryRun && !walletInfo) throw new Error("PRIVATE_KEY is required unless --dry-run");

  const chainId = await probeRpc(client);
  const online = chainId !== null;
  console.log(`rpc     : ${online ? `online (chain ${chainId})` : "OFFLINE — calldata only"}`);

  /* ---------------------------------------------------------------- */
  /* 1. Live factory state                                            */
  /* ---------------------------------------------------------------- */
  let launchFee = LAUNCH_FEE_DOCS;
  let launchConfigId = BigInt(opt(args, "launch-config", "0")!);
  let dexId = BigInt(opt(args, "dex-id", "0")!);
  let launchConfig: LaunchConfig | undefined;
  let dexConfig: DexConfig | undefined;

  if (online) {
    hr("Factory state");
    const f = { address: ADDRESSES.PONS_FACTORY, abi: ponsV1FactoryAbi } as const;
    const liveFee = await tryRead("launchFee", () => client.readContract({ ...f, functionName: "launchFee" }) as Promise<bigint>);
    if (liveFee !== undefined) launchFee = liveFee;
    const enabled = await tryRead("launchEnabled", () => client.readContract({ ...f, functionName: "launchEnabled" }) as Promise<boolean>);
    const whitelisted = await tryRead("whitelistedLaunchers", () =>
      client.readContract({ ...f, functionName: "whitelistedLaunchers", args: [from] }) as Promise<boolean>,
    );
    const locker = await tryRead("locker", () => client.readContract({ ...f, functionName: "locker" }) as Promise<Address>);
    console.log(`  launchFee        : ${formatEther(launchFee)} ETH ${liveFee === undefined ? "(docs value, live read failed)" : "(live)"}`);
    console.log(`  launchEnabled    : ${enabled}   whitelisted(sender): ${whitelisted}`);
    console.log(`  locker           : ${locker}${locker && locker.toLowerCase() !== ADDRESSES.PONS_LOCKER.toLowerCase() ? "  ! differs from CHAIN.md locker" : ""}`);
    if (enabled === false && whitelisted === false) {
      console.log("  ! launches are currently gated (launchEnabled=false) and this sender is not whitelisted → launchToken will revert NotWhitelisted()");
    }

    const lcCount = Number((await tryRead("launchConfigCount", () => client.readContract({ ...f, functionName: "launchConfigCount" }) as Promise<bigint>)) ?? 0n);
    const dxCount = Number((await tryRead("dexConfigCount", () => client.readContract({ ...f, functionName: "dexConfigCount" }) as Promise<bigint>)) ?? 0n);

    const launchConfigs: LaunchConfig[] = [];
    for (let i = 0; i < lcCount; i++) {
      const c = (await client.readContract({ ...f, functionName: "getLaunchConfig", args: [BigInt(i)] })) as LaunchConfig;
      launchConfigs.push(c);
      console.log(
        `  launchConfig[${i}] : pair=${c.pairToken} supply=${formatEther(c.supply)} initialTick=${c.initialTick} ` +
          `maxWallet=${c.maxWalletBps}bps maxTx=${c.maxTxBps}bps restrictionBlocks=${c.restrictionBlocks} enabled=${c.enabled}`,
      );
    }
    const dexConfigs: DexConfig[] = [];
    for (let i = 0; i < dxCount; i++) {
      const d = (await client.readContract({ ...f, functionName: "getDexConfig", args: [BigInt(i)] })) as DexConfig;
      dexConfigs.push(d);
      console.log(
        `  dexConfig[${i}]    : ${d.name} factory=${d.factory} npm=${d.positionManager} router=${d.swapRouter} fee=${d.poolFee} spacing=${d.tickSpacing} enabled=${d.enabled}`,
      );
    }

    // Auto-select: first enabled launch config paired with WETH; first enabled DEX using the known Uniswap V3 factory.
    if (!args.values.has("launch-config") && launchConfigs.length) {
      const idx = launchConfigs.findIndex((c) => c.enabled && c.pairToken.toLowerCase() === ADDRESSES.WETH.toLowerCase());
      launchConfigId = BigInt(idx >= 0 ? idx : Math.max(0, launchConfigs.findIndex((c) => c.enabled)));
    }
    if (!args.values.has("dex-id") && dexConfigs.length) {
      const idx = dexConfigs.findIndex((d) => d.enabled && d.factory.toLowerCase() === ADDRESSES.UNISWAP_V3_FACTORY.toLowerCase());
      dexId = BigInt(idx >= 0 ? idx : Math.max(0, dexConfigs.findIndex((d) => d.enabled)));
    }
    launchConfig = launchConfigs[Number(launchConfigId)];
    dexConfig = dexConfigs[Number(dexId)];
    console.log(`  selected         : launchConfigId=${launchConfigId} dexId=${dexId}`);
    if (launchConfig && !launchConfig.enabled) console.log("  ! selected launch config is disabled");
    if (dexConfig && !dexConfig.enabled) console.log("  ! selected DEX config is disabled");
  } else {
    console.log(`\n! offline: using launchConfigId=${launchConfigId}, dexId=${dexId} (UNVERIFIED defaults) and docs launch fee ${formatEther(launchFee)} ETH`);
  }

  /* ---------------------------------------------------------------- */
  /* 2. Vanity salt (token address must end in 0xbbbb)                */
  /* ---------------------------------------------------------------- */
  hr("Salt / predicted address");
  let salt: Hex = (opt(args, "salt") as Hex | undefined) ?? toHex(randomBytes(32));
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("--salt must be a 32-byte hex value");
  let predictedToken: Address | undefined;

  if (online && !has(args, "skip-predict")) {
    // The factory loops over salts on-chain until CREATE2(salt) ends in 0xbbbb (~65k iterations on average).
    // Doing that inside the launch tx would burn tens of millions of gas, so we do exactly what the UI must do:
    // ask the factory (eth_call, free) for the resolved salt and pass THAT as `salt`, so the on-chain loop exits
    // on its first iteration. The prediction depends on msg.sender, so it must be computed for the real sender.
    for (let attempt = 1; attempt <= 3 && !predictedToken; attempt++) {
      try {
        const data = encodeFunctionData({
          abi: ponsV1FactoryAbi,
          functionName: "predictVanityTokenAddress",
          args: [params, launchConfigId, dexId, salt, from],
        });
        const { data: ret } = await client.call({ to: ADDRESSES.PONS_FACTORY, data, account: from });
        if (!ret) throw new Error("empty return");
        const [deploySalt, token] = decodeFunctionResult({
          abi: ponsV1FactoryAbi,
          functionName: "predictVanityTokenAddress",
          data: ret,
        }) as [Hex, Address];
        console.log(`  saltStart        : ${salt}`);
        salt = deploySalt;
        predictedToken = token;
        console.log(`  deploySalt       : ${salt}`);
        console.log(`  predicted token  : ${token}  ${token.toLowerCase().endsWith("bbbb") ? "(ends in bbbb ✓)" : "(! does not end in bbbb)"}`);
      } catch (err) {
        console.log(`  predictVanityTokenAddress attempt ${attempt} failed: ${describeRevert(err)}`);
        salt = toHex(randomBytes(32));
      }
    }
    if (!predictedToken && !dryRun) {
      throw new Error("could not precompute the vanity salt; refusing to send (pass --skip-predict to let the factory search on-chain — expect a very high gas bill)");
    }
  } else {
    console.log(`  salt             : ${salt} (search start; factory resolves the 0xbbbb salt on-chain)`);
    if (!online) console.log("  predicted token  : unavailable offline");
  }

  /* ---------------------------------------------------------------- */
  /* 3. Build + simulate + send                                       */
  /* ---------------------------------------------------------------- */
  const value = launchFee + initialBuy;
  hr("Transaction");
  console.log(`  launch fee ${formatEther(launchFee)} ETH + initial buy ${formatEther(initialBuy)} ETH = value ${formatEther(value)} ETH`);
  if (feeWallet !== "0x0000000000000000000000000000000000000000") console.log(`  fee wallet ${feeWallet} (locker.setFeeRedirect is called by the factory)`);

  const result = await planAndMaybeSend(
    { client, rpcOnline: online, dryRun, from, wallet: walletInfo?.wallet },
    {
      label: "PonsLaunchFactory.launchToken(params, launchConfigId, dexId, salt)",
      address: ADDRESSES.PONS_FACTORY,
      abi: ponsV1FactoryAbi,
      functionName: "launchToken",
      args: [params, launchConfigId, dexId, salt],
      value,
    },
  );

  if (dryRun) {
    hr("Dry run summary");
    console.log(`  would send ${formatEther(value)} ETH to ${ADDRESSES.PONS_FACTORY}`);
    console.log(`  simulated token  : ${result.simulationResult ?? predictedToken ?? "n/a"}`);
    if (launchConfig) {
      console.log(`  pool             : ${launchConfig.pairToken === ADDRESSES.WETH ? "WETH" : launchConfig.pairToken} / ${symbol} fee ${dexConfig?.poolFee ?? "?"} on ${dexConfig?.name ?? "?"}`);
      console.log(`  supply           : ${formatEther(launchConfig.supply)} ${symbol} (all in the locked LP position)`);
    }
    return;
  }

  /* ---------------------------------------------------------------- */
  /* 4. Parse TokenLaunched                                           */
  /* ---------------------------------------------------------------- */
  hr("Launched");
  const receipt = result.receipt!;
  const events = parseEventLogs({ abi: ponsV1FactoryAbi, logs: receipt.logs, eventName: "TokenLaunched" });
  if (!events.length) {
    console.log("  ! no TokenLaunched event found in receipt — inspect the tx on the explorer");
    console.log(`  tx: ${explorer.tx(receipt.transactionHash)}`);
    return;
  }
  const ev = events[0].args as {
    token: Address;
    deployer: Address;
    dexFactory: Address;
    pairToken: Address;
    pool: Address;
    dexId: bigint;
    launchConfigId: bigint;
    positionId: bigint;
    restrictionsEndBlock: bigint;
    initialBuyAmount: bigint;
  };
  console.log(`  token            : ${ev.token}`);
  console.log(`                     ${explorer.token(ev.token)}`);
  console.log(`                     ${explorer.robinscanAddress(ev.token)}`);
  console.log(`  pool (V3)        : ${ev.pool}`);
  console.log(`                     ${explorer.address(ev.pool)}`);
  console.log(`  pair token       : ${ev.pairToken}`);
  console.log(`  position NFT id  : ${ev.positionId} (held by the locker)`);
  console.log(`  restrictions end : block ${ev.restrictionsEndBlock}`);
  console.log(`  initial buy      : ${formatEther(ev.initialBuyAmount)} ETH`);
  console.log(`  tx               : ${explorer.tx(receipt.transactionHash)}`);
  console.log(`\nNext: tsx status.ts --token ${ev.token}`);
}

main().catch((err) => {
  console.error(`\nERROR: ${shortError(err)}`);
  process.exit(1);
});
