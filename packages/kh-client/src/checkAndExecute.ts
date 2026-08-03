// @convoy/kh-client — check-and-execute
//
// The onchain gate: KeeperHub evaluates a read-only check on chain and only
// executes the write if it passes. Used by CVY-013's dependency gate, where the
// point is that the gate is enforced ONCHAIN rather than by the app.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import type { KhClient } from './client.js';
import { KhError } from './errors.js';
import { IDEMPOTENCY_HEADER, buildIdempotencyKey } from './idempotency.js';
import { isTerminalStatus } from './types.js';
import type { AttemptRef, ContractCallParams, WriteResult } from './types.js';

export const CHECK_AND_EXECUTE_PATH = '/api/execute/check-and-execute';

export interface CheckAndExecuteParams {
  /** Read-only call whose result gates the write. */
  readonly check: ContractCallParams & { readonly expectedValue?: unknown };
  readonly execute: ContractCallParams;
}

export async function checkAndExecute(
  client: KhClient,
  params: CheckAndExecuteParams,
  ref: AttemptRef,
): Promise<WriteResult> {
  const body = {
    chainId: client.chainId,
    network: client.chainId,
    check: {
      contractAddress: params.check.contractAddress,
      functionName: params.check.functionName,
      functionArgs: JSON.stringify(params.check.functionArgs),
      ...(params.check.abi === undefined ? {} : { abi: JSON.stringify(params.check.abi) }),
      ...(params.check.expectedValue === undefined
        ? {}
        : { expectedValue: params.check.expectedValue }),
    },
    execute: {
      contractAddress: params.execute.contractAddress,
      functionName: params.execute.functionName,
      functionArgs: JSON.stringify(params.execute.functionArgs),
      ...(params.execute.abi === undefined ? {} : { abi: JSON.stringify(params.execute.abi) }),
      ...(params.execute.value === undefined ? {} : { value: params.execute.value }),
    },
  };

  const response = await client.request({
    method: 'POST',
    path: CHECK_AND_EXECUTE_PATH,
    body,
    headers: { [IDEMPOTENCY_HEADER]: buildIdempotencyKey(ref) },
    tapeKey: `CHECK_AND_EXECUTE ${params.execute.contractAddress}.${params.execute.functionName}`,
  });

  const b =
    response.body !== null && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const executionId = s(b['executionId']);
  if (executionId === undefined) {
    throw new KhError({
      message: `check-and-execute returned no executionId: ${JSON.stringify(b)}`,
      classification: 'item-failed',
      httpStatus: response.httpStatus,
      body: response.body,
      reason: 'without an executionId there is nothing to poll or reconcile against',
    });
  }
  const status = s(b['status']) ?? 'pending';

  return {
    executionId,
    status,
    transactionHash: s(b['transactionHash']),
    transactionLink: s(b['transactionLink']),
    gasUsedWei: s(b['gasUsedWei']),
    terminal: isTerminalStatus(status),
    httpStatus: response.httpStatus,
    raw: response.body,
  };
}
