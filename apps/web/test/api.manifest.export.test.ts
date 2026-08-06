import { describe, expect, it, vi } from 'vitest';

import {
  buildManifest,
  verifyManifest,
  type KeeperHubExecutionSnapshot,
  type LedgerItemSnapshot,
  type LedgerRunSnapshot,
  type ManifestDocument,
} from '../lib/manifest';
import type { RegistrySnapshot } from '../lib/registry';

const RUN_ONCHAIN = `0x${'11'.repeat(32)}` as const;
const PAYLOAD = `0x${'22'.repeat(32)}` as const;
const ZERO_HASH = `0x${'00'.repeat(32)}` as const;
const COMMIT_TX = `0x${'33'.repeat(32)}` as const;
const EXECUTE_TX = `0x${'44'.repeat(32)}` as const;
const OPEN_TX = `0x${'55'.repeat(32)}` as const;
const SEAL_TX = `0x${'66'.repeat(32)}` as const;
const OPERATOR = `0x${'77'.repeat(20)}` as const;
const REGISTRY = `0x${'88'.repeat(20)}` as const;
const TARGET = `0x${'99'.repeat(20)}` as const;

function landedItem(): LedgerItemSnapshot {
  return {
    idx: 0,
    targetAddress: TARGET,
    functionName: 'fund',
    functionArgs: ['75000000'],
    payloadHash: PAYLOAD,
    evidence: 'Fund an additional 75.000000 USDC.',
    state: 'LANDED',
    dependsOn: [],
    gasBudgetUsdc: '1.000000',
    vetoReason: null,
    attempts: [
      {
        attemptNo: 0,
        kind: 'COMMIT',
        executionId: 'commit-0',
        transactionHash: COMMIT_TX,
        transactionLink: 'https://sepolia.basescan.org/tx/commit',
        gasUsedWei: null,
        gasUsedUsdc: null,
        sponsored: null,
        wouldRevert: null,
        revertReason: null,
        khStatus: 'completed',
        errorCode: null,
        createdAt: '2026-08-05T10:00:01.000Z',
      },
      {
        attemptNo: 0,
        kind: 'EXECUTE',
        executionId: 'execute-0',
        transactionHash: EXECUTE_TX,
        transactionLink: 'https://sepolia.basescan.org/tx/execute',
        gasUsedWei: '123456789',
        gasUsedUsdc: '0.000321',
        sponsored: true,
        wouldRevert: null,
        revertReason: null,
        khStatus: 'completed',
        errorCode: null,
        createdAt: '2026-08-05T10:00:02.000Z',
      },
    ],
    events: [
      {
        id: '3',
        itemIdx: 0,
        type: 'ITEM_COMMITTED',
        payload: { txHash: COMMIT_TX },
        at: '2026-08-05T10:00:01.000Z',
      },
      {
        id: '4',
        itemIdx: 0,
        type: 'ITEM_LANDED',
        payload: { txHash: EXECUTE_TX },
        at: '2026-08-05T10:00:02.000Z',
      },
    ],
  };
}

function vetoedItem(): LedgerItemSnapshot {
  return {
    idx: 1,
    targetAddress: TARGET,
    functionName: 'enableMarket',
    functionArgs: ['1'],
    payloadHash: `0x${'aa'.repeat(32)}`,
    evidence: 'Hold this market.',
    state: 'VETOED',
    dependsOn: [],
    gasBudgetUsdc: '1.000000',
    vetoReason: 'evidence_mismatch',
    attempts: [],
    events: [
      {
        id: '5',
        itemIdx: 1,
        type: 'ITEM_VETOED',
        payload: { reason: 'evidence_mismatch' },
        at: '2026-08-05T10:00:02.000Z',
      },
    ],
  };
}

function ledger(): LedgerRunSnapshot {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    runIdOnchain: RUN_ONCHAIN,
    status: 'SEALED_OK',
    budgetUsdc: '10.000000',
    spentGasUsdc: '0.000321',
    spentPayUsdc: '0.000000',
    runEthUsd: '3500.000000',
    deadline: null,
    plan: { order: [0, 1] },
    createdAt: '2026-08-05T10:00:00.000Z',
    sealedAt: '2026-08-05T10:00:03.000Z',
    snapshotAt: '2026-08-05T10:00:03.000Z',
    items: [landedItem(), vetoedItem()],
    events: [
      {
        id: '1',
        itemIdx: null,
        type: 'RUN_OPENED',
        payload: { txHash: OPEN_TX },
        at: '2026-08-05T10:00:00.000Z',
      },
      {
        id: '2',
        itemIdx: null,
        type: 'RUN_SEALED',
        payload: { txHash: SEAL_TX },
        at: '2026-08-05T10:00:03.000Z',
      },
    ],
  };
}

