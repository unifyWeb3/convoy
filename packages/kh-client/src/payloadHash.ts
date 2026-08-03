// @convoy/kh-client — payloadHash
//
// The payload commitment: one value pinning *which* call was committed at
// *which* index of *which* run. ConvoyRegistry stores it onchain
// (`payloadHash[runId][idx]`), so this must be byte-identical to the Solidity
// side or the onchain proof stops proving anything. Parity is asserted against
// fixtures dumped from real Solidity output — see
// `test/payloadHash.parity.test.ts` and
// `packages/contracts/script/DumpPayloadHashFixtures.s.sol`.

import { encodeAbiParameters, keccak256 } from 'viem';
import type { AbiParameter, Address, Hex } from 'viem';

/**
 * A value acceptable as an ABI argument. Deliberately narrow — `any` is banned
 * in exported signatures, and every value reaching the encoder is one of these
 * or an array of them.
 */
export type AbiArgValue = string | bigint | boolean | readonly AbiArgValue[];

/**
 * Input to the pinned commitment encoding (Implementation Blueprint A4 — do not
 * vary):
 *
 *   keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))
 */
export interface PayloadHashInput {
  /** The contract the item calls. */
  readonly target: Address;
  /** The function name, unqualified and without a signature suffix. */
  readonly functionName: string;
  /**
   * ABI-encoded argument **tuple** bytes — NOT the 4-byte-selector calldata.
   * Passing calldata here yields a hash the registry never sees. `0x` when the
   * function takes no arguments.
   */
  readonly encodedArgs: Hex;
  /** The item's index within its run. Part of the commitment: order is the point. */
  readonly idx: bigint | number;
}

/**
 * Computes the payload commitment for one run item.
 *
 * Mirrors Solidity's `keccak256(abi.encode(...))` exactly. There is one
 * encoding and this is it — if a hash disagrees with the chain, the bug is in
 * the caller's `encodedArgs`, not in this function.
 */
export function payloadHash(input: PayloadHashInput): Hex {
  const { target, functionName, encodedArgs, idx } = input;

  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
      [target, functionName, encodedArgs, BigInt(idx)],
    ),
  );
}

/**
 * ABI-encodes an argument tuple into the `encodedArgs` bytes `payloadHash`
 * expects. Equivalent to Solidity's `abi.encode(...)` over the same types.
 *
 * A function with no arguments encodes to `0x`, which is exactly what
 * Solidity's zero-length `bytes` hashes to — the `emptyArgs` fixture pins it.
 */
export function encodeArgs(argTypes: readonly string[], argValues: readonly AbiArgValue[]): Hex {
  if (argTypes.length !== argValues.length) {
    throw new Error(`encodeArgs: ${argTypes.length} types but ${argValues.length} values`);
  }

  const params: AbiParameter[] = argTypes.map((type) => ({ type }));

  // viem types its values against the *literal* parameter types, which are only
  // known at runtime here. The cast is confined to this one call so the
  // exported signature stays free of `any`; the dumped parity fixtures are what
  // actually prove the encoding is right.
  return encodeAbiParameters(params, argValues as unknown[]);
}
