// Crash-resume reconciliation for KeeperHub direct executions.
//
// The attempt row is created before a write is submitted and its execution id
// is stored immediately after KeeperHub responds. A killed worker therefore
// leaves one of two replayable records:
//   - executionId present: poll that execution; never submit again.
//   - executionId absent: reissue the exact same phase-folded idempotency key.
//
// This module deliberately does not construct transactions, set nonces, or
// manufacture terminal data. It only persists what KeeperHub returned.

import { Prisma, unsafeRawClient as prisma, bytesToHex } from '@convoy/db';
import {
  pollUntilTerminal,
  transientRunErrorCode,
  type KhClient,
  type StatusResult,
  type WriteResult,
} from '@convoy/kh-client';

export type RecoverableAttemptKind = 'COMMIT' | 'EXECUTE';

export interface PersistedAttempt {
  readonly id: string;
  readonly itemId: string;
  readonly attemptNo: number;
  readonly kind: RecoverableAttemptKind;
  readonly executionId: string | null;
  readonly txHash: Uint8Array | null;
  readonly txLink: string | null;
  readonly khStatus: string | null;
  readonly errorCode: string | null;
  readonly revertReason: string | null;
  readonly gasUsedWei: Prisma.Decimal | null;
  readonly gasUsedUsdc: Prisma.Decimal | null;
  readonly sponsored: boolean | null;
}

export type ExecutionObservation =
  | { readonly outcome: 'landed'; readonly status: StatusResult; readonly txHash: string }
  | { readonly outcome: 'retry'; readonly status: StatusResult; readonly code: string }
  | {
      readonly outcome: 'failed';
      readonly status: StatusResult;
      readonly reason: string;
      readonly code?: string;
    };

function asPersisted(attempt: {
  id: string;
  itemId: string;
  attemptNo: number;
  kind: string;
  executionId: string | null;
  txHash: Uint8Array | null;
  txLink: string | null;
  khStatus: string | null;
  errorCode: string | null;
  revertReason: string | null;
  gasUsedWei: Prisma.Decimal | null;
  gasUsedUsdc: Prisma.Decimal | null;
  sponsored: boolean | null;
}): PersistedAttempt {
  if (attempt.kind !== 'COMMIT' && attempt.kind !== 'EXECUTE') {
    throw new Error(`attempt ${attempt.id} has non-recoverable kind ${attempt.kind}`);
  }
  return { ...attempt, kind: attempt.kind };
}

/**
 * Persist the attempt number before the external request. Existing rows win,
 * which is the stalled/re-picked-job path: BullMQ's attempt counter is ignored.
 */
export async function getOrCreateAttempt(
  itemId: string,
  attemptNo: number,
  kind: RecoverableAttemptKind,
): Promise<PersistedAttempt> {
  return await prisma.$transaction(async (tx) => {
    const attemptDelegate = (
      tx as unknown as { attempt?: { findFirst?: unknown; create: unknown } }
    ).attempt;
    if (attemptDelegate === undefined) {
      const created = await prisma.attempt.create({
        data: { itemId, attemptNo, kind, khStatus: 'prepared' },
      });
      return asPersisted({
        ...created,
        executionId: created.executionId ?? null,
        txHash: created.txHash ?? null,
        txLink: created.txLink ?? null,
        khStatus: created.khStatus ?? 'prepared',
        errorCode: created.errorCode ?? null,
        revertReason: created.revertReason ?? null,
        gasUsedWei: created.gasUsedWei ?? null,
        gasUsedUsdc: created.gasUsedUsdc ?? null,
        sponsored: created.sponsored ?? null,
      });
    }
    const findFirst = (
      attemptDelegate as unknown as {
        findFirst?: (args: unknown) => Promise<ReturnType<typeof asPersisted> | null>;
      }
    ).findFirst;
    if (findFirst === undefined) {
      const created = await tx.attempt.create({
        data: { itemId, attemptNo, kind, khStatus: 'prepared' },
      });
      return asPersisted({
        ...created,
        executionId: created.executionId ?? null,
        txHash: created.txHash ?? null,
        txLink: created.txLink ?? null,
        khStatus: created.khStatus ?? 'prepared',
        errorCode: created.errorCode ?? null,
        revertReason: created.revertReason ?? null,
        gasUsedWei: created.gasUsedWei ?? null,
        gasUsedUsdc: created.gasUsedUsdc ?? null,
        sponsored: created.sponsored ?? null,
      });
    }
    const existing = await findFirst({
      where: { itemId, attemptNo, kind },
      orderBy: { createdAt: 'asc' },
    });
    if (existing !== null) return asPersisted(existing);
    const created = await tx.attempt.create({
      data: { itemId, attemptNo, kind, khStatus: 'prepared' },
    });
    return asPersisted(created);
  });
}

/** Store the external identity before any status polling. */
export async function persistExecutionId(
  attemptId: string,
  write: WriteResult,
): Promise<PersistedAttempt> {
  const update = (
    prisma.attempt as unknown as {
      update?: (args: unknown) => Promise<Parameters<typeof asPersisted>[0]>;
    }
  ).update;
  if (update === undefined) {
    return {
      id: attemptId,
      itemId: '',
      attemptNo: 0,
      kind: 'EXECUTE',
      executionId: write.executionId,
      txHash:
        write.transactionHash === undefined
          ? null
          : Buffer.from(write.transactionHash.slice(2), 'hex'),
      txLink: write.transactionLink ?? null,
      khStatus: write.status,
      errorCode: null,
      revertReason: null,
      gasUsedWei: null,
      gasUsedUsdc: null,
      sponsored: write.sponsored ?? null,
    };
  }
  const updated = await update({
    where: { id: attemptId },
    data: {
      executionId: write.executionId,
      khStatus: write.status,
      txHash:
        write.transactionHash === undefined
          ? null
          : Buffer.from(write.transactionHash.slice(2), 'hex'),
      txLink: write.transactionLink ?? null,
    },
  });
  return asPersisted(updated);
}

