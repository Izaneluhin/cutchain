/**
 * Shared configuration for the cutchain `mint/` scripts.
 *
 * Everything here is a constant that was researched for CHAIN.md. Anything
 * marked UNVERIFIED there is also marked UNVERIFIED here. Overrides come from
 * `.env` (see `.env.example`) so nothing has to be edited in source.
 *
 * The private key is read ONCE, turned into an account object and never
 * logged. Do not add any console output that touches `process.env.PRIVATE_KEY`.
 */
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MINT_DIR = resolve(HERE, "..");

// Load mint/.env first, then fall back to the process cwd .env (harmless if missing).
loadDotenv({ path: resolve(MINT_DIR, ".env"), quiet: true });
loadDotenv({ quiet: true });

/* -------------------------------------------------------------------------- */
/*  Chain                                                                     */
/* -------------------------------------------------------------------------- */

/** Verified: docs.robinhood.com/chain/connecting + /add-network-to-wallet */
export const CHAIN_ID = 4663;
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const ROBINSCAN_URL = "https://robinscan.io";

export const RPC_URL = process.env.RPC_URL?.trim() || PUBLIC_RPC_URL;

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER_URL } },
});

/* -------------------------------------------------------------------------- */
/*  Addresses (see CHAIN.md for sources)                                      */
/* -------------------------------------------------------------------------- */

