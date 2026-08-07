import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KhClient } from '@convoy/kh-client';

const ledger = vi.hoisted(() => ({
  item: {
    id: 'item-1',
    runId: 'run-12345678',
    idx: 1,
    targetAddr: Buffer.from('D45c61797d7283caf8A31D91A5Bd6465A45AD561', 'hex'),
    functionName: 'enableMarket',
    functionArgs: ['1'],
    payloadHash: Buffer.alloc(32, 1),
    evidence: 'item 1',
    state: 'SIMULATED',
    dependsOn: [0] as number[],
    gasBudgetUsdc: null,
    vetoReason: null,
  },
  attempts: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
}));

vi.mock('@convoy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@convoy/db')>();
  const tx = {
    item: {
      findUnique: vi.fn(async () => ledger.item),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(ledger.item, data);
        return ledger.item;
      }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        ledger.events.push(data);
        return data;
      }),
    },
  };
  return {
    ...actual,
    unsafeRawClient: {
      item: { findUniqueOrThrow: vi.fn(async () => ledger.item) },
      attempt: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ledger.attempts.push(data);
          return data;
        }),
      },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => await work(tx)),
    },
  };
});

vi.mock('../src/receipt.js', () => ({
  readGasPriceWei: vi.fn(async () => 1n),
  readReceiptGas: vi.fn(async () => undefined),
}));

import { deferredItemsReadyForRelease, executeItem } from '../src/orchestrator.js';
import { selectOnchainDependency } from '../src/gates/checkAndExecute.js';
import { DISTRIBUTOR_ABI } from '../src/abis.js';

const REGISTRY = '0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA';
const TARGET = '0xd45c61797d7283caf8a31d91a5bd6465a45ad561';
const RUN_ONCHAIN = '0xc013000000000000000000000000000000000000000000000000000000000001';

function khFor(scenario: 'met' | 'unmet' | 'commit-failed' | 'commit-no-hash' | 'retry'): {
  client: KhClient;
  calls: { path: string; body?: Record<string, unknown> }[];
  keys: string[];
} {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const keys: string[] = [];
  let gateCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ path, ...(body === undefined ? {} : { body }) });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'idempotency-key',
    )?.[1];
    if (key !== undefined) keys.push(key);

    if (path.endsWith('/contract-call')) {
      if (body?.['functionName'] !== 'commitAction') {
        throw new Error(`unexpected direct target write: ${String(body?.['functionName'])}`);
      }
      return new Response(
        JSON.stringify(
          scenario === 'commit-failed'
            ? { executionId: 'direct_commit', status: 'failed', transactionHash: '0xcommit' }
            : scenario === 'commit-no-hash'
              ? { executionId: 'direct_commit', status: 'completed' }
              : { executionId: 'direct_commit', status: 'completed', transactionHash: '0xcommit' },
        ),
        { status: 202 },
      );
    }
    if (path.endsWith('/check-and-execute')) {
      gateCalls += 1;
      if (scenario === 'retry' && gateCalls === 1) {
        return new Response(JSON.stringify({ error: 'N-0001 temporary' }), { status: 409 });
      }
      return new Response(
        JSON.stringify(
          scenario === 'unmet'
            ? {
                executed: false,
                conditionResult: {
                  met: false,
                  observedValue: 'false',
                  targetValue: 'true',
                  operator: 'eq',
                },
              }
            : {
                executed: true,
                executionId: 'direct_target',
                status: 'completed',
                transactionHash: '0xtarget',
                conditionResult: {
                  met: true,
                  observedValue: 'true',
                  targetValue: 'true',
                  operator: 'eq',
                },
              },
        ),
        { status: 200 },
      );
    }
    if (path.endsWith('/status')) {
      if (scenario === 'commit-no-hash') {
        return new Response(JSON.stringify({ executionId: 'direct_commit', status: 'completed' }), {
          status: 200,
          headers: { 'X-Poll-Interval-Hint': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          executionId: 'direct_target',
          status: 'completed',
          transactionHash: '0xtarget',
          sponsored: true,
          gasUsedWei: '21000',
          gasPriceWei: '1',
        }),
        { status: 200, headers: { 'X-Poll-Interval-Hint': '0' } },
      );
    }
    throw new Error(`unexpected KeeperHub path: ${path}`);
  };
  return {
    client: new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl,
      retry: { maxAttempts: 1 },
    }),
    calls,
    keys,
  };
}

beforeEach(() => {
  ledger.item.state = 'SIMULATED';
  ledger.item.dependsOn = [0];
  ledger.attempts.splice(0);
  ledger.events.splice(0);
});