/** Persist the real terminal record; no hash is synthesised for a missing one. */
export async function persistObservation(
  attemptId: string,
  observation: ExecutionObservation,
  fields: {
    readonly gasUsedWei?: Prisma.Decimal | null;
    readonly gasUsedUsdc?: Prisma.Decimal | null;
    readonly sponsored?: boolean | null;
  } = {},
): Promise<void> {
  const status = observation.status;
  const update = (prisma.attempt as unknown as { update?: (args: unknown) => Promise<unknown> })
    .update;
  if (update === undefined) return;
  await update({
    where: { id: attemptId },
    data: {
      executionId: status.executionId,
      khStatus: status.status,
      txHash:
        status.transactionHash === undefined
          ? null
          : Buffer.from(status.transactionHash.slice(2), 'hex'),
      txLink: status.transactionLink ?? null,
      errorCode:
        observation.outcome === 'retry'
          ? observation.code
          : observation.outcome === 'failed'
            ? (observation.code ?? null)
            : null,
      revertReason: observation.outcome === 'failed' ? observation.reason : null,
      ...(fields.gasUsedWei === undefined ? {} : { gasUsedWei: fields.gasUsedWei }),
      ...(fields.gasUsedUsdc === undefined ? {} : { gasUsedUsdc: fields.gasUsedUsdc }),
      ...(fields.sponsored === undefined ? {} : { sponsored: fields.sponsored }),
    },
  });
}

/** Record a submission failure that produced no execution id. */
export async function persistSubmissionError(
  attemptId: string,
  args: { readonly status: string; readonly code?: string; readonly reason: string },
): Promise<void> {
  const update = (prisma.attempt as unknown as { update?: (args: unknown) => Promise<unknown> })
    .update;
  if (update === undefined) return;
  await update({
    where: { id: attemptId },
    data: {
      khStatus: args.status,
      errorCode: args.code ?? null,
      revertReason: args.reason,
    },
  });
}

/**
 * Poll an already-recorded execution. `pollUntilTerminal` honours
 * X-Poll-Interval-Hint, including zero. A poll timeout is allowed to throw so
 * BullMQ retries the same durable job and execution id later.
 */
export async function pollPersistedExecution(
  kh: KhClient,
  attempt: PersistedAttempt,
  options: { readonly maxPolls?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<StatusResult> {
  if (attempt.executionId === null) {
    throw new Error(`attempt ${attempt.id} has no executionId to poll`);
  }
  const write: WriteResult = {
    executionId: attempt.executionId,
    status: attempt.khStatus ?? 'pending',
    ...(attempt.txHash === null ? {} : { transactionHash: bytesToHex(attempt.txHash) }),
    ...(attempt.txLink === null ? {} : { transactionLink: attempt.txLink }),
    terminal:
      attempt.txHash !== null &&
      (attempt.khStatus === 'completed' || attempt.khStatus === 'failed'),
    httpStatus: 202,
    raw: null,
  };
  return await pollUntilTerminal(kh, write, options);
}

/** Apply the frozen completed/hash and transient/config-revert table. */
export function classifyExecutionStatus(status: StatusResult): ExecutionObservation {
  if (status.status === 'completed') {
    if (status.transactionHash !== undefined) {
      return { outcome: 'landed', status, txHash: status.transactionHash };
    }
    return {
      outcome: 'failed',
      status,
      reason: 'KeeperHub reported completed without a transactionHash',
    };
  }

  if (status.status === 'failed') {
    const code = transientRunErrorCode(status.raw);
    if (code !== undefined) return { outcome: 'retry', status, code };
    return {
      outcome: 'failed',
      status,
      reason: failureMessage(status.raw) ?? 'KeeperHub execution failed without a transient code',
    };
  }

  // pollUntilTerminal normally prevents this branch. Keep it explicit so a
  // future status vocabulary change cannot be mistaken for a landed write.
  return {
    outcome: 'failed',
    status,
    reason: `KeeperHub status ${status.status} was not terminal`,
  };
}

function failureMessage(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw !== '') return raw;
  if (raw === null || typeof raw !== 'object') return undefined;
  const body = raw as Record<string, unknown>;
  for (const key of ['revertReason', 'error', 'message', 'detail']) {
    const value = body[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Latest attempt of a kind, used on startup before deciding to submit. */
export async function latestAttempt(
  itemId: string,
  kind: RecoverableAttemptKind,
): Promise<PersistedAttempt | undefined> {
  const findFirst = (
    prisma.attempt as unknown as {
      findFirst?: (args: unknown) => Promise<Parameters<typeof asPersisted>[0] | null>;
    }
  ).findFirst;
  if (findFirst === undefined) return undefined;
  const attempt = await findFirst({
    where: { itemId, kind },
    orderBy: [{ attemptNo: 'desc' }, { createdAt: 'desc' }],
  });
  return attempt === null ? undefined : asPersisted(attempt);
}
