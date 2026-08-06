import { db, bytesToHex, type Attempt, type Event, type Item } from '@convoy/db';

export interface TimelineEvent {
  readonly id: string;
  readonly runId: string;
  readonly itemIdx: number | null;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface TimelineAttempt {
  readonly attemptNo: number;
  readonly kind: string;
  readonly executionId: string | null;
  readonly transactionHash: string | null;
  readonly transactionLink: string | null;
  readonly gasUsedWei: string | null;
  readonly gasUsedUsdc: string | null;
  readonly sponsored: boolean | null;
  readonly wouldRevert: boolean | null;
  readonly revertReason: string | null;
  readonly khStatus: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

export interface TimelineItem {
  readonly idx: number;
  readonly targetAddress: string;
  readonly functionName: string;
  readonly functionArgs: unknown;
  readonly evidence: string;
  readonly plannerRationale: string | null;
  readonly state: string;
  readonly dependsOn: readonly number[];
  readonly gasBudgetUsdc: string | null;
  readonly vetoReason: string | null;
  readonly attempts: readonly TimelineAttempt[];
}

export interface TimelineSnapshot {
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly budgetUsdc: string;
    readonly spentGasUsdc: string;
    readonly spentPayUsdc: string;
    readonly deadline: string | null;
    readonly plan: unknown;
  };
  readonly items: readonly TimelineItem[];
  readonly events: readonly TimelineEvent[];
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toEvent(event: Event): TimelineEvent {
  return {
    id: event.id.toString(),
    runId: event.runId,
    itemIdx: event.itemIdx,
    type: event.type,
    payload: jsonObject(event.payload),
    at: event.at.toISOString(),
  };
}

function toAttempt(attempt: Attempt): TimelineAttempt {
  return {
    attemptNo: attempt.attemptNo,
    kind: attempt.kind,
    executionId: attempt.executionId,
    transactionHash: attempt.txHash === null ? null : bytesToHex(attempt.txHash),
    transactionLink: attempt.txLink,
    gasUsedWei: attempt.gasUsedWei?.toString() ?? null,
    gasUsedUsdc: attempt.gasUsedUsdc?.toString() ?? null,
    sponsored: attempt.sponsored,
    wouldRevert: attempt.wouldRevert,
    revertReason: attempt.revertReason,
    khStatus: attempt.khStatus,
    errorCode: attempt.errorCode,
    createdAt: attempt.createdAt.toISOString(),
  };
}

function plannerRationale(plan: unknown, idx: number): string | null {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const rows = (plan as Record<string, unknown>)['rationalePerItem'];
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record['idx'] === idx && typeof record['rationale'] === 'string') {
      return record['rationale'];
    }
  }
  return null;
}

function toItem(item: Item & { attempts: Attempt[] }, plan: unknown): TimelineItem {
  return {
    idx: item.idx,
    targetAddress: bytesToHex(item.targetAddr),
    functionName: item.functionName,
    functionArgs: item.functionArgs,
    evidence: item.evidence,
    plannerRationale: plannerRationale(plan, item.idx),
    state: item.state,
    dependsOn: item.dependsOn,
    gasBudgetUsdc: item.gasBudgetUsdc?.toString() ?? null,
    vetoReason: item.vetoReason,
    attempts: [...item.attempts].sort((a, b) => a.attemptNo - b.attemptNo).map(toAttempt),
  };
}

export async function readEventsAfter(runId: string, lastId: bigint): Promise<TimelineEvent[]> {
  const events = await db.event.findMany({
    where: { runId, id: { gt: lastId } },
    orderBy: { id: 'asc' },
  });
  return events.map(toEvent);
}

export async function readRunStatus(runId: string): Promise<string | null> {
  const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
  return run?.status ?? null;
}

export async function loadTimeline(runId: string): Promise<TimelineSnapshot | null> {
  const run = await db.run.findUnique({
    where: { id: runId },
    include: {
      items: { include: { attempts: true }, orderBy: { idx: 'asc' } },
      events: { orderBy: { id: 'asc' } },
    },
  });
  if (run === null) return null;
  return {
    run: {
      id: run.id,
      status: run.status,
      budgetUsdc: run.budgetUsdc.toString(),
      spentGasUsdc: run.spentGasUsdc.toString(),
      spentPayUsdc: run.spentPayUsdc.toString(),
      deadline: run.deadline?.toISOString() ?? null,
      plan: run.plan,
    },
    items: run.items.map((item) => toItem(item, run.plan)),
    events: run.events.map(toEvent),
  };
}

export function encodeSseEvent(event: TimelineEvent): string {
  return `id: ${event.id}\nevent: convoy\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseLastEventId(raw: string | null): bigint {
  if (raw === null || raw.trim() === '') return 0n;
  if (!/^\d+$/.test(raw.trim())) return 0n;
  try {
    return BigInt(raw.trim());
  } catch {
    return 0n;
  }
}

export function isTerminalRun(status: string): boolean {
  return new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']).has(status);
}
