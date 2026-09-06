/**
 * Bytecode selector probing (used by every V2 write script as an ABI self-check) and helpers around
 * the Pons v1 locker, whose ABI is NOT published.
 *
 * What we know for sure (factory source, ILaunchpad.sol):
 *   - the locker owns every launch position NFT (factory calls NPM.safeTransferFrom(..., locker, positionId))
 *   - locker.lockPosition(token), locker.setFeeRedirect(token, wallet), locker.protocolFeeRecipient()
 *
 * What we can therefore read WITHOUT the locker ABI:
 *   - uncollected LP fees of the locked position, by simulating
 *     NonfungiblePositionManager.collect(...) with `from = locker` (the NFT owner). The NPM pokes the
 *     pool and returns the total (amount0, amount1) it would pay out. This is the gross figure the
 *     locker splits creator/protocol (70/30 on the active factory per the docs).
 *
 * What we can only *probe*:
 *   - which function selectors exist in the locker's runtime bytecode. Solidity dispatchers embed each
 *     external selector as a PUSH4 constant, so `bytecode.includes(selector)` is a cheap, reliable
 *     existence check (false positives are possible in theory, false negatives are not).
 */
import { maxUint128, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { LOCKER_CLAIM_CANDIDATES, LOCKER_READ_CANDIDATES, nonfungiblePositionManagerAbi } from "./abis.js";

export interface SelectorProbe {
  signature: string;
  selector: Hex;
  present: boolean;
}

export async function probeLockerSelectors(
  client: PublicClient,
  locker: Address,
  extra: string[] = [],
): Promise<{ codeSize: number; writes: SelectorProbe[]; reads: SelectorProbe[] }> {
  const code = (await client.getCode({ address: locker })) ?? "0x";
  const body = code.slice(2).toLowerCase();
  const probe = (sig: string): SelectorProbe => {
    const selector = toFunctionSelector(`function ${sig}`);
    return { signature: sig, selector, present: body.includes(selector.slice(2).toLowerCase()) };
  };
  const writeSigs = [...new Set([...LOCKER_CLAIM_CANDIDATES, ...extra])];
  return {
    codeSize: body.length / 2,
    writes: writeSigs.map(probe),
    reads: [...LOCKER_READ_CANDIDATES].map(probe),
  };
}

export function selectorPresentInCode(code: Hex | undefined, signature: string): boolean {
  if (!code) return false;
  const selector = toFunctionSelector(`function ${signature}`).slice(2).toLowerCase();
  return code.slice(2).toLowerCase().includes(selector);
}

/** Gross uncollected fees on a V3 position, simulated as the NFT owner. Returns undefined if the call fails. */
export async function readUncollectedFees(
  client: PublicClient,
  positionManager: Address,
  positionId: bigint,
  owner: Address,
): Promise<{ amount0: bigint; amount1: bigint } | undefined> {
  try {
    const { result } = await client.simulateContract({
      address: positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [{ tokenId: positionId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }],
      account: owner,
    });
    const [amount0, amount1] = result as readonly [bigint, bigint];
    return { amount0, amount1 };
  } catch {
    return undefined;
  }
}