describe('CVY-013 dependency gate', () => {
  it('requires every app-side dependency to be LANDED before release', () => {
    expect(
      deferredItemsReadyForRelease([
        { idx: 0, state: 'LANDED', dependsOn: [] },
        { idx: 1, state: 'DEFERRED', dependsOn: [0, 2] },
        { idx: 2, state: 'SIMULATED', dependsOn: [] },
      ]),
    ).toEqual([]);
    expect(
      deferredItemsReadyForRelease([
        { idx: 0, state: 'LANDED', dependsOn: [] },
        { idx: 1, state: 'DEFERRED', dependsOn: [0, 2] },
        { idx: 2, state: 'LANDED', dependsOn: [] },
      ]),
    ).toEqual([1]);
  });

  it('uses the lowest committed dependency deterministically', () => {
    expect(selectOnchainDependency([9, 2, 5])).toBe(2);
  });

  it('checks the registry and records an unmet condition without executing', async () => {
    const kh = khFor('unmet');
    const outcome = await executeItem(
      { kh: kh.client, registryAddr: REGISTRY },
      'run-12345678',
      1,
      RUN_ONCHAIN,
      '3400',
    );
    expect(outcome.landed).toBe(false);
    expect(kh.calls.filter(({ path }) => path.endsWith('/check-and-execute'))).toHaveLength(1);
    expect(kh.calls.filter(({ path }) => path.endsWith('/contract-call'))).toHaveLength(1);
    const gateBody = kh.calls.find(({ path }) => path.endsWith('/check-and-execute'))?.body;
    expect(gateBody).toMatchObject({
      contractAddress: REGISTRY,
      functionName: 'isCommitted',
      functionArgs: JSON.stringify([RUN_ONCHAIN, '0']),
      condition: { operator: 'eq', value: 'true' },
    });
    expect(ledger.item.state).toBe('FAILED');
    expect(ledger.events.at(-1)?.['payload']).toMatchObject({
      dependencyIdx: 0,
      condition: { met: false, observedValue: 'false', targetValue: 'true', operator: 'eq' },
    });
  });

  it('executes a met condition exactly once with multiple dependencies', async () => {
    ledger.item.dependsOn = [3, 2, 0];
    const kh = khFor('met');
    const outcome = await executeItem(
      { kh: kh.client, registryAddr: REGISTRY },
      'run-12345678',
      1,
      RUN_ONCHAIN,
      '3400',
    );
    expect(outcome.landed).toBe(true);
    expect(kh.calls.filter(({ path }) => path.endsWith('/check-and-execute'))).toHaveLength(1);
    expect(kh.calls.filter(({ path }) => path.endsWith('/contract-call'))).toHaveLength(1);
    expect(kh.calls.find(({ path }) => path.endsWith('/check-and-execute'))?.body).toMatchObject({
      functionArgs: JSON.stringify([RUN_ONCHAIN, '0']),
      action: {
        contractAddress: TARGET,
        functionName: 'enableMarket',
        functionArgs: '["1"]',
        abi: JSON.stringify(DISTRIBUTOR_ABI),
      },
    });
  });

  it('retries with the next idempotency attempt and then lands once', async () => {
    const kh = khFor('retry');
    const outcome = await executeItem(
      { kh: kh.client, registryAddr: REGISTRY },
      'run-12345678',
      1,
      RUN_ONCHAIN,
      '3400',
    );
    expect(outcome.landed).toBe(true);
    expect(kh.keys).toContain('run-1234-x:1:0');
    expect(kh.keys).toContain('run-1234-x:1:1');
    expect(ledger.events.filter((event) => event['type'] === 'ITEM_RETRY')).toHaveLength(1);
  });

  it('does not reach either target path after a failed commitAction', async () => {
    const kh = khFor('commit-failed');
    const outcome = await executeItem(
      { kh: kh.client, registryAddr: REGISTRY },
      'run-12345678',
      1,
      RUN_ONCHAIN,
      '3400',
    );
    expect(outcome.landed).toBe(false);
    expect(kh.calls.filter(({ path }) => path.endsWith('/contract-call'))).toHaveLength(1);
    expect(kh.calls.some(({ path }) => path.endsWith('/check-and-execute'))).toBe(false);
    expect(ledger.item.state).toBe('FAILED');
  });

  it('blocks both target paths when commitAction completes without a transaction hash', async () => {
    const kh = khFor('commit-no-hash');
    const outcome = await executeItem(
      { kh: kh.client, registryAddr: REGISTRY },
      'run-12345678',
      1,
      RUN_ONCHAIN,
      '3400',
    );
    expect(outcome.landed).toBe(false);
    expect(kh.calls.filter(({ path }) => path.endsWith('/contract-call'))).toHaveLength(1);
    expect(kh.calls.filter(({ path }) => path.endsWith('/status'))).toHaveLength(1);
    expect(kh.calls.some(({ path }) => path.endsWith('/check-and-execute'))).toBe(false);
    expect(ledger.item.state).toBe('FAILED');
    expect(ledger.events.at(-1)?.['payload']).toMatchObject({
      reason: 'commitAction did not land; target write blocked',
      status: 'completed',
      txHash: null,
    });
  });
});
