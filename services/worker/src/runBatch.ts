// End-to-end run driver: RECEIVED → SEALED_OK/SEALED_PARTIAL.
//
// Phase orchestration is serial. Within EXECUTE, ready items dispatch
// CONCURRENTLY at EXECUTE_FANOUT (DEC-002) so KeeperHub's nonce manager is what
// serializes them.

import { randomBytes } from 'node:crypto';

import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import { KhClient } from '@convoy/kh-client';

import { EXECUTE_FANOUT } from './config.js';
import { applyGas, remaining, type BudgetState, type GasFee } from './budget.js';
import {
  executeItem,
  phaseCritique,
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
  /**
   * What the org Turnkey wallet actually paid, in USDC at the frozen rate — the
   * sum over items where the execution record said `sponsored:false` (DEC-010).
   * `budget.spentGasUsdc` is the different, larger figure: gas CONSUMED.
   */
  readonly walletDebitedUsdc: Prisma.Decimal;
  /** Items whose execution record carried no `sponsored` flag at all. */
  readonly unknownPayerCount: number;
}

/**
 * Wrap an already-composed total into the meter's fee shape.
 *
 * `composeGasFeeWei` multiplies units by a price; here the multiplication has
 * already happened against the receipt, so the L2/L1 split is not re-derived —
 * only the total is load-bearing for the formula.
 */
function weiToFee(weiTotal: bigint, l1FeeIncluded: boolean): GasFee {
  const total = new Prisma.Decimal(weiTotal.toString());
  return { weiTotal: total, weiL2: total, weiL1: new Prisma.Decimal(0), l1FeeIncluded };
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

  let runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  let budget: BudgetState = {
    budgetUsdc: new Prisma.Decimal(runRow.budgetUsdc),
    spentGasUsdc: new Prisma.Decimal(runRow.spentGasUsdc),
    spentPayUsdc: new Prisma.Decimal(runRow.spentPayUsdc),
  };
  const runEthUsd = new Prisma.Decimal(runRow.runEthUsd);

  const openTx = await phaseOpen(
    deps,
    runId,
    runRow.runIdOnchain === null
      ? runIdOnchain
      : `0x${Buffer.from(runRow.runIdOnchain).toString('hex')}`,
  );
  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const effectiveRunIdOnchain =
    runRow.runIdOnchain === null
      ? runIdOnchain
      : `0x${Buffer.from(runRow.runIdOnchain).toString('hex')}`;
  if (runRow.status === 'PLANNING') await phasePlan(runId);

  // CRITIQUING — every non-deferred item, zero gas. Simulate, then the Critic,
  // with at most one re-plan cycle (CVY-011).
  const critique =
    runRow.status === 'CRITIQUING'
      ? await phaseCritique(deps, runId, budget)
      : {
          ready: [] as number[],
          vetoed: [],
          failedIdx: [],
          replanCycles: 0,
          notes: [] as string[],
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
  for (const note of critique.notes) log(`  critique: ${note}`);

  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (runRow.status === 'CRITIQUING') {
    await setRunStatus(runId, 'EXECUTING', 'PLAN_READY', {
      ready,
      vetoed: vetoed.map((v) => v.idx),
      failed: critique.failedIdx,
      replanCycles: critique.replanCycles,
      notes: critique.notes,
      criticConsulted:
        critique.vetoed.some((v) => v.criticConsulted === true) || deps.critic !== undefined,
    });
  }

  const executed: ExecuteOutcome[] = [];
  let debited = new Prisma.Decimal(0);
  let unknownPayer = 0;
  let wave = ready;
  while (wave.length > 0) {
    log(`  EXECUTE wave of ${wave.length} at fanout=${fanout}`);
    const outcomes = await dispatchConcurrently(wave, fanout, async (idx) =>
      executeItem(deps, runId, idx, effectiveRunIdOnchain, runEthUsd),
    );
    executed.push(...outcomes);

    // Drain the meter from the REAL fee in wei, composed from the chain receipt
    // (L2 + L1) rather than from KeeperHub's sponsorship-dependent `gasUsedWei`
    // (gaps G-28, G-31). Consumption drains the budget; what the wallet actually
    // paid is accumulated separately and never folded in (DEC-010).
    for (const o of outcomes) {
      if (!o.landed || o.feeWeiTotal === undefined) continue;
      const fee = weiToFee(o.feeWeiTotal, o.l1FeeIncluded);
      const u = applyGas(budget, fee, runEthUsd, o.sponsored);
      budget = u.next;
      if (u.debitedUsdc !== null) debited = debited.add(u.debitedUsdc);
      if (u.sponsored === null) unknownPayer += 1;
      if (u.crossedLow) {
        await prisma.event.create({
          data: {
            runId,
            itemIdx: o.idx,
            type: 'BUDGET_LOW',
            payload: {
              remainingUsdc: remaining(budget).toFixed(6),
              consumedUsdc: budget.spentGasUsdc.toFixed(6),
              walletDebitedUsdc: debited.toFixed(6),
            },
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

  runRow = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (runRow.status === 'SEALED_OK' || runRow.status === 'SEALED_PARTIAL') {
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
      walletDebitedUsdc: debited,
      unknownPayerCount: unknownPayer,
    };
  }
  const sealed = await phaseSeal(deps, runId, effectiveRunIdOnchain, budget);

  return {
    runId,
    runIdOnchain: effectiveRunIdOnchain,
    openTx,
    sealTx: sealed.txHash,
    status: sealed.status,
    executed,
    vetoed,
    budget,
    walletDebitedUsdc: debited,
    unknownPayerCount: unknownPayer,
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
