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
      event: {
        findFirst: vi.fn(async () => null),
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
}));

import { runBatch } from '../src/runBatch.js';

describe('runBatch lifecycle', () => {
  beforeEach(() => {
    ledger.run.status = 'PLANNING';
    phases.open.mockClear();
    phases.plan.mockClear();
    phases.critique.mockClear();
    phases.seal.mockClear();
    phases.release.mockClear();
    phases.setStatus.mockClear();
  });

  it('refreshes after planning and does not skip the Critic on a fresh queue run', async () => {
    const result = await runBatch({ kh: {} as never, registryAddr: '0xregistry' }, 'run-fresh', {
      fanout: 1,
    });

    expect(phases.open).toHaveBeenCalledOnce();
    expect(phases.plan).toHaveBeenCalledOnce();
    expect(phases.critique).toHaveBeenCalledOnce();
    expect(phases.seal).toHaveBeenCalledOnce();
    expect(result.status).toBe('SEALED_OK');
  });
});
