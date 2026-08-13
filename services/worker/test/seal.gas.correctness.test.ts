import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@convoy/db';
import { KhClient, type StatusResult } from '@convoy/kh-client';

type EventRow = { id: number; type: string; payload: unknown };

const ledger = vi.hoisted(() => ({
  run: {
    id: 'run-seal',
    status: 'EXECUTING',
    runIdOnchain: null as Buffer | null,
    runEthUsd: new (class {
      toString() {
        return '3400';
      }
    })(),
    spentGasUsdc: '0',
    spentPayUsdc: '0',
  },
  items: [{ idx: 0, state: 'LANDED' }],
  events: [] as EventRow[],
  nextEventId: 1,
  gasIncrements: [] as string[],
  payIncrements: [] as string[],
}));

function applyRunUpdate(data: Record<string, unknown>): void {
  if (typeof data['status'] === 'string') ledger.run.status = data['status'];
  const gas = data['spentGasUsdc'] as { increment?: { toString(): string } } | undefined;
  if (gas?.increment !== undefined) ledger.gasIncrements.push(gas.increment.toString());
  const pay = data['spentPayUsdc'] as { increment?: { toString(): string } } | undefined;
  if (pay?.increment !== undefined) ledger.payIncrements.push(pay.increment.toString());
}

vi.mock('@convoy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@convoy/db')>();
  const tx = {
    run: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(ledger.run, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyRunUpdate(data);
        return ledger.run;
      }),
    },
    event: {
      findFirst: vi.fn(
        async ({ where }: { where: { type: string } }) =>
          [...ledger.events].reverse().find((event) => event.type === where.type) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { type: string } }) =>
        [...ledger.events].reverse().filter((event) => event.type === where.type),
      ),
      create: vi.fn(async ({ data }: { data: Omit<EventRow, 'id'> }) => {
        const row = { id: ledger.nextEventId++, ...data };
        ledger.events.push(row);
        return row;
      }),
    },
  };
  return {
    ...actual,
    unsafeRawClient: {
      run: {
        findUniqueOrThrow: vi.fn(async () => ledger.run),
        updateMany: tx.run.updateMany,
        update: tx.run.update,
      },
      item: {
        findMany: vi.fn(async () => ledger.items),
        findUnique: vi.fn(async () => null),
      },
      event: tx.event,
      $transaction: vi.fn(async (work: unknown) =>
        Array.isArray(work)
          ? Promise.all(work)
          : await (work as (client: typeof tx) => Promise<unknown>)(tx),
      ),
    },
  };
});

const receipt = vi.hoisted(() => ({
  value: undefined as undefined | { totalWei: bigint; l1FeePresent: boolean },
}));
vi.mock('../src/receipt.js', () => ({
  readReceiptGas: vi.fn(async () => receipt.value),
  readGasPriceWei: vi.fn(async () => undefined),
}));

import { __test, phaseOpen, phaseSeal } from '../src/orchestrator.js';

const REGISTRY = '0x0000000000000000000000000000000000000001';
const RUN_ONCHAIN = `0x${'11'.repeat(32)}`;

function khFor(
  status: 'completed' | 'failed',
  transactionHash?: string,
  onRequest: () => void = () => {},
): KhClient {
  return new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    retry: { maxAttempts: 1 },
    fetchImpl: async () => {
      onRequest();
      return new Response(
        JSON.stringify({
          executionId: 'direct_seal',
          status,
          ...(transactionHash === undefined ? {} : { transactionHash }),
          retryCount: 1,
        }),
        { status: 202 },
      );
    },
  });
}

beforeEach(() => {
  ledger.run.status = 'EXECUTING';
  ledger.run.runIdOnchain = null;
  ledger.items = [{ idx: 0, state: 'LANDED' }];
  ledger.events = [];
  ledger.nextEventId = 1;
  ledger.gasIncrements = [];
  ledger.payIncrements = [];
  receipt.value = { totalWei: 1_000_000_000_000n, l1FeePresent: true };
});