function remote(
  executionId: string,
  transactionHash: string,
  gasUsedWei: string | null = null,
): KeeperHubExecutionSnapshot {
  return {
    available: true,
    executionId,
    status: 'completed',
    transactionHash,
    transactionLink: `https://sepolia.basescan.org/tx/${executionId}`,
    gasUsedWei,
    gasUsedWeiMeaning: gasUsedWei === null ? null : 'gas_units',
    sponsored: gasUsedWei === null ? null : true,
    error: null,
  };
}

function keeperHub(
  commitHash: string = COMMIT_TX,
): ReadonlyMap<string, KeeperHubExecutionSnapshot> {
  return new Map([
    ['commit-0', remote('commit-0', commitHash)],
    ['execute-0', remote('execute-0', EXECUTE_TX, '91875')],
  ]);
}

function registry(commitHash: `0x${string}` = COMMIT_TX): RegistrySnapshot {
  return {
    available: true,
    chainId: 84532,
    contractAddress: REGISTRY,
    openEvents: [
      {
        transactionHash: OPEN_TX,
        blockNumber: '1',
        operator: OPERATOR,
        at: '2026-08-05T10:00:00.000Z',
      },
    ],
    commitEvents: [
      {
        transactionHash: commitHash,
        blockNumber: '2',
        idx: 0,
        payloadHash: PAYLOAD,
        sequence: 1,
        at: '2026-08-05T10:00:01.000Z',
      },
    ],
    sealEvents: [
      {
        transactionHash: SEAL_TX,
        blockNumber: '3',
        committedCount: 1,
        at: '2026-08-05T10:00:03.000Z',
      },
    ],
    runState: {
      state: 'SEALED',
      operator: OPERATOR,
      openedAt: '2026-08-05T10:00:00.000Z',
      sealedAt: '2026-08-05T10:00:03.000Z',
      committedCount: 1,
    },
    itemState: [
      { idx: 0, committed: true, payloadHash: PAYLOAD },
      { idx: 1, committed: false, payloadHash: ZERO_HASH },
    ],
  };
}

describe('manifest reconciliation and export', () => {
  it('produces one three-source row per item and keeps an honest veto green', () => {
    const manifest = buildManifest({
      ledger: ledger(),
      keeperHub: keeperHub(),
      registry: registry(),
    });

    expect(manifest.reconciliation.verdict).toBe('green');
    expect(manifest.reconciliation.rows).toHaveLength(2);
    expect(manifest.reconciliation.rows.map((row) => row.verdict)).toEqual(['green', 'green']);
    expect(manifest.reconciliation.rows[0]?.keeperHub.executions[0]?.gasUsedWei).toBe('91875');
    expect(manifest.reconciliation.rows[1]?.keeperHub.executions).toEqual([]);
    expect(manifest.run.budget.runEthUsd).toBe('3500.000000');
    expect(manifest.sources.keeperHub).toMatchObject({
      directExecutionStatus: true,
      keeperRunsAuditTrail: false,
    });
    expect(manifest.sha256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('surfaces a transaction divergence as amber', () => {
    const wrongHash = `0x${'ff'.repeat(32)}` as const;
    const manifest = buildManifest({
      ledger: ledger(),
      keeperHub: keeperHub(wrongHash),
      registry: registry(),
    });

    expect(manifest.reconciliation.verdict).toBe('amber');
    expect(manifest.reconciliation.rows[0]?.verdict).toBe('amber');
    expect(
      manifest.reconciliation.rows[0]?.checks.find(
        (entry) => entry.name === 'keeperhub-commit-matches-ledger',
      )?.agrees,
    ).toBe(false);
  });

  it('keeps the sha256 stable for an unchanged snapshot', () => {
    const first = buildManifest({ ledger: ledger(), keeperHub: keeperHub(), registry: registry() });
    const reversedStatuses = new Map([...keeperHub()].reverse());
    const second = buildManifest({
      ledger: ledger(),
      keeperHub: reversedStatuses,
      registry: registry(),
    });

    expect(second).toEqual(first);
    expect(second.sha256).toBe(first.sha256);
    expect(verifyManifest(second)).toBe(true);
    expect(
      verifyManifest({
        ...second,
        run: { ...second.run, status: 'ABORTED' },
      }),
    ).toBe(false);
  });
});

const exportManifestMock = vi.hoisted(() => vi.fn<() => Promise<ManifestDocument>>());

vi.mock('../lib/manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/manifest')>();
  return { ...actual, exportManifest: exportManifestMock };
});

describe('GET /api/runs/:id/manifest', () => {
  it('returns a sha-stamped JSON download with cache disabled', async () => {
    const manifest = buildManifest({
      ledger: ledger(),
      keeperHub: keeperHub(),
      registry: registry(),
    });
    exportManifestMock.mockResolvedValueOnce(manifest);
    const { GET } = await import('../app/api/runs/[id]/manifest/route');

    const response = await GET(new Request('http://convoy.test/api/runs/run-1/manifest'), {
      params: { id: 'run-1' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="convoy-manifest-run-1.json"',
    );
    expect(response.headers.get('etag')).toBe(`"${manifest.sha256}"`);
    expect(await response.json()).toEqual(manifest);
  });
});
