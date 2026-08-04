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
  /** Attempts, including the first. Covers both an unreachable RPC and receipt lag. */
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}

async function rpcReceipt(
  rpcUrl: string,
  txHash: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const response = await doFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { result?: unknown } | null;
  const result = body?.result;
  if (result === null || result === undefined || typeof result !== 'object') return undefined;
  return result as Record<string, unknown>;
}

/**
 * Read one receipt via `BASE_RPC_URL`, retrying.
 *
 * TWO DISTINCT REASONS THE FIRST ATTEMPT CAN COME BACK EMPTY, and retrying is
 * right for both. The RPC can be transiently unreachable — measured from this
 * environment, DNS for the provider host fails intermittently — and the receipt
 * can simply lag the write, since the transaction landed moments earlier. A null
 * result is therefore retried exactly like a transport failure.
 *
 * Returns `undefined` rather than throwing when it still cannot be read: a
 * transaction that landed must never be re-classified as failed because an RPC
 * blinked. The caller falls back to KeeperHub's figures and **records that it
 * did**, via `feeFromReceipt:false` — so a degraded reading is visible rather
 * than silently indistinguishable from a good one.
 */
export async function readReceiptGas(
  txHash: string,
  options: ReceiptReaderOptions = {},
): Promise<ReceiptGas | undefined> {
  // Both providers, alternating. `BASE_RPC_URL_FALLBACK` exists as demo backup
  // path b; using it here is what makes it more than a config entry. NOTE: both
  // variables currently point at the SAME host, so the redundancy is nominal —
  // the code is right and the configuration is what would need changing to make
  // it worth anything.
  const urls = (
    options.rpcUrl !== undefined
      ? [options.rpcUrl]
      : [process.env['BASE_RPC_URL'], process.env['BASE_RPC_URL_FALLBACK']]
  ).filter((u): u is string => u !== undefined && u !== '');
  if (urls.length === 0) return undefined;

  const doFetch = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 4;
  const delay = options.retryDelayMs ?? 1_500;

  let r: Record<string, unknown> | undefined;
  for (let i = 0; i < attempts; i += 1) {
    const url = urls[i % urls.length] as string;
    try {
      r = await rpcReceipt(url, txHash, doFetch, options.timeoutMs ?? 10_000);
    } catch {
      r = undefined;
    }
    if (r !== undefined) break;
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, delay * (i + 1)));
  }
  if (r === undefined) return undefined;

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
