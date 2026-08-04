// Chain-truth gas accounting.
//
// KeeperHub reports gas, but what its `gasUsedWei` field MEANS changes with
// sponsorship (gap G-31) and it never carries the OP-stack L1 data fee at all
// (gap G-28). Both are vendor-side drift, and the fix for both is the same: read
// the receipt.
//
// The receipt is the same artifact a judge opens on Basescan, which is the point
// — the budget meter's inputs are independently verifiable rather than
// vendor-reported. KeeperHub's own numbers are still recorded alongside, as
// corroboration; where they disagree the receipt wins and the disagreement is
// visible in the audit drawer.

/** Gas facts for one landed transaction, read from the chain. */
export interface ReceiptGas {
  readonly txHash: string;
  /** `receipt.gasUsed` — units. */
  readonly gasUsedUnits: bigint;
  /** `receipt.effectiveGasPrice` — wei per unit. */
  readonly effectiveGasPriceWei: bigint;
  /** `receipt.l1Fee` — OP-stack data availability. Zero if the field is absent. */
  readonly l1FeeWei: bigint;
  /** Whether `l1Fee` was actually present, so a zero is never mistaken for "read". */
  readonly l1FeePresent: boolean;
  /** `gasUsedUnits * effectiveGasPriceWei + l1FeeWei` — the real total. */
  readonly totalWei: bigint;
  /** Who sent it. On Base Sepolia this is usually a KeeperHub relay (G-24, DEC-006). */
  readonly from: string;
}

function toBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'string' && v !== '') {
    try {
      return BigInt(v);
    } catch {
      return undefined;
    }
  }
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return undefined;
}

export interface ReceiptReaderOptions {
  readonly rpcUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Read one receipt via `BASE_RPC_URL`.
 *
 * Returns `undefined` rather than throwing when the receipt cannot be read — a
 * transaction that landed must not be re-classified as failed because an RPC
 * blinked. The caller falls back to KeeperHub's figures and records that it did.
 */
export async function readReceiptGas(
  txHash: string,
  options: ReceiptReaderOptions = {},
): Promise<ReceiptGas | undefined> {
  const rpcUrl = options.rpcUrl ?? process.env['BASE_RPC_URL'];
  if (rpcUrl === undefined || rpcUrl === '') return undefined;
  const doFetch = options.fetchImpl ?? fetch;

  let body: unknown;
  try {
    const response = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  }

  const result = (body as { result?: unknown } | null)?.result;
  if (result === null || result === undefined || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;

  const gasUsedUnits = toBigInt(r['gasUsed']);
  const effectiveGasPriceWei = toBigInt(r['effectiveGasPrice']);
  if (gasUsedUnits === undefined || effectiveGasPriceWei === undefined) return undefined;

  const l1 = toBigInt(r['l1Fee']);
  const from = typeof r['from'] === 'string' ? r['from'] : '';

  return {
    txHash,
    gasUsedUnits,
    effectiveGasPriceWei,
    l1FeeWei: l1 ?? 0n,
    l1FeePresent: l1 !== undefined,
    totalWei: gasUsedUnits * effectiveGasPriceWei + (l1 ?? 0n),
    from,
  };
}
