#!/usr/bin/env tsx
/**
 * claim.ts — claim accrued creator fees for a Pons v1 token from the locker.
 *
 *   tsx claim.ts --token 0x...bbbb [--sig "claimFees(address)"] [--locker 0x...] [--from 0x...] [--force] [--dry-run]
 *
 * STATUS: the locker's claim function is NOT VERIFIED (no public ABI/source for
 * 0x736D76699C26D0d966744cAe304C000d471f7F35 could be retrieved — see CHAIN.md).
 * This script therefore:
 *   1. reads everything it can through VERIFIED paths (factory launch record, NPM position, simulated
 *      NPM.collect as the locker → gross uncollected fees, 70% creator estimate),
 *   2. probes the locker bytecode for candidate claim selectors and prints which ones exist,
 *   3. builds calldata for `--sig` (or LOCKER_CLAIM_SIGNATURE, or the single discovered candidate,
 *      or the UNVERIFIED default `claimFees(address)`),
 *   4. simulates it, and only sends when NOT --dry-run AND the selector was found in the locker
 *      bytecode (or --force) AND the simulation succeeded.
 *
 * Once the real signature is known, put it in .env as LOCKER_CLAIM_SIGNATURE and drop the guesswork.
 */
import { formatEther, formatUnits, parseAbiItem, type Abi, type Address } from "viem";
import { has, opt, parseArgs, req, usage } from "./lib/cli.js";
import {
  ADDRESSES,
  CREATOR_FEE_SHARE_BPS,
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
import { erc20Abi, ponsV1FactoryAbi, ponsV1LockerKnownAbi, ponsV1TokenAbi } from "./lib/abis.js";
import { probeLockerSelectors, readUncollectedFees } from "./lib/locker.js";
import { planAndMaybeSend, tryRead } from "./lib/tx.js";

const DEFAULT_SIG = "claimFees(address)";

const HELP = `
claim.ts — claim creator LP fees from the Pons locker (claim function UNVERIFIED, see README)

  --token <0x>     Pons token address (required)
  --sig <sig>      claim function signature, e.g. "claimFees(address)" or "claim()" (default: env LOCKER_CLAIM_SIGNATURE,
                   else the single candidate found in the locker bytecode, else "${DEFAULT_SIG}" marked UNVERIFIED)
  --locker <0x>    override locker (default: factory.locker() when online, else CHAIN.md value)
  --from <0x>      simulation sender when PRIVATE_KEY is absent
  --force          send even if the selector was not found in the locker bytecode (NOT recommended)
  --dry-run        print calldata + simulate, send nothing
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

function buildClaimAbi(sig: string): { abi: Abi; functionName: string; argKinds: string[] } {
  const item = parseAbiItem(`function ${sig}`);
  if (item.type !== "function") throw new Error("--sig must be a function signature");
  const argKinds = item.inputs.map((i) => i.type);
  for (const t of argKinds) if (t !== "address" && t !== "uint256") throw new Error(`unsupported param type ${t} in --sig`);
  return { abi: [item] as Abi, functionName: item.name, argKinds };
}

async function main() {
  const args = parseArgs();
  if (has(args, "help")) usage(HELP);
  const dryRun = has(args, "dry-run");
  const token = requireAddress(req(args, "token"), "--token");

  const client = getPublicClient();
  const walletInfo = getWalletClient();
  const fromArg = opt(args, "from");
  const from: Address = walletInfo?.address ?? (isAddress(fromArg) ? fromArg : PLACEHOLDER_SENDER);
  if (!dryRun && !walletInfo) throw new Error("PRIVATE_KEY is required unless --dry-run");

  hr(`Pons creator fee claim ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
  const chainId = await probeRpc(client);
  const online = chainId !== null;
  console.log(`rpc     : ${online ? `online (chain ${chainId})` : "OFFLINE — calldata only"}`);
  console.log(`token   : ${token}  ${explorer.token(token)}`);
  console.log(`sender  : ${from}${walletInfo ? "" : "  (no PRIVATE_KEY — placeholder / --from)"}`);

  /* ------------------------------------------------------------ */
  /* locker + launch record                                       */
  /* ------------------------------------------------------------ */
  let locker: Address = requireAddress(opt(args, "locker", ADDRESSES.PONS_LOCKER), "--locker");
  let launched: LaunchedToken | undefined;
  let positionOwner: Address | undefined;
  if (online) {
    hr("Launch record");
    for (const factory of [ADDRESSES.PONS_FACTORY, ADDRESSES.PONS_FACTORY_LEGACY]) {
      const rec = await tryRead(`getLaunchedToken@${factory}`, () =>
        client.readContract({ address: factory, abi: ponsV1FactoryAbi, functionName: "getLaunchedToken", args: [token] }) as Promise<LaunchedToken>,
      );
      if (rec?.exists) {
        launched = rec;
        if (!args.values.has("locker")) {
          const l = await tryRead("factory.locker", () => client.readContract({ address: factory, abi: ponsV1FactoryAbi, functionName: "locker" }) as Promise<Address>);
          if (l) locker = l;
        }
        console.log(`  factory       : ${factory}${factory === ADDRESSES.PONS_FACTORY_LEGACY ? " (LEGACY 90/10 factory)" : ""}`);
        break;
      }
    }
    if (!launched) {
      console.log("  ! token not found in the active or legacy Pons factory (getLaunchedToken.exists = false)");
    } else {
      console.log(`  deployer      : ${launched.deployer}${launched.deployer.toLowerCase() === from.toLowerCase() ? " (= sender)" : "  ! sender is not the deployer"}`);
      console.log(`  position NFT  : #${launched.positionId} on ${launched.positionManager}`);
      positionOwner = await tryRead("ownerOf", () =>
        client.readContract({ address: launched!.positionManager, abi: [parseAbiItem("function ownerOf(uint256) view returns (address)")], functionName: "ownerOf", args: [launched!.positionId] }) as Promise<Address>,
      );
      console.log(`  NFT owner     : ${positionOwner}${positionOwner && positionOwner.toLowerCase() !== locker.toLowerCase() ? "  ! not the locker we are targeting" : " (locker ✓)"}`);
    }
    console.log(`  locker        : ${locker}  ${explorer.address(locker)}`);

    /* ---------------------------------------------------------- */
    /* fees readable through the verified NPM path                */
    /* ---------------------------------------------------------- */
    if (launched) {
      hr("Uncollected LP fees (simulated NonfungiblePositionManager.collect as the locker)");
      const fees = await readUncollectedFees(client, launched.positionManager, launched.positionId, positionOwner ?? locker);
      if (!fees) {
        console.log("  unavailable (collect simulation failed)");
      } else {
        const tokenAmt = launched.isToken0 ? fees.amount0 : fees.amount1;
        const pairAmt = launched.isToken0 ? fees.amount1 : fees.amount0;
        const sym = (await tryRead("symbol", () => client.readContract({ address: token, abi: ponsV1TokenAbi, functionName: "symbol" }))) ?? "TOKEN";
        const pairSym =
          launched.pairedToken.toLowerCase() === ADDRESSES.WETH.toLowerCase()
            ? "WETH"
            : ((await tryRead("pair.symbol", () => client.readContract({ address: launched!.pairedToken, abi: erc20Abi, functionName: "symbol" }))) ?? "PAIR");
        console.log(`  gross         : ${formatEther(pairAmt)} ${pairSym} + ${formatUnits(tokenAmt, 18)} ${sym}`);
        console.log(
          `  creator ~${Number(CREATOR_FEE_SHARE_BPS) / 100}% : ${formatEther((pairAmt * CREATOR_FEE_SHARE_BPS) / 10_000n)} ${pairSym} + ${formatUnits((tokenAmt * CREATOR_FEE_SHARE_BPS) / 10_000n, 18)} ${sym}  (split per docs; the locker decides the real amounts)`,
        );
      }
    }
  } else {
    console.log(`locker  : ${locker} (CHAIN.md value; RPC offline)`);
  }

  /* ------------------------------------------------------------ */
  /* locker surface discovery                                     */
  /* ------------------------------------------------------------ */
  let sig = opt(args, "sig") ?? process.env.LOCKER_CLAIM_SIGNATURE?.trim() ?? "";
  let sigVerifiedInCode = false;
  if (online) {
    hr("Locker bytecode probe (ABI not published)");
    const probe = await probeLockerSelectors(client, locker, sig ? [sig] : []);
    console.log(`  code size     : ${probe.codeSize} bytes`);
    const foundWrites = probe.writes.filter((p) => p.present);
    const foundReads = probe.reads.filter((p) => p.present);
    console.log(`  write cands   : ${foundWrites.length ? foundWrites.map((p) => `${p.signature} [${p.selector}]`).join(", ") : "none of the candidates found"}`);
    console.log(`  read cands    : ${foundReads.length ? foundReads.map((p) => `${p.signature} [${p.selector}]`).join(", ") : "none of the candidates found"}`);
    for (const r of foundReads) {
      if (r.signature === "protocolFeeRecipient()") {
        const v = await tryRead("protocolFeeRecipient", () => client.readContract({ address: locker, abi: ponsV1LockerKnownAbi, functionName: "protocolFeeRecipient" }));
        if (v) console.log(`  protocolFeeRecipient(): ${v}`);
      }
      if (r.signature === "feeRedirects(address)" || r.signature === "feeRedirect(address)") {
        const v = await tryRead(r.signature, () =>
          client.readContract({ address: locker, abi: [parseAbiItem(`function ${r.signature.replace("(address)", "(address token)")} view returns (address)`)], functionName: r.signature.split("(")[0], args: [token] }),
        );
        if (v) console.log(`  ${r.signature}: ${v}${v === "0x0000000000000000000000000000000000000000" ? " (zero → fees go to the deployer)" : ""}`);
      }
    }
    if (!sig) {
      if (foundWrites.length === 1) {
        sig = foundWrites[0].signature;
        console.log(`  → using the single discovered candidate: ${sig}`);
      } else {
        sig = DEFAULT_SIG;
        console.log(`  → ${foundWrites.length ? "several candidates found; " : ""}falling back to UNVERIFIED default ${sig}. Pass --sig to choose.`);
      }
    }
    sigVerifiedInCode = probe.writes.some((p) => p.signature === sig && p.present);
    console.log(`  chosen sig    : ${sig}  ${sigVerifiedInCode ? "(selector present in locker bytecode ✓)" : "(! selector NOT found in locker bytecode)"}`);
  } else {
    if (!sig) sig = DEFAULT_SIG;
    console.log(`\nsig     : ${sig} (UNVERIFIED — offline, cannot probe the locker bytecode)`);
  }

  /* ------------------------------------------------------------ */
  /* build + simulate + send                                      */
  /* ------------------------------------------------------------ */
  const { abi, functionName, argKinds } = buildClaimAbi(sig);
  const callArgs = argKinds.map((t) => (t === "address" ? token : launched?.positionId ?? 0n));
  if (!dryRun && !sigVerifiedInCode && !has(args, "force")) {
    throw new Error(`refusing to send: selector for ${sig} was not found in the locker bytecode. Pass --sig with the real signature, or --force.`);
  }
  await planAndMaybeSend(
    { client, rpcOnline: online, dryRun, from, wallet: walletInfo?.wallet },
    { label: `PonsLocker.${sig}  ${sigVerifiedInCode ? "" : "[UNVERIFIED]"}`, address: locker, abi, functionName, args: callArgs },
  );

  if (dryRun) {
    hr("Dry run summary");
    console.log("  nothing sent. The locker claim ABI is unverified: verify the function on the explorer");
    console.log(`  (${explorer.address(locker)}) and set LOCKER_CLAIM_SIGNATURE in .env before a live claim.`);
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${shortError(err)}`);
  process.exit(1);
});
