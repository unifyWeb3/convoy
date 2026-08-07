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
import { decodeReportedGas } from './reportedGas.js';
import { isTerminalStatus } from './types.js';
import type { AttemptRef, ContractCallParams, ExecutionStatus, WriteResult } from './types.js';

export const CHECK_AND_EXECUTE_PATH = '/api/execute/check-and-execute';

export interface CheckAndExecuteParams {
  /** Read-only call whose result gates the write. */
  readonly check: ContractCallParams;
  readonly condition: {
    readonly operator: string;
    /** KeeperHub currently requires this value as a string on the wire. */
    readonly value: unknown;
  };
  readonly action: ContractCallParams;
}

export interface CheckAndExecuteCondition {
  readonly met: boolean;
  readonly observedValue: string | number | boolean | null;
  readonly targetValue: string | number | boolean | null;
  readonly operator: string;
}

export interface CheckAndExecuteResult extends Omit<WriteResult, 'executionId' | 'status'> {
  readonly executed: boolean;
  readonly executionId?: string;
  readonly status?: ExecutionStatus | string;
  readonly condition: CheckAndExecuteCondition;
}

export async function checkAndExecute(
  client: KhClient,
  params: CheckAndExecuteParams,
  ref: AttemptRef,
): Promise<CheckAndExecuteResult> {
  const conditionValue =
    typeof params.condition.value === 'string'
      ? params.condition.value
      : JSON.stringify(params.condition.value);
  const body = {
    chainId: client.chainId,
    network: client.chainId,
    contractAddress: params.check.contractAddress,
    functionName: params.check.functionName,
    functionArgs: JSON.stringify(params.check.functionArgs),
    ...(params.check.abi === undefined ? {} : { abi: JSON.stringify(params.check.abi) }),
    condition: { operator: params.condition.operator, value: conditionValue },
    action: {
      contractAddress: params.action.contractAddress,
      functionName: params.action.functionName,
      functionArgs: JSON.stringify(params.action.functionArgs),
      ...(params.action.abi === undefined ? {} : { abi: JSON.stringify(params.action.abi) }),
      ...(params.action.value === undefined ? {} : { value: params.action.value }),
      ...(params.action.gasLimitMultiplier === undefined
        ? {}
        : { gasLimitMultiplier: params.action.gasLimitMultiplier }),
    },
  };

  const response = await client.request({
    method: 'POST',
    path: CHECK_AND_EXECUTE_PATH,
    body,
    headers: { [IDEMPOTENCY_HEADER]: buildIdempotencyKey(ref) },
    tapeKey: `CHECK_AND_EXECUTE ${params.action.contractAddress}.${params.action.functionName}`,
  });

  const b =
    response.body !== null && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const scalar = (v: unknown): string | number | boolean | null =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
  const conditionBody =
    b['conditionResult'] !== null && typeof b['conditionResult'] === 'object'
      ? (b['conditionResult'] as Record<string, unknown>)
      : b['condition'] !== null && typeof b['condition'] === 'object'
        ? (b['condition'] as Record<string, unknown>)
        : undefined;
  const met = conditionBody?.['met'];
  if (typeof met !== 'boolean') {
    throw new KhError({
      message: `check-and-execute returned no condition verdict: ${JSON.stringify(b)}`,
      classification: 'item-failed',
      httpStatus: response.httpStatus,
      body: response.body,
      reason: 'without a condition verdict the gate cannot safely decide whether to execute',
    });
  }

  const condition: CheckAndExecuteCondition = {
    met,
    observedValue: scalar(conditionBody?.['observedValue']),
    targetValue: scalar(conditionBody?.['targetValue']),
    operator: s(conditionBody?.['operator']) ?? params.condition.operator,
  };
  const executionId = s(b['executionId']);
  const executed = b['executed'] === true;
  if (executed && executionId === undefined) {
    throw new KhError({
      message: `check-and-execute condition met but returned no executionId: ${JSON.stringify(b)}`,
      classification: 'item-failed',
      httpStatus: response.httpStatus,
      body: response.body,
      reason: 'an executed action must provide an executionId to poll and reconcile',
    });
  }
  const status = s(b['status']);

  return {
    executed,
    ...(executionId === undefined ? {} : { executionId }),
    ...(status === undefined ? {} : { status }),
    condition,
    transactionHash: s(b['transactionHash']),
    transactionLink: s(b['transactionLink']),
    ...decodeReportedGas(b),
    terminal: status === undefined ? false : isTerminalStatus(status),
    httpStatus: response.httpStatus,
    raw: response.body,
  };
}
