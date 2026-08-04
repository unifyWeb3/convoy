// Contract ABIs for the two contracts deployed at CVY-003.
//
// Minimal fragments — only what the orchestrator calls. Full ABIs live in
// packages/contracts/out/ and are not needed here.

export const REGISTRY_ABI = [
  {
    name: 'openRun',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'commitAction',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'idx', type: 'uint256' },
      { name: 'hash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'sealRun',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

export const DISTRIBUTOR_ABI = [
  {
    name: 'setRoot',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newRoot', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'fund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'enableMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
] as const;

/** Custom-error selector → name, for decoding revertReason (gap G-20 branch c). */
export const ERROR_SELECTORS: Readonly<Record<string, string>> = {
  '0x1c8b6259': 'RootNotSet()',
  '0xb466ddbf': 'RootAlreadySet()',
  '0xb263ae73': 'ZeroRoot()',
  '0x1f2a2005': 'ZeroAmount()',
  '0xd5ef09ba': 'NotFunded()',
  '0x30f065ef': 'MarketAlreadyEnabled()',
  // ConvoyRegistry
  '0xbc0a3ed5': 'NotOpen()',
  '0x1a3ec4e4': 'AlreadyOpen()',
  '0x0dc10197': 'AlreadySealed()',
  '0x7c214f04': 'NotOperator()',
  '0x9b2fc6a7': 'DupIndex()',
  '0x2b6ba33c': 'NothingCommitted()',
};

/**
 * Turn a selector into a readable error name.
 *
 * The API says `execution reverted (unknown custom error)` and carries only the
 * 4-byte selector (gap G-20). This is the ABI-side lookup that turns it back
 * into `RootNotSet()` — the difference between a judge reading a real
 * precondition failure and reading a diagnostic blob.
 */
export function decodeRevertSelector(selector: string | undefined): string | undefined {
  if (selector === undefined) return undefined;
  return ERROR_SELECTORS[selector.toLowerCase()];
}
