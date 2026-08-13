import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({
  run: { budgetUsdc: '11', plan: null as unknown, deadline: null },
  items: [
    {
      idx: 0,
      state: 'PENDING',
      dependsOn: [1],
      gasBudgetUsdc: null,
      targetAddr: Buffer.alloc(20, 1),
      functionName: 'enableMarket',
      functionArgs: ['1'],
      evidence: 'after item one',
    },
    {
      idx: 1,
      state: 'PENDING',
      dependsOn: [],
      gasBudgetUsdc: null,
      targetAddr: Buffer.alloc(20, 1),
      functionName: 'fund',
      functionArgs: ['1'],
      evidence: 'fund first',
    },
  ],
}));

vi.mock('@convoy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@convoy/db')>();
  return {
    ...actual,
    unsafeRawClient: {
      run: {
        findUniqueOrThrow: vi.fn(async () => ledger.run),
        update: vi.fn(async ({ data }: { data: { plan?: unknown } }) => {
          if (data.plan !== undefined) ledger.run.plan = data.plan;
          return ledger.run;
        }),
      },
      item: {
        findMany: vi.fn(async ({ where }: { where?: { state?: string } }) =>
          where?.state === 'PLANNED'
            ? ledger.items
                .filter((item) => item.state === 'PLANNED')
                .map((item) => ({ idx: item.idx }))
            : ledger.items,
        ),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { runId_idx: { idx: number } } }) =>
          ledger.items.find((item) => item.idx === where.runId_idx.idx),
        ),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { runId_idx: { idx: number } };
            data: { dependsOn?: number[]; state?: string };
          }) => {
            const item = ledger.items.find((candidate) => candidate.idx === where.runId_idx.idx);
            if (item !== undefined) {
              if (data.dependsOn !== undefined) item.dependsOn = data.dependsOn;
              if (data.state !== undefined) item.state = data.state;
            }
            return item;
          },
        ),
      },
      event: { create: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (work: unknown) => {
        if (Array.isArray(work)) return await Promise.all(work);
        const callback = work as (tx: unknown) => Promise<unknown>;
        return await callback({
          item: {
            updateMany: async ({
              where,
              data,
            }: {
              where: { idx: number; state: { in: string[] } };
              data: { dependsOn?: number[]; state?: string };
            }) => {
              const item = ledger.items.find((candidate) => candidate.idx === where.idx);
              if (item === undefined || !where.state.in.includes(item.state)) return { count: 0 };
              if (data.dependsOn !== undefined) item.dependsOn = data.dependsOn;
              if (data.state !== undefined) item.state = data.state;
              return { count: 1 };
            },
          },
          event: { create: async () => ({}) },
        });
      }),
    },
  };
});

import { phaseCritique, phasePlan } from '../src/orchestrator.js';

describe('CVY-016 production ablation options', () => {
  beforeEach(() => {
    ledger.run.plan = null;
    ledger.items[0]!.state = 'PENDING';
    ledger.items[0]!.dependsOn = [1];
    ledger.items[1]!.state = 'PENDING';
  });

  it('planner ablation removes Planner extraction while preserving declared gates and input order', async () => {
    const planner = vi.fn(async () => ({ source: 'planner' }));
    await phasePlan('run-ablation', { ablatePlanner: true, planner });
    expect(ledger.items.map((item) => item.dependsOn)).toEqual([[1], []]);
    expect(planner).not.toHaveBeenCalled();
    expect(ledger.run.plan).toMatchObject({
      source: 'ablation-planner',
      order: [0, 1],
      deferrals: [{ idx: 0, dependsOn: 1 }],
    });
  });

  it('normal planning records a Planner-sourced plan when the port is available', async () => {
    process.env['MOCK_DISTRIBUTOR_ADDR'] = '0x0000000000000000000000000000000000000001';
    const planner = vi.fn(async () => ({
      source: 'planner',
      order: [1, 0],
      deferrals: [{ idx: 0, dependsOn: 1 }],
      gasBudgetPerItem: [
        { idx: 0, gasBudgetUsdc: '5.500000' },
        { idx: 1, gasBudgetUsdc: '5.500000' },
      ],
      rationalePerItem: [],
      excludedIdx: [],
      warnings: [],
      attempts: 1,
    }));
    await phasePlan('run-ablation', { planner });
    expect(planner).toHaveBeenCalledOnce();
    expect(ledger.run.plan).toMatchObject({ source: 'planner' });
  });

  it('critic ablation marks only PLANNED items simulated without KeeperHub', async () => {
    ledger.items[0]!.state = 'PLANNED';
    ledger.items[1]!.state = 'DEFERRED';
    const result = await phaseCritique(
      { kh: {} as never, registryAddr: '0xregistry' },
      'run-ablation',
      {
        budgetUsdc: new (await import('@convoy/db')).Prisma.Decimal(11),
        spentGasUsdc: new (await import('@convoy/db')).Prisma.Decimal(0),
        spentPayUsdc: new (await import('@convoy/db')).Prisma.Decimal(0),
      },
      { bypassGate: true },
    );
    expect(result.ready).toEqual([0]);
    expect(ledger.items[0]!.state).toBe('SIMULATED');
    expect(ledger.items[1]!.state).toBe('DEFERRED');
  });
});