describe('seal correctness', () => {
  it('emits RUN_SEALED only after completed status and a real hash', async () => {
    let requests = 0;
    const kh = khFor('completed', `0x${'22'.repeat(32)}`, () => {
      requests += 1;
    });
    const result = await phaseSeal({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN, {
      budgetUsdc: new Prisma.Decimal(10),
      spentGasUsdc: new Prisma.Decimal(0),
      spentPayUsdc: new Prisma.Decimal(0),
    });
    expect(result.status).toBe('SEALED_OK');
    expect(ledger.run.status).toBe('SEALED_OK');
    expect(ledger.events.map((event) => event.type)).toEqual(['RUN_SEALED']);

    const resumed = await phaseSeal({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN, {
      budgetUsdc: new Prisma.Decimal(10),
      spentGasUsdc: new Prisma.Decimal(0),
      spentPayUsdc: new Prisma.Decimal(0),
    });
    expect(resumed).toEqual(result);
    expect(requests).toBe(1);
  });

  it.each([
    ['completed without a hash', 'completed' as const, undefined],
    ['failed status', 'failed' as const, `0x${'33'.repeat(32)}`],
  ])('never emits RUN_SEALED for %s', async (_name, status, hash) => {
    await expect(
      phaseSeal({ kh: khFor(status, hash), registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN, {
        budgetUsdc: new Prisma.Decimal(10),
        spentGasUsdc: new Prisma.Decimal(0),
        spentPayUsdc: new Prisma.Decimal(0),
      }),
    ).rejects.toThrow('sealRun did not land');
    expect(ledger.run.status).toBe('FAILED_FATAL');
    expect(ledger.events.some((event) => event.type === 'RUN_SEALED')).toBe(false);
    expect(ledger.events.some((event) => event.type === 'RUN_SEALED_PARTIAL')).toBe(false);
    expect(ledger.events.at(-1)).toMatchObject({
      type: 'ITEM_FAILED',
      payload: {
        phase: 'seal',
        executionId: 'direct_seal',
        txHash: hash ?? null,
        retryCount: 1,
        sponsored: null,
      },
    });
    expect(ledger.gasIncrements).toHaveLength(hash === undefined ? 0 : 1);
    expect(ledger.payIncrements).toHaveLength(0);
  });

  it('does not resubmit a terminal failed seal after restart', async () => {
    let requests = 0;
    const kh = khFor('failed', `0x${'34'.repeat(32)}`, () => {
      requests += 1;
    });
    const budget = {
      budgetUsdc: new Prisma.Decimal(10),
      spentGasUsdc: new Prisma.Decimal(0),
      spentPayUsdc: new Prisma.Decimal(0),
    };
    await expect(
      phaseSeal({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN, budget),
    ).rejects.toThrow('sealRun did not land');
    await expect(
      phaseSeal({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN, budget),
    ).rejects.toThrow('will not be resubmitted');
    expect(requests).toBe(1);
  });

  it.each(['FAILED', 'SKIPPED'])('%s items produce SEALED_PARTIAL', async (state) => {
    ledger.items = [{ idx: 0, state }];
    const result = await phaseSeal(
      { kh: khFor('completed', `0x${'44'.repeat(32)}`), registryAddr: REGISTRY },
      ledger.run.id,
      RUN_ONCHAIN,
      {
        budgetUsdc: new Prisma.Decimal(10),
        spentGasUsdc: new Prisma.Decimal(0),
        spentPayUsdc: new Prisma.Decimal(0),
      },
    );
    expect(result.status).toBe('SEALED_PARTIAL');
    expect(ledger.events.at(-1)?.type).toBe('RUN_SEALED_PARTIAL');
  });

  it('veto-only exclusions still permit SEALED_OK', async () => {
    ledger.items = [{ idx: 0, state: 'VETOED' }];
    const result = await phaseSeal(
      { kh: khFor('completed', `0x${'55'.repeat(32)}`), registryAddr: REGISTRY },
      ledger.run.id,
      RUN_ONCHAIN,
      {
        budgetUsdc: new Prisma.Decimal(10),
        spentGasUsdc: new Prisma.Decimal(0),
        spentPayUsdc: new Prisma.Decimal(0),
      },
    );
    expect(result.status).toBe('SEALED_OK');
  });
});

describe('open failure accounting', () => {
  it('accounts a failed hash-backed open without emitting RUN_OPENED', async () => {
    let requests = 0;
    ledger.run.status = 'RECEIVED';
    const kh = khFor('failed', `0x${'77'.repeat(32)}`, () => {
      requests += 1;
    });
    await expect(
      phaseOpen({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN),
    ).rejects.toThrow('openRun did not land');

    await expect(
      phaseOpen({ kh, registryAddr: REGISTRY }, ledger.run.id, RUN_ONCHAIN),
    ).rejects.toThrow('will not be resubmitted');

    expect(ledger.run.status).toBe('FAILED_FATAL');
    expect(ledger.events.some((event) => event.type === 'RUN_OPENED')).toBe(false);
    expect(ledger.events.at(-1)).toMatchObject({
      type: 'ITEM_FAILED',
      payload: {
        phase: 'open',
        executionId: 'direct_seal',
        txHash: `0x${'77'.repeat(32)}`,
        retryCount: 1,
        sponsored: null,
      },
    });
    expect(ledger.gasIncrements).toHaveLength(1);
    expect(ledger.payIncrements).toHaveLength(0);
    expect(requests).toBe(1);
  });
});

describe('registry-write gas accounting', () => {
  const final = (executionId: string): StatusResult => ({
    executionId,
    status: 'completed',
    transactionHash: `0x${'66'.repeat(32)}`,
    terminal: true,
    sponsored: false,
    raw: {},
  });

  it('accounts receipt-backed open/seal gas once and keeps wallet debit separate', async () => {
    receipt.value = { totalWei: 1_000_000_000_000n, l1FeePresent: true };
    await __test.recordRunWrite(
      'run-seal',
      'RUN_OPENED',
      'open',
      'open-id',
      final('open-id'),
      '3400',
      {},
      'PLANNING',
    );
    await __test.recordRunWrite(
      'run-seal',
      'RUN_OPENED',
      'open',
      'open-id',
      final('open-id'),
      '3400',
      {},
      'PLANNING',
    );
    await __test.recordRunWrite(
      'run-seal',
      'RUN_SEALED',
      'seal',
      'seal-id',
      final('seal-id'),
      '3400',
      {},
      'SEALED_OK',
    );
    expect(ledger.gasIncrements).toHaveLength(2);
    expect(ledger.payIncrements).toHaveLength(0);
    expect(ledger.events).toHaveLength(2);
  });

  it('records one lifecycle event even when gas is unavailable', async () => {
    receipt.value = undefined;
    await __test.recordRunWrite(
      'run-seal',
      'RUN_OPENED',
      'open',
      'open-no-gas',
      final('open-no-gas'),
      '3400',
      {},
      'PLANNING',
    );
    await __test.recordRunWrite(
      'run-seal',
      'RUN_OPENED',
      'open',
      'open-no-gas',
      final('open-no-gas'),
      '3400',
      {},
      'PLANNING',
    );
    expect(ledger.events).toHaveLength(1);
    expect(ledger.gasIncrements).toHaveLength(0);
  });

  it('does not fabricate gas when receipt and KeeperHub figures are missing', async () => {
    receipt.value = undefined;
    const gas = await __test.observationGas(final('missing'), '3400');
    expect(gas.fee.weiTotal).toBeUndefined();
    expect(gas.consumedUsdc).toBeNull();
  });
});
