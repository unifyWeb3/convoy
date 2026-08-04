// End-to-end run driver: RECEIVED → SEALED_OK/SEALED_PARTIAL.
//
// Phase orchestration is serial. Within EXECUTE, ready items dispatch
// CONCURRENTLY at EXECUTE_FANOUT (DEC-002) so KeeperHub's nonce manager is what
// serializes them.

import { randomBytes } from 'node:crypto';

import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import { KhClient } from '@convoy/kh-client';

import { EXECUTE_FANOUT } from './config.js';
import { applyGas, composeGasFeeWei, type BudgetState } from './budget.js';
import {
  critiqueItem,
  executeItem,
  phaseOpen,
  phasePlan,
  phaseSeal,
  releaseDeferred,
  setRunStatus,
  type ExecuteOutcome,
  type OrchestratorDeps,
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
  options: { fanout?: number } = {},
): Promise<RunResult> {
  const log = deps.log ?? ((): void => {});
  const fanout = options.fanout ?? EXECUTE_FANOUT;
  const runIdOnchain = `0x${randomBytes(32).toString('hex')}`;

  const runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  let budget: BudgetState = {
    budgetUsdc: new Prisma.Decimal(runRow.budgetUsdc),
    spentGasUsdc: new Prisma.Decimal(runRow.spentGasUsdc),
    spentPayUsdc: new Prisma.Decimal(runRow.spentPayUsdc),
  };
  const runEthUsd = new Prisma.Decimal(runRow.runEthUsd);

  const openTx = await phaseOpen(deps, runId, runIdOnchain);
  await phasePlan(runId);

  // CRITIQUING — every non-deferred item, zero gas.
  const planned = await prisma.item.findMany({
    where: { runId, state: 'PLANNED' },
    orderBy: { idx: 'asc' },
  });
  const vetoed: { idx: number; reason: string }[] = [];
  const ready: number[] = [];
  for (const item of planned) {
    const v = await critiqueItem(deps, runId, item.idx, budget);
    log(`  critique idx=${item.idx} ${v.approved ? 'APPROVE' : 'VETO'} — ${v.reason}`);
    if (v.approved) ready.push(item.idx);
    else vetoed.push({ idx: item.idx, reason: v.reason });
  }

  await setRunStatus(runId, 'EXECUTING', 'PLAN_READY', { ready, vetoed: vetoed.map((v) => v.idx) });

  const executed: ExecuteOutcome[] = [];
  let wave = ready;
  while (wave.length > 0) {
    log(`  EXECUTE wave of ${wave.length} at fanout=${fanout}`);
    const outcomes = await dispatchConcurrently(wave, fanout, async (idx) =>
      executeItem(deps, runId, idx, runIdOnchain),
    );
    executed.push(...outcomes);

    // Drain the meter from REAL gas. `gasUsedUnits` is units, not wei (G-28).
    for (const o of outcomes) {
      if (!o.landed || o.gasUsedUnits === undefined) continue;
      const fee = composeGasFeeWei({
        gasUsedUnits: o.gasUsedUnits,
        gasPriceWei: o.gasPriceWei ?? '0',
      });
      const u = applyGas(budget, fee, runEthUsd);
      budget = u.next;
      if (u.crossedLow) {
        await prisma.event.create({
          data: {
            runId,
            itemIdx: o.idx,
            type: 'BUDGET_LOW',
            payload: { remainingUsdc: budget.budgetUsdc.sub(u.next.spentGasUsdc).toFixed(6) },
          },
        });
      }
    }
    await prisma.run.update({
      where: { id: runId },
      data: { spentGasUsdc: budget.spentGasUsdc, spentPayUsdc: budget.spentPayUsdc },
    });

    // App-side deferral gate: dependencies just landed, so re-evaluate.
    wave = await releaseDeferred(deps, runId, budget);
    if (wave.length > 0) log(`  deferral gate released ${wave.join(', ')}`);
  }

  const sealed = await phaseSeal(deps, runId, runIdOnchain, budget);

  return {
    runId,
    runIdOnchain,
    openTx,
    sealTx: sealed.txHash,
    status: sealed.status,
    executed,
    vetoed,
    budget,
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
