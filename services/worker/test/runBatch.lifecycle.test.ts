import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({
  run: {
    id: 'run-fresh',
    status: 'PLANNING',
    runIdOnchain: null as Buffer | null,
    budgetUsdc: '10',
    spentGasUsdc: '0',
    spentPayUsdc: '0',
    runEthUsd: '3400',
  },
  attempts: [] as {
    executionId: string | null;
    gasUsedUsdc: string | null;
    sponsored: boolean | null;
  }[],
  events: [] as { id: bigint; payload: unknown }[],
}));

vi.mock('@convoy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@convoy/db')>();
  const snapshot = () => ({ ...ledger.run });
  return {
    ...actual,
    unsafeRawClient: {
      run: {
        findUniqueOrThrow: vi.fn(async () => snapshot()),
        findUnique: vi.fn(async () => snapshot()),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(ledger.run, data);
          return snapshot();
        }),
      },
      item: {
        findMany: vi.fn(async () => []),
      },
      attempt: {
        findMany: vi.fn(async () => ledger.attempts),
      },
      event: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => ledger.events),
      },
      $transaction: vi.fn(async (work: unknown) =>
        Array.isArray(work)
          ? Promise.all(work)
          : await (work as (client: unknown) => Promise<unknown>)({}),
      ),
    },
  };
});

const phases = vi.hoisted(() => ({
  open: vi.fn(async () => '0xopen'),
  plan: vi.fn(async () => {
    ledger.run.status = 'CRITIQUING';
  }),
  critique: vi.fn(async () => ({
    ready: [],
    vetoed: [],
    failedIdx: [],
    replanCycles: 0,
    notes: [],
    criticConsulted: false,
  })),
  seal: vi.fn(async () => ({ status: 'SEALED_OK' as const, txHash: '0xseal' })),
  release: vi.fn(async () => []),
  setStatus: vi.fn(async (_runId: string, status: string) => {
    ledger.run.status = status;
  }),
}));

vi.mock('../src/orchestrator.js', () => ({
  phaseOpen: phases.open,
  phasePlan: phases.plan,
  phaseCritique: phases.critique,
  phaseSeal: phases.seal,
  releaseDeferred: phases.release,
  setRunStatus: phases.setStatus,
  plannerPriority: (plan: unknown, indices: readonly number[]) => {
    const order =
      plan !== null && typeof plan === 'object' && !Array.isArray(plan)
        ? (plan as { order?: unknown }).order
        : undefined;
    return Array.isArray(order) ? (order as number[]) : [...indices].sort((a, b) => a - b);
  },
}));

import { runBatch } from '../src/runBatch.js';

describe('runBatch lifecycle', () => {
  beforeEach(() => {
    ledger.run.status = 'PLANNING';
    ledger.run.spentGasUsdc = '0';
    ledger.run.spentPayUsdc = '0';
    ledger.attempts = [];
    ledger.events = [];
    phases.open.mockClear();
    phases.plan.mockClear();
    phases.critique.mockClear();
    phases.seal.mockClear();
    phases.release.mockClear();
    phases.setStatus.mockClear();
    phases.open.mockImplementation(async () => '0xopen');
    phases.seal.mockImplementation(async () => ({ status: 'SEALED_OK', txHash: '0xseal' }));
  });

  it('refreshes after planning and does not skip the Critic on a fresh queue run', async () => {
    const planner = vi.fn(async () => ({}));
    const result = await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
      planner,
    });

    expect(phases.open).toHaveBeenCalledOnce();
    expect(phases.plan).toHaveBeenCalledOnce();
    expect(phases.critique).toHaveBeenCalledOnce();
    expect(phases.plan).toHaveBeenCalledWith('run-fresh', {
      ablatePlanner: false,
      registryAddr: '0xregistry',
      planner,
    });
    expect(phases.critique.mock.calls[0]?.[0]).not.toHaveProperty('critic');
    expect(phases.setStatus.mock.calls[0]?.[3]).toMatchObject({ criticConsulted: false });
    expect(phases.seal).toHaveBeenCalledOnce();
    expect(result.status).toBe('SEALED_OK');
  });

  it('passes the explicit planner ablation only to planning', async () => {
    await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
      ablation: 'planner',
    });

    expect(phases.plan).toHaveBeenCalledWith('run-fresh', {
      ablatePlanner: true,
      registryAddr: '0xregistry',
    });
    expect(phases.critique).toHaveBeenCalledWith(
      expect.anything(),
      'run-fresh',
      expect.anything(),
      {},
    );
  });

  it('preserves planning and explicitly bypasses only the critic gate', async () => {
    await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
      ablation: 'critic',
    });

    expect(phases.plan).toHaveBeenCalledWith('run-fresh', {
      ablatePlanner: false,
      registryAddr: '0xregistry',
    });
    expect(phases.critique).toHaveBeenCalledWith(
      expect.anything(),
      'run-fresh',
      expect.anything(),
      {
        bypassGate: true,
      },
    );
  });

  it('records actual Critic consultation rather than port availability', async () => {
    phases.critique.mockResolvedValueOnce({
      ready: [],
      vetoed: [],
      failedIdx: [],
      replanCycles: 0,
      notes: [],
      criticConsulted: true,
    });
    await runBatch(
      { kh: {} as never, registryAddr: '0xregistry', critic: vi.fn() as never },
      'run-fresh',
      { fanout: 1 },
    );

    expect(phases.setStatus.mock.calls[0]?.[3]).toMatchObject({ criticConsulted: true });
  });

  it('reloads persisted gas after open and seal', async () => {
    phases.open.mockImplementationOnce(async () => {
      ledger.run.spentGasUsdc = '1.250000';
      return '0xopen';
    });
    phases.seal.mockImplementationOnce(async () => {
      ledger.run.spentGasUsdc = '2.750000';
      return { status: 'SEALED_OK', txHash: '0xseal' };
    });

    const result = await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
    });

    expect(phases.critique.mock.calls[0]?.[2]).toMatchObject({
      spentGasUsdc: expect.objectContaining({}),
    });
    expect(phases.critique.mock.calls[0]?.[2].spentGasUsdc.toFixed(6)).toBe('1.250000');
    expect(result.budget.spentGasUsdc.toFixed(6)).toBe('2.750000');
  });

  it('derives wallet debit and unknown payer count from persisted writes', async () => {
    ledger.attempts = [
      { executionId: 'commit-paid', gasUsedUsdc: '0.100000', sponsored: false },
      { executionId: 'target-sponsored', gasUsedUsdc: '0.200000', sponsored: true },
      { executionId: 'target-unknown', gasUsedUsdc: '0.300000', sponsored: null },
    ];
    ledger.events = [
      {
        id: 1n,
        payload: {
          phase: 'open',
          executionId: 'open-paid',
          gasUsdcConsumed: '0.400000',
          sponsored: false,
        },
      },
      {
        id: 2n,
        payload: {
          phase: 'seal',
          executionId: 'seal-unknown',
          gasUsdcConsumed: null,
          sponsored: null,
        },
      },
    ];

    const result = await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
    });

    expect(result.walletDebitedUsdc.toFixed(6)).toBe('0.500000');
    expect(result.unknownPayerCount).toBe(2);
    expect(result.budget.spentPayUsdc.toFixed(6)).toBe('0.000000');
  });
});
