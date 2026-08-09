import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KhClient } from '@convoy/kh-client';

interface AttemptRow {
  id: string;
  itemId: string;
  attemptNo: number;
  kind: string;
  executionId: string | null;
  txHash: Buffer | null;
  txLink: string | null;
  khStatus: string | null;
  errorCode: string | null;
  revertReason: string | null;
  gasUsedWei: null;
  gasUsedUsdc: null;
  sponsored: null;
  createdAt: Date;
}

interface EventRow {
  type: string;
  [key: string]: unknown;
}

interface AttemptCreateData {
  attemptNo: number;
  kind: string;
  khStatus?: string;
}

const ledger = vi.hoisted(() => ({
  item: {
    id: 'item-kill',
    runId: 'run-kill',
    idx: 0,
    targetAddr: Buffer.from('d45c61797d7283caf8a31d91a5bd6465a45ad561', 'hex'),
    functionName: 'enableMarket',
    functionArgs: ['77'],
    payloadHash: Buffer.alloc(32, 7),
    evidence: 'real action',
    state: 'SIMULATED',
    dependsOn: [],
    gasBudgetUsdc: null,
    vetoReason: null,
  },
  attempts: [] as AttemptRow[],
  events: [] as EventRow[],
  crashOnPoll: true,
  commitBroadcasts: 0,
  targetBroadcasts: 0,
  statusPolls: 0,
}));

vi.mock('@convoy/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@convoy/db')>();
  const findAttempt = async ({ where }: { where: { itemId: string; kind: string } }) => {
    const rows = ledger.attempts.filter((a) => a.itemId === where.itemId && a.kind === where.kind);
    if (rows.length === 0) return null;
    return [...rows].sort((a, b) => b.attemptNo - a.attemptNo)[0];
  };
  const tx = {
    item: {
      findUnique: vi.fn(async () => ledger.item),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(ledger.item, data),
      ),
    },
    event: {
      create: vi.fn(async ({ data }: { data: EventRow }) => {
        ledger.events.push(data);
        return data;
      }),
    },
    attempt: {
      findFirst: vi.fn(findAttempt),
      create: vi.fn(async ({ data }: { data: AttemptCreateData }) => {
        const row: AttemptRow = {
          id: `attempt-${ledger.attempts.length + 1}`,
          itemId: ledger.item.id,
          attemptNo: data.attemptNo,
          kind: data.kind,
          executionId: null,
          txHash: null,
          txLink: null,
          khStatus: data.khStatus ?? null,
          errorCode: null,
          revertReason: null,
          gasUsedWei: null,
          gasUsedUsdc: null,
          sponsored: null,
          createdAt: new Date(),
        };
        ledger.attempts.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = ledger.attempts.find((a) => a.id === where.id);
          if (row === undefined) throw new Error('attempt missing');
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
  return {
    ...actual,
    unsafeRawClient: {
      item: {
        findUniqueOrThrow: vi.fn(async () => ledger.item),
        findUnique: vi.fn(async () => ledger.item),
      },
      attempt: tx.attempt,
      $transaction: vi.fn(async (work: unknown) =>
        Array.isArray(work)
          ? Promise.all(work)
          : await (work as (client: typeof tx) => Promise<unknown>)(tx),
      ),
    },
  };
});

vi.mock('../src/receipt.js', () => ({ readReceiptGas: vi.fn(async () => undefined) }));

import { executeItem } from '../src/orchestrator.js';

const REGISTRY = '0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA';
const RUN_ONCHAIN = '0x' + '11'.repeat(32);

function transport(): KhClient {
  return new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    retry: { maxAttempts: 1 },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const body =
        init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (path.endsWith('/contract-call') && body['functionName'] === 'commitAction') {
        ledger.commitBroadcasts += 1;
        return new Response(
          JSON.stringify({
            executionId: 'direct_commit',
            status: 'completed',
            transactionHash: '0xcommit',
          }),
          { status: 202 },
        );
      }
      if (path.endsWith('/contract-call')) {
        ledger.targetBroadcasts += 1;
        return new Response(JSON.stringify({ executionId: 'direct_target', status: 'pending' }), {
          status: 202,
        });
      }
      if (path.endsWith('/status')) {
        ledger.statusPolls += 1;
        if (ledger.crashOnPoll) throw new Error('worker killed during EXECUTE');
        return new Response(
          JSON.stringify({
            executionId: 'direct_target',
            status: 'completed',
            transactionHash: '0xlanded',
          }),
          {
            status: 200,
            headers: { 'X-Poll-Interval-Hint': '0' },
          },
        );
      }
      throw new Error(`unexpected path ${path}`);
    },
  });
}

beforeEach(() => {
  ledger.item.state = 'SIMULATED';
  ledger.attempts.splice(0);
  ledger.events.splice(0);
  ledger.crashOnPoll = true;
  ledger.commitBroadcasts = 0;
  ledger.targetBroadcasts = 0;
  ledger.statusPolls = 0;
});

describe('CVY-015 kill-worker/no-duplicate transaction proof', () => {
  it('restart polls the same execution id and records one broadcast/hash/terminal event', async () => {
    const kh = transport();
    await expect(
      executeItem({ kh, registryAddr: REGISTRY }, 'run-kill', 0, RUN_ONCHAIN, '3400'),
    ).rejects.toThrow('worker killed');
    expect(ledger.targetBroadcasts).toBe(1);
    expect(ledger.commitBroadcasts).toBe(1);
    expect(ledger.attempts.find((a) => a.kind === 'EXECUTE')?.executionId).toBe('direct_target');

    ledger.crashOnPoll = false;
    const result = await executeItem(
      { kh, registryAddr: REGISTRY },
      'run-kill',
      0,
      RUN_ONCHAIN,
      '3400',
    );
    expect(result.landed).toBe(true);
    expect(result.txHash).toBe('0xlanded');
    expect(ledger.targetBroadcasts).toBe(1);
    expect(ledger.commitBroadcasts).toBe(1);
    expect(ledger.statusPolls).toBe(2);
    expect(ledger.events.filter((e) => e.type === 'ITEM_LANDED')).toHaveLength(1);
  });

  it('does not resubmit an already landed item', async () => {
    ledger.item.state = 'LANDED';
    const kh = transport();
    const result = await executeItem(
      { kh, registryAddr: REGISTRY },
      'run-kill',
      0,
      RUN_ONCHAIN,
      '3400',
    );
    expect(result.landed).toBe(true);
    expect(ledger.targetBroadcasts).toBe(0);
    expect(ledger.commitBroadcasts).toBe(0);
    expect(ledger.statusPolls).toBe(0);
  });
});
