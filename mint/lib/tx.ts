/**
 * One place that decides what "dry run" means for every script:
 *
 *   1. always print   : target, function, args, ABI-encoded calldata, value
 *   2. if RPC reachable: eth_call simulation (decoded return value or decoded
 *                        custom-error revert) + eth_estimateGas
 *   3. if not dry-run : sign, send, wait for the receipt, print explorer links
 *
 * The private key never enters this module; it only sees a viem WalletClient.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  formatEther,
  formatGwei,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { explorer, shortError } from "./config.js";

export interface PlannedCall {
  /** short human label, e.g. "PonsLaunchFactory.launchToken" */
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export interface PlanContext {
  client: PublicClient;
  rpcOnline: boolean;
  dryRun: boolean;
  /** sender used for simulation; the wallet's address when sending */
  from: Address;
  wallet?: WalletClient;
}

export interface PlanResult {
  calldata: Hex;
  simulationResult?: unknown;
  simulationError?: string;
  gasEstimate?: bigint;
  receipt?: TransactionReceipt;
  hash?: Hex;
}

function stringifyArgs(args: readonly unknown[]): string {
  return JSON.stringify(
    args,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

export function describeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | null;
    if (revert) {
      const name = revert.data?.errorName ?? revert.reason ?? "revert";
      const a = revert.data?.args ? ` ${stringifyArgs(revert.data.args as unknown[])}` : "";
      return `${name}${a}`;
    }
    return err.shortMessage;
  }
  return shortError(err);
}

/**
 * Prints the call, simulates when possible, and sends unless `dryRun`.
 * Never throws on a failed simulation during a dry run — it reports and returns.
 * In live mode a failed simulation aborts before anything is signed.
 */
export async function planAndMaybeSend(ctx: PlanContext, call: PlannedCall): Promise<PlanResult> {
  const calldata = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as never });
  const value = call.value ?? 0n;

  console.log(`\n▶ ${call.label}`);
  console.log(`  to      : ${call.address}`);
  console.log(`  from    : ${ctx.from}${ctx.wallet ? "" : "  (placeholder — no PRIVATE_KEY)"}`);
  console.log(`  value   : ${formatEther(value)} ETH (${value} wei)`);
  console.log(`  args    : ${stringifyArgs(call.args).replace(/\n/g, "\n            ")}`);
  console.log(`  calldata: ${calldata}`);
  console.log(`  selector: ${calldata.slice(0, 10)}  (${calldata.length / 2 - 1} bytes)`);

  const result: PlanResult = { calldata };

  if (!ctx.rpcOnline) {
    console.log("  simulate: skipped (RPC unreachable)");
    if (!ctx.dryRun) throw new Error("cannot send: RPC unreachable");
    return result;
  }

  // With a placeholder sender (no PRIVATE_KEY) the node would reject value-carrying calls for lack of
  // balance, so we ask it to pretend the sender is funded. Nodes without state-override support fall
  // back to a plain call below.
  const fundedOverride = ctx.wallet ? undefined : [{ address: ctx.from, balance: parseEther("1000") }];

  const simulate = async (stateOverride?: typeof fundedOverride) =>
    ctx.client.simulateContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args as never,
      value,
      account: ctx.from,
      ...(stateOverride ? { stateOverride } : {}),
    });
  try {
    let sim: Awaited<ReturnType<typeof simulate>>;
    try {
      sim = await simulate(fundedOverride);
    } catch (err) {
      if (!fundedOverride) throw err;
      sim = await simulate(undefined);
    }
    result.simulationResult = sim.result;
    console.log(`  eth_call: OK → ${stringifyArgs([sim.result]).replace(/\n/g, " ")}`);
  } catch (err) {
    result.simulationError = describeRevert(err);
    console.log(`  eth_call: REVERT → ${result.simulationError}`);
  }

  try {
    let gas: bigint;
    try {
      gas = await ctx.client.estimateGas({ to: call.address, data: calldata, value, account: ctx.from, ...(fundedOverride ? { stateOverride: fundedOverride } : {}) });
    } catch (err) {
      if (!fundedOverride) throw err;
      gas = await ctx.client.estimateGas({ to: call.address, data: calldata, value, account: ctx.from });
    }
    result.gasEstimate = gas;
    let feeNote = "";
    try {
      const gp = await ctx.client.getGasPrice();
      feeNote = ` ≈ ${formatEther(gas * gp)} ETH at ${formatGwei(gp)} gwei`;
    } catch {
      /* optional */
    }
    console.log(`  gas     : ${gas}${feeNote}`);
  } catch (err) {
    console.log(`  gas     : estimate failed → ${describeRevert(err)}`);
  }

  if (ctx.dryRun) {
    console.log("  dry-run : nothing sent");
    return result;
  }
  if (!ctx.wallet || !ctx.wallet.account) throw new Error("cannot send: PRIVATE_KEY not configured");
  if (result.simulationError) throw new Error(`refusing to send: simulation reverted (${result.simulationError})`);

  const hash = await ctx.wallet.sendTransaction({
    account: ctx.wallet.account,
    chain: ctx.wallet.chain,
    to: call.address,
    data: calldata,
    value,
    gas: result.gasEstimate ? (result.gasEstimate * 125n) / 100n : undefined,
  });
  result.hash = hash;
  console.log(`  sent    : ${hash}`);
  console.log(`            ${explorer.tx(hash)}`);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  result.receipt = receipt;
  console.log(`  status  : ${receipt.status} in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
  return result;
}

/** Reads through the public client, returning `undefined` (and logging) instead of throwing. */
export async function tryRead<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.log(`  ${label}: unavailable (${describeRevert(err)})`);
    return undefined;
  }
}
