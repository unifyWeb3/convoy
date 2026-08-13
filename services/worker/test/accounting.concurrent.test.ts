import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import type { StatusResult } from '@convoy/kh-client';

const receipt = vi.hoisted(() => ({
  value: undefined as undefined | { totalWei: bigint; l1FeePresent: boolean },
}));

vi.mock('../src/receipt.js', () => ({
  readReceiptGas: vi.fn(async () => receipt.value),
  readGasPriceWei: vi.fn(async () => undefined),
}));

import { __test, transitionItem } from '../src/orchestrator.js';
import { persistObservation } from '../src/reconcile.js';

const createdRuns: string[] = [];
const TX_HASH = `0x${'88'.repeat(32)}`;

async function createRunWithAttempt(): Promise<{ runId: string; attemptId: string }> {
  const run = await prisma.run.create({
    data: {
      id: randomUUID(),
      status: 'EXECUTING',
      budgetUsdc: '100.000000',
      runEthUsd: '3400.000000',
      items: {
        create: {
          idx: 0,
          targetAddr: Buffer.alloc(20, 1),
          functionName: 'enableMarket',
          functionArgs: ['1'],
          payloadHash: Buffer.alloc(32, 2),
          evidence: 'concurrent accounting regression',
          state: 'SUBMITTED',
        },
      },
    },
    include: { items: true },
  });
  createdRuns.push(run.id);
  const attempt = await prisma.attempt.create({
    data: {
      itemId: run.items[0]!.id,
      attemptNo: 0,
      kind: 'EXECUTE',
      executionId: 'direct_concurrent_attempt',
      khStatus: 'running',
    },
  });
  return { runId: run.id, attemptId: attempt.id };
}

async function createRun(): Promise<string> {
  const run = await prisma.run.create({
    data: {
      id: randomUUID(),
      status: 'OPENING',
      budgetUsdc: '100.000000',
      runEthUsd: '3400.000000',
    },
  });
  createdRuns.push(run.id);
  return run.id;
}

function final(executionId: string, sponsored: boolean | null = false): StatusResult {
  return {
    executionId,
    status: 'completed',
    transactionHash: TX_HASH,
    terminal: true,
    sponsored,
    retryCount: 2,
    raw: {},
  };
}

afterEach(async () => {
  receipt.value = undefined;
  if (createdRuns.length > 0) {
    await prisma.run.deleteMany({ where: { id: { in: createdRuns.splice(0) } } });
  }
});

describe('concurrent exact-once accounting', () => {
  it('atomically claims one item-attempt gas increment under Promise.all', async () => {
    const { runId, attemptId } = await createRunWithAttempt();
    const status = final('direct_concurrent_attempt');
    const observation = { outcome: 'landed' as const, status, txHash: TX_HASH };
    const gasUsdc = new Prisma.Decimal('0.500000');

    const reconcile = async () => ({
      accounted: await persistObservation(attemptId, observation, {
        runId,
        gasUsedWei: new Prisma.Decimal('147058823529411'),
        gasUsedUsdc: gasUsdc,
        sponsored: false,
      }),
      moved: await transitionItem({
        runId,
        itemIdx: 0,
        expect: ['SUBMITTED'],
        to: 'LANDED',
        type: 'ITEM_LANDED',
        payload: { executionId: status.executionId, txHash: TX_HASH },
      }),
    });
    const results = await Promise.all([reconcile(), reconcile()]);

    expect(results.filter((result) => result.accounted)).toHaveLength(1);
    expect(results.filter((result) => result.moved)).toHaveLength(1);
    const [run, attempt, events] = await Promise.all([
      prisma.run.findUniqueOrThrow({ where: { id: runId } }),
      prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } }),
      prisma.event.findMany({ where: { runId, itemIdx: 0, type: 'ITEM_LANDED' } }),
    ]);
    expect(run.spentGasUsdc.toFixed(6)).toBe('0.500000');
    expect(run.spentPayUsdc.toFixed(6)).toBe('0.000000');
    expect(attempt.gasUsedUsdc?.toFixed(6)).toBe('0.500000');
    expect(events).toHaveLength(1);
  });

  it('records one item lifecycle event concurrently when gas is unavailable', async () => {
    const { runId, attemptId } = await createRunWithAttempt();
    const status = final('direct_concurrent_attempt');
    const observation = { outcome: 'landed' as const, status, txHash: TX_HASH };
    const reconcile = async () => {
      await persistObservation(attemptId, observation, { runId, sponsored: null });
      return await transitionItem({
        runId,
        itemIdx: 0,
        expect: ['SUBMITTED'],
        to: 'LANDED',
        type: 'ITEM_LANDED',
        payload: { executionId: status.executionId, txHash: TX_HASH, gasUsdcConsumed: null },
      });
    };

    const moved = await Promise.all([reconcile(), reconcile()]);
    expect(moved.filter(Boolean)).toHaveLength(1);
    const [run, events] = await Promise.all([
      prisma.run.findUniqueOrThrow({ where: { id: runId } }),
      prisma.event.findMany({ where: { runId, itemIdx: 0, type: 'ITEM_LANDED' } }),
    ]);
    expect(run.spentGasUsdc.toFixed(6)).toBe('0.000000');
    expect(events).toHaveLength(1);
  });

  it('records one run lifecycle event and gas increment under Promise.all', async () => {
    const runId = await createRun();
    receipt.value = { totalWei: 1_000_000_000_000_000n, l1FeePresent: true };
    const status = final('direct_concurrent_open');

    await Promise.all([
      __test.recordRunWrite(
        runId,
        'RUN_OPENED',
        'open',
        status.executionId,
        status,
        '3400',
        {},
        'PLANNING',
      ),
      __test.recordRunWrite(
        runId,
        'RUN_OPENED',
        'open',
        status.executionId,
        status,
        '3400',
        {},
        'PLANNING',
      ),
    ]);

    const [run, events] = await Promise.all([
      prisma.run.findUniqueOrThrow({ where: { id: runId } }),
      prisma.event.findMany({ where: { runId, type: 'RUN_OPENED' } }),
    ]);
    expect(run.spentGasUsdc.toFixed(6)).toBe('3.400000');
    expect(run.spentPayUsdc.toFixed(6)).toBe('0.000000');
    expect(events).toHaveLength(1);
  });

  it('records one run lifecycle event concurrently when gas is unavailable', async () => {
    const runId = await createRun();
    const status = final('direct_concurrent_no_gas', null);

    await Promise.all([
      __test.recordRunWrite(
        runId,
        'RUN_OPENED',
        'open',
        status.executionId,
        status,
        '3400',
        {},
        'PLANNING',
      ),
      __test.recordRunWrite(
        runId,
        'RUN_OPENED',
        'open',
        status.executionId,
        status,
        '3400',
        {},
        'PLANNING',
      ),
    ]);

    const [run, events] = await Promise.all([
      prisma.run.findUniqueOrThrow({ where: { id: runId } }),
      prisma.event.findMany({ where: { runId, type: 'RUN_OPENED' } }),
    ]);
    expect(run.spentGasUsdc.toFixed(6)).toBe('0.000000');
    expect(events).toHaveLength(1);
  });
});
