import { createHash } from 'node:crypto';

import { Prisma, bytesToHex, db, type Attempt, type Event, type Item, type Run } from '@convoy/db';
import { KhClient, getExecutionStatus, type StatusResult } from '@convoy/kh-client';
import type { Hex } from 'viem';

import {
  MANIFEST_CHAIN_ID,
  readRegistrySnapshot,
  type RegistryCommitEvent,
  type RegistryReadResult,
} from './registry';

const TERMINAL_RUN_STATES = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LedgerAttemptSnapshot {
  readonly attemptNo: number;
  readonly kind: string;
  readonly executionId: string | null;
  readonly transactionHash: Hex | null;
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

export interface LedgerEventSnapshot {
  readonly id: string;
  readonly itemIdx: number | null;
  readonly type: string;
  readonly payload: JsonValue;
  readonly at: string;
}

export interface LedgerItemSnapshot {
  readonly idx: number;
  readonly targetAddress: Hex;
  readonly functionName: string;
  readonly functionArgs: JsonValue;
  readonly payloadHash: Hex;
  readonly evidence: string;
  readonly state: string;
  readonly dependsOn: readonly number[];
  readonly gasBudgetUsdc: string | null;
  readonly vetoReason: string | null;
  readonly attempts: readonly LedgerAttemptSnapshot[];
  readonly events: readonly LedgerEventSnapshot[];
}

export interface LedgerRunSnapshot {
  readonly id: string;
  readonly runIdOnchain: Hex;
  readonly status: string;
  readonly budgetUsdc: string;
  readonly spentGasUsdc: string;
  readonly spentPayUsdc: string;
  readonly runEthUsd: string;
  readonly deadline: string | null;
  readonly plan: JsonValue | null;
  readonly createdAt: string;
  readonly sealedAt: string | null;
  readonly snapshotAt: string;
  readonly items: readonly LedgerItemSnapshot[];
  readonly events: readonly LedgerEventSnapshot[];
}

export interface KeeperHubExecutionSnapshot {
  readonly available: boolean;
  readonly executionId: string;
  readonly status: string | null;
  readonly transactionHash: string | null;
  readonly transactionLink: string | null;
  /** Raw KeeperHub gasUsedWei field. Its meaning is disclosed separately (G-31). */
  readonly gasUsedWei: string | null;
  readonly gasUsedWeiMeaning: string | null;
  readonly sponsored: boolean | null;
  readonly error: string | null;
}

export interface ReconciliationCheck {
  readonly name: string;
  readonly agrees: boolean;
  readonly detail: string;
}

export interface ManifestRow {
  readonly idx: number;
  readonly verdict: 'green' | 'amber';
  readonly keeperHub: {
    readonly commit: KeeperHubExecutionSnapshot | null;
    readonly executions: readonly KeeperHubExecutionSnapshot[];
  };
  readonly registry: {
    readonly available: boolean;
    readonly commitEvent: RegistryCommitEvent | null;
    readonly committedInStorage: boolean | null;
    readonly payloadHashInStorage: Hex | null;
    readonly error: string | null;
  };
  readonly ledger: LedgerItemSnapshot;
  readonly checks: readonly ReconciliationCheck[];
}

export interface ManifestPayload {
  readonly schemaVersion: 1;
  readonly sources: {
    readonly keeperHub: {
      readonly directExecutionStatus: true;
      readonly keeperRunsAuditTrail: false;
      readonly note: string;
    };
    readonly registry: { readonly rpcVariable: 'BASE_RPC_URL'; readonly chainId: 84532 };
    readonly ledger: { readonly tables: readonly ['runs', 'items', 'attempts', 'events'] };
  };
  readonly run: {
    readonly id: string;
    readonly runIdOnchain: Hex;
    readonly status: string;
    readonly chainId: typeof MANIFEST_CHAIN_ID;
    readonly registryAddress: string | null;
    readonly createdAt: string;
    readonly sealedAt: string | null;
    readonly snapshotAt: string;
    readonly deadline: string | null;
    readonly plan: JsonValue | null;
    readonly ledgerEvents: readonly LedgerEventSnapshot[];
    readonly budget: {
      readonly budgetUsdc: string;
      readonly spentGasUsdc: string;
      readonly spentPayUsdc: string;
      readonly runEthUsd: string;
    };
  };
  readonly reconciliation: {
    readonly verdict: 'green' | 'amber';
    readonly runChecks: readonly ReconciliationCheck[];
    readonly rows: readonly ManifestRow[];
  };
}

export interface ManifestDocument extends ManifestPayload {
  /** sha256 over canonical JSON of every other field in this document. */
  readonly sha256: `0x${string}`;
}

export class ManifestNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} was not found`);
    this.name = 'ManifestNotFoundError';
  }
}

export class ManifestRunNotTerminalError extends Error {
  constructor(runId: string, status: string) {
    super(`run ${runId} is ${status}; export is available after the run reaches a terminal state`);
    this.name = 'ManifestRunNotTerminalError';
  }
}

function lower(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

function sameHex(left: string | null, right: string | null): boolean {
  return lower(left) === lower(right);
}

function check(name: string, agrees: boolean, detail: string): ReconciliationCheck {
  return { name, agrees, detail };
}

function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stamp(payload: ManifestPayload): ManifestDocument {
  const digest = createHash('sha256')
    .update(canonicalJson(asJson(payload)))
    .digest('hex');
  return { ...payload, sha256: `0x${digest}` };
}

export function verifyManifest(document: ManifestDocument): boolean {
  if (typeof document.sha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(document.sha256)) {
    return false;
  }
  const { sha256, ...payload } = document;
  return stamp(payload).sha256 === sha256;
}

function executionSnapshot(
  executionId: string,
  result: StatusResult | Error,
): KeeperHubExecutionSnapshot {
  if (result instanceof Error) {
    return {
      available: false,
      executionId,
      status: null,
      transactionHash: null,
      transactionLink: null,
      gasUsedWei: null,
      gasUsedWeiMeaning: null,
      sponsored: null,
      error: result.message,
    };
  }
  return {
    available: true,
    executionId,
    status: result.status,
    transactionHash: result.transactionHash ?? null,
    transactionLink: result.transactionLink ?? null,
    gasUsedWei: result.gasReportedRaw ?? null,
    gasUsedWeiMeaning: result.gasReportedMeaning ?? null,
    sponsored: result.sponsored ?? null,
    error: null,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const position = cursor;
      cursor += 1;
      const value = values[position];
      if (value === undefined) return;
      output[position] = await fn(value);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function readKeeperHubExecutions(
  executionIds: readonly string[],
  reader?: (executionId: string) => Promise<StatusResult>,
): Promise<ReadonlyMap<string, KeeperHubExecutionSnapshot>> {
  const ids = [...new Set(executionIds)].sort();
  if (ids.length === 0) return new Map();

  let statusReader = reader;
  if (statusReader === undefined) {
    const apiKey = process.env['KEEPERHUB_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      return new Map(
        ids.map((executionId) => [
          executionId,
          executionSnapshot(executionId, new Error('KEEPERHUB_API_KEY is not set')),
        ]),
      );
    }
    const client = new KhClient({
      apiKey,
      baseUrl: process.env['KEEPERHUB_BASE_URL'],
      chainId: '84532',
    });
    statusReader = (executionId) => getExecutionStatus(client, executionId);
  }

  const entries = await mapConcurrent(ids, 4, async (executionId) => {
    try {
      return [
        executionId,
        executionSnapshot(executionId, await statusReader(executionId)),
      ] as const;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return [executionId, executionSnapshot(executionId, failure)] as const;
    }
  });
  return new Map(entries);
}

function keeperHubCheck(
  label: string,
  attempt: LedgerAttemptSnapshot,
  remote: KeeperHubExecutionSnapshot | null,
): ReconciliationCheck {
  if (attempt.executionId === null) {
    return check(label, false, 'ledger attempt has no KeeperHub executionId');
  }
  if (remote === null || !remote.available) {
    return check(label, false, remote?.error ?? 'KeeperHub status was not available');
  }
  const statusMatches = attempt.khStatus === null || attempt.khStatus === remote.status;
  const hashMatches =
    attempt.transactionHash === null || sameHex(attempt.transactionHash, remote.transactionHash);
  return check(
    label,
    statusMatches && hashMatches,
    statusMatches && hashMatches
      ? `status ${remote.status ?? 'unknown'} and transaction hash match the ledger`
      : `ledger (${attempt.khStatus ?? 'unknown'}, ${attempt.transactionHash ?? 'no hash'}) differs from KeeperHub (${remote.status ?? 'unknown'}, ${remote.transactionHash ?? 'no hash'})`,
  );
}

function registryColumn(registry: RegistryReadResult, idx: number): ManifestRow['registry'] {
  if (!registry.available) {
    return {
      available: false,
      commitEvent: null,
      committedInStorage: null,
      payloadHashInStorage: null,
      error: registry.error,
    };
  }
  const events = registry.commitEvents.filter((event) => event.idx === idx);
  const state = registry.itemState.find((item) => item.idx === idx);
  return {
    available: true,
    commitEvent: events.length === 1 ? (events[0] ?? null) : null,
    committedInStorage: state?.committed ?? null,
    payloadHashInStorage: state?.payloadHash ?? null,
    error:
      events.length > 1 ? `${events.length} ActionCommitted events found for item ${idx}` : null,
  };
}

function eventTransactionHash(
  events: readonly LedgerEventSnapshot[],
  types: readonly string[],
): Hex | undefined {
  for (const event of events) {
    if (!types.includes(event.type)) continue;
    if (
      typeof event.payload !== 'object' ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      continue;
    }
    const txHash = event.payload['txHash'];
    if (typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) return txHash as Hex;
  }
  return undefined;
}

function reconcileRow(
  item: LedgerItemSnapshot,
  statuses: ReadonlyMap<string, KeeperHubExecutionSnapshot>,
  registry: RegistryReadResult,
): ManifestRow {
  const commitAttempts = item.attempts.filter((attempt) => attempt.kind === 'COMMIT');
  const executeAttempts = item.attempts.filter((attempt) => attempt.kind === 'EXECUTE');
  const commitAttempt = commitAttempts.at(-1) ?? null;
  const commitRemote =
    commitAttempt?.executionId === null || commitAttempt?.executionId === undefined
      ? null
      : (statuses.get(commitAttempt.executionId) ?? null);
  const executionRemote = executeAttempts.map((attempt) =>
    attempt.executionId === null
      ? executionSnapshot(
          `missing:${item.idx}:${attempt.attemptNo}`,
          new Error('missing executionId'),
        )
      : (statuses.get(attempt.executionId) ??
        executionSnapshot(attempt.executionId, new Error('status was not read'))),
  );
  const registrySource = registryColumn(registry, item.idx);
  const expectedCommit = commitAttempt !== null;

  const checks: ReconciliationCheck[] = [];
  if (commitAttempts.length > 1) {
    checks.push(
      check(
        'one-ledger-commit-attempt',
        false,
        `${commitAttempts.length} COMMIT attempts were recorded`,
      ),
    );
  }
  if (commitAttempt !== null) {
    checks.push(keeperHubCheck('keeperhub-commit-matches-ledger', commitAttempt, commitRemote));
  }
  executeAttempts.forEach((attempt, position) => {
    checks.push(
      keeperHubCheck(
        `keeperhub-execute-${attempt.attemptNo}-matches-ledger`,
        attempt,
        executionRemote[position] ?? null,
      ),
    );
  });

  if (!registrySource.available) {
    checks.push(check('registry-available', false, registrySource.error ?? 'registry unavailable'));
  } else {
    const eventPresent = registrySource.commitEvent !== null;
    const storagePresent = registrySource.committedInStorage === true;
    checks.push(
      check(
        'registry-commit-presence',
        eventPresent === expectedCommit && storagePresent === expectedCommit,
        `ledger expects commit=${expectedCommit}; event=${eventPresent}; storage=${storagePresent}`,
      ),
    );
    if (expectedCommit) {
      checks.push(
        check(
          'registry-payload-hash',
          sameHex(registrySource.commitEvent?.payloadHash ?? null, item.payloadHash) &&
            sameHex(registrySource.payloadHashInStorage, item.payloadHash),
          `ledger=${item.payloadHash}; event=${registrySource.commitEvent?.payloadHash ?? 'missing'}; storage=${registrySource.payloadHashInStorage ?? 'missing'}`,
        ),
      );
      checks.push(
        check(
          'registry-commit-transaction',
          sameHex(
            registrySource.commitEvent?.transactionHash ?? null,
            commitRemote?.transactionHash ?? commitAttempt?.transactionHash ?? null,
          ),
          `registry=${registrySource.commitEvent?.transactionHash ?? 'missing'}; KeeperHub/ledger=${commitRemote?.transactionHash ?? commitAttempt?.transactionHash ?? 'missing'}`,
        ),
      );
    }
  }

  const lastExecution = executionRemote.at(-1) ?? null;
  const terminalConsistent =
    item.state !== 'LANDED' ||
    (lastExecution?.available === true &&
      lastExecution.status === 'completed' &&
      lastExecution.transactionHash !== null);
  checks.push(
    check(
      'ledger-terminal-state',
      terminalConsistent,
      item.state === 'LANDED'
        ? terminalConsistent
          ? 'LANDED is backed by a completed KeeperHub execution with a transaction hash'
          : 'LANDED lacks a completed KeeperHub execution with a transaction hash'
        : `ledger reports ${item.state}; no LANDED claim is being inferred`,
    ),
  );

  return {
    idx: item.idx,
    verdict: checks.every((entry) => entry.agrees) ? 'green' : 'amber',
    keeperHub: { commit: commitRemote, executions: executionRemote },
    registry: registrySource,
    ledger: item,
    checks,
  };
}

function reconcileRun(run: LedgerRunSnapshot, registry: RegistryReadResult): ReconciliationCheck[] {
  if (!registry.available) {
    return [check('registry-run-available', false, registry.error)];
  }
  const checks = [
    check(
      'one-run-opened-event',
      registry.openEvents.length === 1,
      `${registry.openEvents.length} RunOpened event(s) found`,
    ),
    check(
      'registry-operator-binding',
      registry.openEvents.length === 1 &&
        sameHex(registry.openEvents[0]?.operator ?? null, registry.runState.operator),
      `RunOpened operator=${registry.openEvents[0]?.operator ?? 'missing'}; storage operator=${registry.runState.operator}`,
    ),
  ];
  const openedTx = eventTransactionHash(run.events, ['RUN_OPENED']);
  checks.push(
    check(
      'run-open-transaction',
      registry.openEvents.length === 1 &&
        openedTx !== undefined &&
        sameHex(registry.openEvents[0]?.transactionHash ?? null, openedTx),
      `registry=${registry.openEvents[0]?.transactionHash ?? 'missing'}; ledger=${openedTx ?? 'missing'}`,
    ),
  );
  const sealed = run.status === 'SEALED_OK' || run.status === 'SEALED_PARTIAL';
  const sealTx = eventTransactionHash(run.events, ['RUN_SEALED', 'RUN_SEALED_PARTIAL']);
  checks.push(
    check(
      'registry-seal-state',
      sealed
        ? registry.sealEvents.length === 1 && registry.runState.state === 'SEALED'
        : registry.sealEvents.length <= 1,
      `ledger status=${run.status}; seal events=${registry.sealEvents.length}; storage state=${registry.runState.state}`,
    ),
  );
  if (sealed) {
    checks.push(
      check(
        'run-seal-transaction',
        registry.sealEvents.length === 1 &&
          sealTx !== undefined &&
          sameHex(registry.sealEvents[0]?.transactionHash ?? null, sealTx),
        `registry=${registry.sealEvents[0]?.transactionHash ?? 'missing'}; ledger=${sealTx ?? 'missing'}`,
      ),
    );
  }
  const committedItems = run.items.filter((item) =>
    item.attempts.some((attempt) => attempt.kind === 'COMMIT'),
  ).length;
  checks.push(
    check(
      'registry-committed-count',
      registry.runState.committedCount === committedItems &&
        registry.commitEvents.length === committedItems &&
        (!sealed || registry.sealEvents[0]?.committedCount === committedItems),
      `ledger=${committedItems}; events=${registry.commitEvents.length}; storage=${registry.runState.committedCount}; seal=${registry.sealEvents[0]?.committedCount ?? 'missing'}`,
    ),
  );
  return checks;
}

export function buildManifest(args: {
  readonly ledger: LedgerRunSnapshot;
  readonly keeperHub: ReadonlyMap<string, KeeperHubExecutionSnapshot>;
  readonly registry: RegistryReadResult;
}): ManifestDocument {
  const rows = [...args.ledger.items]
    .sort((left, right) => left.idx - right.idx)
    .map((item) => reconcileRow(item, args.keeperHub, args.registry));
  const runChecks = reconcileRun(args.ledger, args.registry);
  const payload: ManifestPayload = {
    schemaVersion: 1,
    sources: {
      keeperHub: {
        directExecutionStatus: true,
        keeperRunsAuditTrail: false,
        note: 'No verified Keeper Runs audit-trail REST surface is claimed (G-36).',
      },
      registry: { rpcVariable: 'BASE_RPC_URL', chainId: MANIFEST_CHAIN_ID },
      ledger: { tables: ['runs', 'items', 'attempts', 'events'] },
    },
    run: {
      id: args.ledger.id,
      runIdOnchain: args.ledger.runIdOnchain,
      status: args.ledger.status,
      chainId: MANIFEST_CHAIN_ID,
      registryAddress: args.registry.contractAddress,
      createdAt: args.ledger.createdAt,
      sealedAt: args.ledger.sealedAt,
      snapshotAt: args.ledger.snapshotAt,
      deadline: args.ledger.deadline,
      plan: args.ledger.plan,
      ledgerEvents: args.ledger.events.filter((event) => event.itemIdx === null),
      budget: {
        budgetUsdc: args.ledger.budgetUsdc,
        spentGasUsdc: args.ledger.spentGasUsdc,
        spentPayUsdc: args.ledger.spentPayUsdc,
        runEthUsd: args.ledger.runEthUsd,
      },
    },
    reconciliation: {
      verdict:
        runChecks.every((entry) => entry.agrees) && rows.every((row) => row.verdict === 'green')
          ? 'green'
          : 'amber',
      runChecks,
      rows,
    },
  };
  return stamp(payload);
}

type RunWithItems = Run & {
  items: (Item & { attempts: Attempt[] })[];
  events: Event[];
};

function latestDate(run: RunWithItems): Date {
  const dates = [run.createdAt, ...(run.sealedAt === null ? [] : [run.sealedAt])];
  for (const item of run.items) {
    for (const attempt of item.attempts) dates.push(attempt.createdAt);
  }
  for (const event of run.events) dates.push(event.at);
  return dates.reduce((latest, value) => (value > latest ? value : latest));
}

function normalizeEvent(event: Event): LedgerEventSnapshot {
  return {
    id: event.id.toString(),
    itemIdx: event.itemIdx,
    type: event.type,
    payload: asJson(event.payload),
    at: event.at.toISOString(),
  };
}

function normalizeLedger(run: RunWithItems): LedgerRunSnapshot {
  if (run.runIdOnchain === null) {
    throw new Error(`run ${run.id} has no onchain run id`);
  }
  return {
    id: run.id,
    runIdOnchain: bytesToHex(run.runIdOnchain),
    status: run.status,
    budgetUsdc: run.budgetUsdc.toFixed(6),
    spentGasUsdc: run.spentGasUsdc.toFixed(6),
    spentPayUsdc: run.spentPayUsdc.toFixed(6),
    runEthUsd: run.runEthUsd.toFixed(6),
    deadline: run.deadline?.toISOString() ?? null,
    plan: run.plan === null ? null : asJson(run.plan),
    createdAt: run.createdAt.toISOString(),
    sealedAt: run.sealedAt?.toISOString() ?? null,
    snapshotAt: latestDate(run).toISOString(),
    items: run.items
      .sort((left, right) => left.idx - right.idx)
      .map((item) => ({
        idx: item.idx,
        targetAddress: bytesToHex(item.targetAddr),
        functionName: item.functionName,
        functionArgs: asJson(item.functionArgs),
        payloadHash: bytesToHex(item.payloadHash),
        evidence: item.evidence,
        state: item.state,
        dependsOn: [...item.dependsOn],
        gasBudgetUsdc: item.gasBudgetUsdc?.toFixed(6) ?? null,
        vetoReason: item.vetoReason,
        attempts: item.attempts
          .sort(
            (left, right) =>
              left.attemptNo - right.attemptNo ||
              left.createdAt.getTime() - right.createdAt.getTime(),
          )
          .map((attempt) => ({
            attemptNo: attempt.attemptNo,
            kind: attempt.kind,
            executionId: attempt.executionId,
            transactionHash: attempt.txHash === null ? null : bytesToHex(attempt.txHash),
            transactionLink: attempt.txLink,
            gasUsedWei: attempt.gasUsedWei?.toFixed(0) ?? null,
            gasUsedUsdc: attempt.gasUsedUsdc?.toFixed(6) ?? null,
            sponsored: attempt.sponsored,
            wouldRevert: attempt.wouldRevert,
            revertReason: attempt.revertReason,
            khStatus: attempt.khStatus,
            errorCode: attempt.errorCode,
            createdAt: attempt.createdAt.toISOString(),
          })),
        events: run.events.filter((event) => event.itemIdx === item.idx).map(normalizeEvent),
      })),
    events: run.events.map(normalizeEvent),
  };
}

function decodeCached(value: Prisma.JsonValue, sha256: Uint8Array): ManifestDocument {
  const document = value as unknown as ManifestDocument;
  if (!verifyManifest(document) || !sameHex(document.sha256, bytesToHex(sha256))) {
    throw new Error('cached manifest failed sha256 integrity verification');
  }
  return document;
}

export async function exportManifest(runId: string): Promise<ManifestDocument> {
  const cached = await db.manifest.findUnique({ where: { runId } });
  if (cached !== null) return decodeCached(cached.json, cached.sha256);

  const run = await db.run.findUnique({
    where: { id: runId },
    include: {
      items: { include: { attempts: true }, orderBy: { idx: 'asc' } },
      events: { orderBy: { id: 'asc' } },
    },
  });
  if (run === null) throw new ManifestNotFoundError(runId);
  if (!TERMINAL_RUN_STATES.has(run.status)) {
    throw new ManifestRunNotTerminalError(runId, run.status);
  }

  const ledger = normalizeLedger(run);
  const executionIds = ledger.items.flatMap((item) =>
    item.attempts.flatMap((attempt) =>
      attempt.executionId === null || !['COMMIT', 'EXECUTE'].includes(attempt.kind)
        ? []
        : [attempt.executionId],
    ),
  );
  const [keeperHub, registry] = await Promise.all([
    readKeeperHubExecutions(executionIds),
    readRegistrySnapshot({
      runIdOnchain: ledger.runIdOnchain,
      itemIndices: ledger.items.map((item) => item.idx),
      fromTransactionHash: eventTransactionHash(ledger.events, ['RUN_OPENED']),
      toTransactionHash: eventTransactionHash(ledger.events, ['RUN_SEALED', 'RUN_SEALED_PARTIAL']),
    }),
  ]);
  const document = buildManifest({ ledger, keeperHub, registry });
  const shaBytes = Buffer.from(document.sha256.slice(2), 'hex');

  const stored = await db.manifest.upsert({
    where: { runId },
    create: { runId, json: asJson(document) as Prisma.InputJsonValue, sha256: shaBytes },
    update: {},
  });
  return decodeCached(stored.json, stored.sha256);
}