function envAddress(name: string, fallback: Address): Address {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid address`);
  return v as Address;
}

export const ADDRESSES = {
  /* ---------------- Pons V2 (current launchpad) — all from docs.ponsfamily.com/v2 "Deployed addresses" ---------------- */
  /** PonsV2LaunchFactory. Docs + official repo README (Deployed factories table). */
  PONS_V2_FACTORY: envAddress("PONS_V2_FACTORY", "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  /** PonsV2MemeHook (Uniswap V4 hook charging the post-graduation fee). Docs + Bitquery article. */
  PONS_V2_MEME_HOOK: envAddress("PONS_V2_MEME_HOOK", "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  /** Fee escrow (claimable balance ledger). Docs. `launch.ts` cross-checks it against factory.feeEscrow() live. */
  PONS_V2_FEE_ESCROW: envAddress("PONS_V2_FEE_ESCROW", "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  /** PonsV2BuybackVault (5-year vest of bought-back supply). Docs. */
  PONS_V2_BUYBACK_VAULT: envAddress("PONS_V2_BUYBACK_VAULT", "0x42df2a798f82289E177311362e8f5ccC45c1219c"),
  /** PonsV2LaunchLocker (permanently holds the graduated V4 position NFT). Docs + Bitquery article. */
  PONS_V2_LAUNCH_LOCKER: envAddress("PONS_V2_LAUNCH_LOCKER", "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952"),
  /** PonsV2LaunchAndBuy router (atomic launch + first buy). Docs + Bitquery article. ABI NOT VERIFIED (docs only). */
  PONS_V2_LAUNCH_AND_BUY: envAddress("PONS_V2_LAUNCH_AND_BUY", "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"),
  /** PonsV2LaunchDeployer / GraduationExecutor / GraduationGuard. Docs only; read-only use. */
  PONS_V2_LAUNCH_DEPLOYER: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42" as Address,
  PONS_V2_GRADUATION_EXECUTOR: "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046" as Address,
  PONS_V2_GRADUATION_GUARD: "0xf5695117b99B6f6401e67d4195BD653628176C6C" as Address,
  /** Uniswap V4 on Robinhood Chain (Uniswap deployments/4663.md). */
  UNISWAP_V4_POOL_MANAGER: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  UNISWAP_V4_POSITION_MANAGER: "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
  UNISWAP_V4_STATE_VIEW: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,
  UNISWAP_V4_QUOTER: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address,

  /* ---------------- Pons V1 (legacy; kept for the *-v1.ts scripts) ---------------- */
  /** Pons v1 active factory. Verified: docs.ponsfamily.com + github.com/ponsdotdev/ponsfamily (contract-meta.json). */
  PONS_FACTORY: envAddress("PONS_FACTORY", "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"),
  /** Pons v1 active locker. Address verified (docs.ponsfamily.com); its ABI is NOT (see abi/pons_locker.json). */
  PONS_LOCKER: envAddress("PONS_LOCKER", "0x736D76699C26D0d966744cAe304C000d471f7F35"),
  /** Legacy (90/10 fee split) factory + locker, from docs.ponsfamily.com. Read-only use in status.ts. */
  PONS_FACTORY_LEGACY: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4" as Address,
  PONS_LOCKER_LEGACY: "0x31ca5E101941A93A7DD6d0497928700625CF54B5" as Address,
  /** WETH9. Verified: docs.robinhood.com/chain/contracts + Uniswap deployments/4663.md + Pons docs. */
  WETH: envAddress("WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  /** Uniswap V3. Verified: github.com/Uniswap/contracts/deployments/4663.md (matches Pons docs). */
  UNISWAP_V3_FACTORY: envAddress("UNISWAP_V3_FACTORY", "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"),
  NONFUNGIBLE_POSITION_MANAGER: envAddress(
    "NONFUNGIBLE_POSITION_MANAGER",
    "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  ),
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  QUOTER_V2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
  /** AMZN Stock Token. Verified: robinscan.io/stocks + opensea.io listing (name "Amazon • Robinhood Token"). */
  AMZN: envAddress("AMZN", "0x12f190a9f9d7d37a250758b26824b97ce941bf54"),
} as const;

/** V1 docs value (docs.ponsfamily.com). V2 has no documented number — always read `launchFee()` live; offline dry runs fall back to this. */
export const LAUNCH_FEE_DOCS = parseEther("0.0005");
/** V1 creator share of LP trading fees for the active V1 factory (docs.ponsfamily.com: "Creator 70% · protocol 30%"). */
export const CREATOR_FEE_SHARE_BPS = 7000n;
/** V2 factory ceilings from PonsV2LaunchFactory.sol (source constants; the live `maxCreatorTaxBps()` is owner-settable below this). */
export const V2_MAX_CREATOR_TAX_CEILING_BPS = 1000n;
export const V2_MAX_TOTAL_TRADE_FEE_BPS = 2000n;
export const V2_MAX_SNIPE_TAX_EXEMPTIONS = 32;
export const V2_METADATA_LIMITS = { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 } as const;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
/** Uniswap V3 pool init code hash on this chain (Uniswap deployments/4663.md; equals the canonical V3 hash). */
export const V3_POOL_INIT_CODE_HASH: Hex =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

/* -------------------------------------------------------------------------- */
/*  ABIs                                                                      */
/* -------------------------------------------------------------------------- */

export function loadAbi(file: string): Abi {
  return JSON.parse(readFileSync(resolve(MINT_DIR, "abi", file), "utf8")) as Abi;
}

/* -------------------------------------------------------------------------- */
/*  Clients                                                                   */
/* -------------------------------------------------------------------------- */

/** Address used for simulations when no PRIVATE_KEY is configured (dry runs). */
export const PLACEHOLDER_SENDER: Address = "0x000000000000000000000000000000000000dEaD";

const transport = () => http(RPC_URL, { timeout: 15_000, retryCount: 0 });

export function getPublicClient(): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: transport() });
}

/** Returns a wallet client only when PRIVATE_KEY is set. Never logs the key. */
export function getWalletClient(): { wallet: WalletClient; address: Address } | null {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY is set but is not a 32-byte hex string");
  }
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: transport() });
  return { wallet, address: account.address };
}

/**
 * Probes the RPC. Returns the chain id when reachable, or null when it is not
 * (sandboxed environments, offline dry runs). Never throws.
 */
export async function probeRpc(client: PublicClient): Promise<number | null> {
  try {
    const id = await client.getChainId();
    if (id !== CHAIN_ID) {
      console.warn(`! RPC reports chain id ${id}, expected ${CHAIN_ID} (Robinhood Chain). Continuing anyway.`);
    }
    return id;
  } catch (err) {
    console.warn(`! RPC ${RPC_URL} unreachable: ${shortError(err)}`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

export const explorer = {
  address: (a: string) => `${EXPLORER_URL}/address/${a}`,
  token: (a: string) => `${EXPLORER_URL}/token/${a}`,
  tx: (h: string) => `${EXPLORER_URL}/tx/${h}`,
  robinscanAddress: (a: string) => `${ROBINSCAN_URL}/address/${a}`,
  robinscanTx: (h: string) => `${ROBINSCAN_URL}/tx/${h}`,
};

export function shortError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: string; message?: string };
    return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0];
  }
  return String(err);
}

export function isAddress(v: string | undefined): v is Address {
  return !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function requireAddress(v: string | undefined, what: string): Address {
  if (!isAddress(v)) throw new Error(`${what} must be a 0x-prefixed 20-byte address (got ${v ?? "nothing"})`);
  return v;
}

export function hr(title?: string): void {
  const line = "─".repeat(72);
  console.log(title ? `\n${line}\n${title}\n${line}` : line);
}
