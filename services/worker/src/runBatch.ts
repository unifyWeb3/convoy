// End-to-end run driver: RECEIVED → SEALED_OK/SEALED_PARTIAL.
//
// Phase orchestration is serial. Within EXECUTE, ready items dispatch at the
// canonical EXECUTE_FANOUT default of 1; wider fanout is an explicit
// measurement/rehearsal override and is not current stability evidence.

import { randomBytes } from 'node:crypto';

import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import { KhClient } from '@convoy/kh-client';

import { EXECUTE_FANOUT } from './config.js';
import { isLow, remaining, type BudgetState } from './budget.js';
import {
  executeItem,
  phaseCritique,
  phaseOpen,
  phasePlan,
  phaseSeal,
  releaseDeferred,
  plannerPriority,
  setRunStatus,
  type ExecuteOutcome,
  type OrchestratorDeps,
  type PlannerPort,
} from './orchestrator.js';

export interface RunResult {
  readonly runId: string;
  readonly runIdOnchain: string;
  readonly openTx?: string;
  readonly sealTx?: string;
  readonly status: string;
  readonly executed: readonly ExecuteOutcome[];
  readonly vetoed: readonly { idx: number; reason: string }[];
  readonly budget: BudgetState;
  /**
   * What the org Turnkey wallet actually paid, in USDC at the frozen rate — the
   * sum over items where the execution record said `sponsored:false` (DEC-010).
   * `budget.spentGasUsdc` is the different, larger figure: gas CONSUMED.
   */
  readonly walletDebitedUsdc: Prisma.Decimal;
  /** Items whose execution record carried no `sponsored` flag at all. */
  readonly unknownPayerCount: number;
}

function budgetFromRun(run: {
  budgetUsdc: Prisma.Decimal | string;
  spentGasUsdc: Prisma.Decimal | string;
  spentPayUsdc: Prisma.Decimal | string;
}): BudgetState {
  return {
    budgetUsdc: new Prisma.Decimal(run.budgetUsdc),
    spentGasUsdc: new Prisma.Decimal(run.spentGasUsdc),
    spentPayUsdc: new Prisma.Decimal(run.spentPayUsdc),
  };
}

async function loadBudget(runId: string): Promise<BudgetState> {
  return budgetFromRun(await prisma.run.findUniqueOrThrow({ where: { id: runId } }));
}

