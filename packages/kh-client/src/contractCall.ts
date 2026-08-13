// @convoy/kh-client — direct-execution contract calls (simulate + write)
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import type { KhClient } from './client.js';
import { KhError } from './errors.js';
import { IDEMPOTENCY_HEADER, buildIdempotencyKey } from './idempotency.js';
import { decodeReportedGas } from './reportedGas.js';
import { isTerminalStatus } from './types.js';
import type {
  AttemptRef,
  ContractCallParams,
  ContractCallWireBody,
  SimulateResult,
  WriteResult,
} from './types.js';

export const CONTRACT_CALL_PATH = '/api/execute/contract-call';

/**
 * Build the wire body.
 *
 * Three things the API is strict about and a reader would otherwise get wrong:
 * `functionArgs` is a JSON-array **string**, not an array; `chainId` and
 * `network` are both sent as strings (gap G-01); `simulate` is a strict boolean
 * and is **omitted entirely** for writes rather than sent as `false`.
 */
export function buildContractCallBody(
  chainId: string,
  params: ContractCallParams,
  simulate: boolean,
): ContractCallWireBody {
  const base = {
    chainId,
    network: chainId,
    contractAddress: params.contractAddress,
    functionName: params.functionName,
    functionArgs: JSON.stringify(params.functionArgs),
    ...(params.abi === undefined ? {} : { abi: JSON.stringify(params.abi) }),
    ...(params.value === undefined ? {} : { value: params.value }),
    ...(params.gasLimitMultiplier === undefined
      ? {}
      : { gasLimitMultiplier: params.gasLimitMultiplier }),
  };
  return simulate ? { ...base, simulate: true } : base;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Pull the 4-byte custom-error selector out of a revertReason blob.
 *
 * The API reports custom errors as `execution reverted (unknown custom error)`
 * but still carries the revert data as `data="0x1c8b6259"` (gap G-20). The
 * selector is what makes the error identifiable, so it is extracted once here
 * rather than in every consumer. `data="0x"` and `data=null` mean the revert
 * carried no data at all — a bare `require`, not a custom error — and yield
 * undefined.
 */
export function extractRevertSelector(revertReason: string | undefined): string | undefined {
  if (revertReason === undefined) return undefined;
  const m = /\bdata="(0x[0-9a-fA-F]{8})[0-9a-fA-F]*"/.exec(revertReason);
  return m?.[1]?.toLowerCase();
}

/**
 * Simulate a call. Costs zero gas: no signing, no broadcast, no audit row.
 *
 * **HTTP 400 with `wouldRevert:true` is a successful simulate, not an error.**
 * The API answers a would-revert with 400 and `success:false` (tape:
 * test/vcr/simulate.wouldRevert.true.json). Classifying that as an API failure
 * would turn every Critic veto into a hard error and take the veto mechanism
 * off the table entirely — so 400 is declared an expected status here, and the
 * revert is returned as data.
 *
 * Simulates carry no Idempotency-Key: they are exempt, having changed nothing.
 */
export async function simulateContractCall(
  client: KhClient,
  params: ContractCallParams,
): Promise<SimulateResult> {
  const response = await client.request({
    method: 'POST',
    path: CONTRACT_CALL_PATH,
    body: buildContractCallBody(client.chainId, params, true),
    expectedStatuses: [400],
    tapeKey: `SIMULATE ${params.contractAddress}.${params.functionName}`,
  });

  const b = asRecord(response.body);

  // A 400 must actually be a simulate verdict. If `wouldRevert` is absent the
  // 400 is a genuine validation error wearing the same status code, and
  // silently reporting `wouldRevert:false` would be the worst possible answer:
  // the Critic would approve an item the API never evaluated.
  if (response.httpStatus === 400 && typeof b['wouldRevert'] !== 'boolean') {
    throw new KhError({
      message: `simulate returned HTTP 400 without a wouldRevert verdict: ${JSON.stringify(b)}`,
      classification: 'item-failed',
      httpStatus: 400,
      body: response.body,
      reason:
        'HTTP 400 is the would-revert channel, but this 400 carried no verdict — it is a ' +
        'validation error, and reporting it as "would not revert" would let the Critic ' +
        'approve an unevaluated item',
    });
  }

  const revertReason = str(b['revertReason']) ?? str(b['error']);

  return {
    wouldRevert: b['wouldRevert'] === true,
    gasEstimate: str(b['gasEstimate']),
    revertReason,
    revertSelector: extractRevertSelector(revertReason),
    from: str(b['from']),
    to: str(b['to']),
    value: str(b['value']),
    simulatedReturnValue: b['simulatedReturnValue'],
    httpStatus: response.httpStatus,
    raw: response.body,
  };
}

/**
 * Execute a write through the org Turnkey wallet.
 *
 * Convoy never signs and never sets a nonce — ordering belongs to KeeperHub's
 * single-sequential-nonce manager, and Convoy only observes the result.
 *
 * Writes execute synchronously (gap G-02): the response is frequently already
 * terminal, so `terminal` is set from it and the caller can skip the poll.
 */
export async function writeContractCall(
  client: KhClient,
  params: ContractCallParams,
  ref: AttemptRef,
): Promise<WriteResult> {
  const response = await client.request({
    method: 'POST',
    path: CONTRACT_CALL_PATH,
    body: buildContractCallBody(client.chainId, params, false),
    headers: { [IDEMPOTENCY_HEADER]: buildIdempotencyKey(ref) },
    tapeKey: `WRITE ${params.contractAddress}.${params.functionName}`,
  });

  const b = asRecord(response.body);
  const executionId = str(b['executionId']);
  if (executionId === undefined) {
    throw new KhError({
      message: `write returned no executionId: ${JSON.stringify(b)}`,
      classification: 'item-failed',
      httpStatus: response.httpStatus,
      body: response.body,
      reason: 'without an executionId there is nothing to poll or reconcile against',
    });
  }
  const status = str(b['status']) ?? 'pending';
  const retryCount =
    typeof b['retryCount'] === 'number' && Number.isInteger(b['retryCount']) && b['retryCount'] >= 0
      ? b['retryCount']
      : undefined;

  return {
    executionId,
    status,
    transactionHash: str(b['transactionHash']),
    transactionLink: str(b['transactionLink']),
    ...(retryCount === undefined ? {} : { retryCount }),
    ...decodeReportedGas(b),
    terminal: isTerminalStatus(status),
    httpStatus: response.httpStatus,
    raw: response.body,
  };
}
