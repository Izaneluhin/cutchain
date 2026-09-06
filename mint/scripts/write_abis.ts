#!/usr/bin/env tsx
/**
 * scripts/write_abis.ts — serialises the human-readable V2 ABIs in lib/abis_v2.ts into abi/pons_v2_*.json
 * so other tooling (explorers, foundry cast, other languages) can consume them.
 *
 *   npm run abis
 *
 * Each JSON file carries a `_status` note; the `abi` array is the parsed ABI.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MINT_DIR } from "../lib/config.js";
import {
  ponsV2BuybackVaultAbi,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  ponsV2FeeEscrowAbi,
  ponsV2HookAbi,
  ponsV2LaunchAndBuyAbi,
  ponsV2LockerAbi,
  ponsV2TokenAbi,
} from "../lib/abis_v2.js";

const SOURCE_NOTE =
  "Hand-derived from the official Solidity source (github.com/ponsdotdev/ponsfamily, contractsV2/src/v2, commit 845bd54) and docs.ponsfamily.com/v2. NOT compiled and NOT fetched from the explorer (unreachable from the build sandbox). The scripts verify each selector they send against the deployed bytecode first.";

const files: Array<[string, string, readonly unknown[]]> = [
  ["pons_v2_factory.json", `PonsV2LaunchFactory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e — ${SOURCE_NOTE}`, ponsV2FactoryAbi],
  ["pons_v2_curve.json", `PonsV2BondingCurve (one per launch, read from factory.getLaunchedToken) — ${SOURCE_NOTE} currentSnipeTaxBps(address) is docs-only.`, ponsV2CurveAbi],
  ["pons_v2_fee_escrow.json", `Fee Escrow 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e — IPonsV2FeeEscrow interface from the official source + docs 'Claiming fees'. Event names are docs-only.`, ponsV2FeeEscrowAbi],
  ["pons_v2_hook.json", `PonsV2MemeHook 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044 — ${SOURCE_NOTE}`, ponsV2HookAbi],
  ["pons_v2_token.json", `PonsV2LauncherToken (one per launch) — ${SOURCE_NOTE}`, ponsV2TokenAbi],
  ["pons_v2_buyback_vault.json", `PonsV2BuybackVault 0x42df2a798f82289E177311362e8f5ccC45c1219c — ${SOURCE_NOTE}`, ponsV2BuybackVaultAbi],
  ["pons_v2_launch_locker.json", `PonsV2LaunchLocker 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952 — ${SOURCE_NOTE}`, ponsV2LockerAbi],
  ["pons_v2_launch_and_buy.json", "PonsV2LaunchAndBuy 0xe33E9E479dF8802cb0866d5d05258bEc4cF62948 — UNVERIFIED: signature taken from docs.ponsfamily.com/v2 only; no source in the public repo.", ponsV2LaunchAndBuyAbi],
];

for (const [file, status, abi] of files) {
  const path = resolve(MINT_DIR, "abi", file);
  writeFileSync(path, JSON.stringify({ _status: status, abi }, null, 2) + "\n");
  console.log(`wrote ${file} (${abi.length} entries)`);
}