async function persistedWalletEvidence(runId: string): Promise<{
  readonly walletDebitedUsdc: Prisma.Decimal;
  readonly unknownPayerCount: number;
}> {
  const [attempts, events] = await Promise.all([
    prisma.attempt.findMany({
      where: {
        item: { runId },
        kind: { in: ['COMMIT', 'EXECUTE'] },
        executionId: { not: null },
      },
      select: { executionId: true, gasUsedUsdc: true, sponsored: true },
    }),
    prisma.event.findMany({
      where: {
        runId,
        itemIdx: null,
        type: { in: ['RUN_OPENED', 'RUN_SEALED', 'RUN_SEALED_PARTIAL', 'ITEM_FAILED'] },
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  let debited = new Prisma.Decimal(0);
  let unknown = 0;
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const executionId = attempt.executionId;
    if (executionId === null || seen.has(`attempt:${executionId}`)) continue;
    seen.add(`attempt:${executionId}`);
    if (attempt.sponsored === false && attempt.gasUsedUsdc !== null) {
      debited = debited.add(attempt.gasUsedUsdc);
    } else if (attempt.sponsored === null) {
      unknown += 1;
    }
  }
  for (const event of events) {
    const value = event.payload;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const payload = value as Record<string, unknown>;
    const phase = payload['phase'];
    const executionId = payload['executionId'];
    if (
      (phase !== 'open' && phase !== 'seal') ||
      typeof executionId !== 'string' ||
      seen.has(`run:${phase}:${executionId}`)
    ) {
      continue;
    }
    seen.add(`run:${phase}:${executionId}`);
    const sponsored = payload['sponsored'];
    const gas = payload['gasUsdcConsumed'];
    if (sponsored === false && typeof gas === 'string') {
      debited = debited.add(gas);
    } else if (sponsored === null) {
      unknown += 1;
    }
  }
  return { walletDebitedUsdc: debited, unknownPayerCount: unknown };
}

/** Run every ready item, at most `fanout` in flight at once. */
async function dispatchConcurrently(
  ready: readonly number[],
  fanout: number,
  run: (idx: number) => Promise<ExecuteOutcome>,
): Promise<ExecuteOutcome[]> {
  const results: ExecuteOutcome[] = [];
  const queue = [...ready];
  const workers = Array.from({ length: Math.min(fanout, queue.length) }, async () => {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) return;
      results.push(await run(idx));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runBatch(
  deps: OrchestratorDeps,
  runId: string,
  options: { fanout?: number; ablation?: 'planner' | 'critic'; planner?: PlannerPort } = {},
): Promise<RunResult> {
  const log = deps.log ?? ((): void => {});
  const fanout = options.fanout ?? EXECUTE_FANOUT;
  const runIdOnchain = `0x${randomBytes(32).toString('hex')}`;

  let runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  let budget = budgetFromRun(runRow);
  const runEthUsd = new Prisma.Decimal(runRow.runEthUsd);

  const openTx = await phaseOpen(
    deps,
    runId,
    runRow.runIdOnchain === null
      ? runIdOnchain
      : `0x${Buffer.from(runRow.runIdOnchain).toString('hex')}`,
  );
  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  // openRun is a real registry write and therefore part of every subsequent
  // budget decision. Never critique against the pre-open meter snapshot.
  budget = budgetFromRun(runRow);
  const effectiveRunIdOnchain =
    runRow.runIdOnchain === null
      ? runIdOnchain
      : `0x${Buffer.from(runRow.runIdOnchain).toString('hex')}`;
  if (runRow.status === 'PLANNING') {
    await phasePlan(runId, {
      ablatePlanner: options.ablation === 'planner',
      registryAddr: deps.registryAddr,
      ...(options.planner === undefined ? {} : { planner: options.planner }),
    });
    // phasePlan advances the persisted run to CRITIQUING. Refresh the row
    // before selecting the next phase; retaining the pre-plan PLANNING value
    // would skip simulation/Critic on every fresh queue-started run.
    runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  }

  // CRITIQUING — every non-deferred item, zero gas. Simulate, then the Critic,
  // with at most one re-plan cycle (CVY-011).
  const critique =
    runRow.status === 'CRITIQUING'
      ? await phaseCritique(deps, runId, budget, {
          ...(options.ablation === 'critic' ? { bypassGate: true } : {}),
        })
      : {
          ready: [] as number[],
          vetoed: [],
          failedIdx: [],
          replanCycles: 0,
          notes: [] as string[],
          criticConsulted: false,
        };
  const existingItems = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
  const vetoed = existingItems
    .filter((i) => i.state === 'VETOED')
    .map((i) => ({ idx: i.idx, reason: i.vetoReason ?? 'vetoed' }));
  const ready = [
    ...new Set([
      ...critique.ready,
      ...existingItems
        .filter((i) => ['SIMULATED', 'COMMITTED', 'SUBMITTED', 'RETRYING'].includes(i.state))
        .map((i) => i.idx),
    ]),
  ];
  const priority = new Map(
    plannerPriority(
      runRow.plan,
      existingItems.map((item) => item.idx),
    ).map((idx, position) => [idx, position]),
  );
  ready.sort(
    (left, right) => (priority.get(left) ?? left) - (priority.get(right) ?? right) || left - right,
  );
  for (const note of critique.notes) log(`  critique: ${note}`);

  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (runRow.status === 'CRITIQUING') {
    await setRunStatus(runId, 'EXECUTING', 'PLAN_READY', {
      ready,
      vetoed: vetoed.map((v) => v.idx),
      failed: critique.failedIdx,
      replanCycles: critique.replanCycles,
      notes: critique.notes,
      criticConsulted: critique.criticConsulted,
    });
  }

  const executed: ExecuteOutcome[] = [];
  let wave = ready;
  while (wave.length > 0) {
    const beforeWave = budget;
    log(`  EXECUTE wave of ${wave.length} at fanout=${fanout}`);
    const outcomes = await dispatchConcurrently(wave, fanout, async (idx) =>
      executeItem(deps, runId, idx, effectiveRunIdOnchain, runEthUsd),
    );
    executed.push(...outcomes);

    // COMMIT and target gas are persisted transactionally by executeItem. The
    // database is the meter; re-deriving from return values would double-count
    // recovered/already-accounted outcomes and omit commitAction gas.
    budget = await loadBudget(runId);
    if (!isLow(beforeWave) && isLow(budget)) {
      const existingLow = await prisma.event.findFirst({ where: { runId, type: 'BUDGET_LOW' } });
      if (existingLow === null) {
        const wallet = await persistedWalletEvidence(runId);
        await prisma.event.create({
          data: {
            runId,
            itemIdx: outcomes.at(-1)?.idx ?? null,
            type: 'BUDGET_LOW',
            payload: {
              remainingUsdc: remaining(budget).toFixed(6),
              consumedUsdc: budget.spentGasUsdc.toFixed(6),
              walletDebitedUsdc: wallet.walletDebitedUsdc.toFixed(6),
            },
          },
        });
      }
    }

    // App-side deferral gate: dependencies just landed, so re-evaluate.
    wave = await releaseDeferred(deps, runId, budget, {
      ...(options.ablation === 'critic' ? { bypassGate: true } : {}),
    });
    if (wave.length > 0) log(`  deferral gate released ${wave.join(', ')}`);
  }

  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (runRow.status === 'SEALED_OK' || runRow.status === 'SEALED_PARTIAL') {
    budget = budgetFromRun(runRow);
    const wallet = await persistedWalletEvidence(runId);
    const sealedEvent = await prisma.event.findFirst({
      where: { runId, type: runRow.status === 'SEALED_OK' ? 'RUN_SEALED' : 'RUN_SEALED_PARTIAL' },
      orderBy: { id: 'desc' },
    });
    const payload = sealedEvent?.payload;
    const tx =
      payload !== null && typeof payload === 'object'
        ? (payload as { txHash?: unknown }).txHash
        : undefined;
    return {
      runId,
      runIdOnchain: effectiveRunIdOnchain,
      openTx,
      ...(typeof tx === 'string' ? { sealTx: tx } : {}),
      status: runRow.status,
      executed,
      vetoed,
      budget,
      ...wallet,
    };
  }
  const sealed = await phaseSeal(deps, runId, effectiveRunIdOnchain, budget);
  // sealRun is also a registry write; the returned snapshot must include it.
  budget = await loadBudget(runId);
  const wallet = await persistedWalletEvidence(runId);

  return {
    runId,
    runIdOnchain: effectiveRunIdOnchain,
    openTx,
    sealTx: sealed.txHash,
    status: sealed.status,
    executed,
    vetoed,
    budget,
    ...wallet,
  };
}

export function khFromEnv(): KhClient {
  const key = process.env['KEEPERHUB_API_KEY'];
  if (key === undefined || key === '') throw new Error('KEEPERHUB_API_KEY not set');
  return new KhClient({
    apiKey: key,
    baseUrl: process.env['KEEPERHUB_BASE_URL'],
    chainId: '84532',
  });
}
