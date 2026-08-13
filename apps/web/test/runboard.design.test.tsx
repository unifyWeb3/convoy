import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AuditDrawer } from '../app/runs/[id]/_components/AuditDrawer';
import { buildDagGraph, DagView } from '../app/runs/[id]/_components/DagView';
import { Manifest } from '../app/runs/[id]/_components/Manifest';
import { RunDetail } from '../app/runs/[id]/_components/RunDetail';
import type { TimelineAttempt, TimelineEvent, TimelineItem, TimelineSnapshot } from '../lib/events';
import type { LedgerItemSnapshot, ManifestDocument, ManifestRow } from '../lib/manifest';

// The component package is compiled with the classic JSX runtime in Vitest;
// expose the imported React namespace for components that use JSX without a
// default React import. This is test-only and does not alter the application.
Object.assign(globalThis, { React });

vi.mock('@xyflow/react', async () => {
  const { createElement } = await import('react');
  const passthrough = (props: Record<string, unknown>) =>
    createElement(
      'div',
      { 'aria-label': props['aria-label'] as string | undefined },
      props['children'] as Parameters<typeof createElement>[2],
    );

  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrow-closed' },
    Position: { Left: 'left', Right: 'right' },
    ReactFlow: passthrough,
  };
});

vi.mock('../app/runs/[id]/_components/Timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/runs/[id]/_components/Timeline')>();
  return {
    ...actual,
    useTimelineLive: (_runId: string, initial: TimelineSnapshot) => ({
      events: initial.events,
      items: initial.items,
      runStatus: initial.run.status,
    }),
  };
});

const hex = (character: string, bytes: number): `0x${string}` => `0x${character.repeat(bytes * 2)}`;
const RUN_ONCHAIN = hex('1', 32);
const PAYLOAD_HASH = hex('2', 32);
const MANIFEST_HASH = hex('3', 32);
const TARGET = hex('4', 20);

function ledgerItem(state = 'LANDED'): LedgerItemSnapshot {
  return {
    idx: 0,
    targetAddress: TARGET,
    functionName: 'commitRelease',
    functionArgs: ['1'],
    payloadHash: PAYLOAD_HASH,
    evidence: 'Recorded release evidence.',
    state,
    dependsOn: [],
    gasBudgetUsdc: null,
    vetoReason: null,
    attempts: [],
    events: [],
  };
}

function manifestRow({
  verdict,
  registryAvailable,
  ledgerState,
  keeperHubError = null,
}: {
  verdict: 'green' | 'amber';
  registryAvailable: boolean;
  ledgerState: string;
  keeperHubError?: string | null;
}): ManifestRow {
  return {
    idx: 0,
    verdict,
    keeperHub: {
      commit:
        keeperHubError === null
          ? null
          : {
              available: false,
              executionId: 'recorded-execution',
              status: null,
              transactionHash: null,
              transactionLink: null,
              gasUsedWei: null,
              gasUsedWeiMeaning: null,
              sponsored: null,
              error: keeperHubError,
            },
      executions: [],
    },
    registry: {
      available: registryAvailable,
      commitEvent: null,
      committedInStorage: registryAvailable ? true : null,
      payloadHashInStorage: registryAvailable ? PAYLOAD_HASH : null,
      error: null,
    },
    ledger: ledgerItem(ledgerState),
    checks: [],
  };
}

function manifestDocument({
  status,
  verdict,
  registryAvailable = true,
  sealedAt = '2026-08-11T08:00:00.000Z',
}: {
  status: 'SEALED_OK' | 'SEALED_PARTIAL';
  verdict: 'green' | 'amber';
  registryAvailable?: boolean;
  sealedAt?: string | null;
}): ManifestDocument {
  return {
    schemaVersion: 1,
    sources: {
      keeperHub: {
        directExecutionStatus: true,
        keeperRunsAuditTrail: false,
        note: 'Direct execution status only.',
      },
      registry: { rpcVariable: 'BASE_RPC_URL', chainId: 84532 },
      ledger: { tables: ['runs', 'items', 'attempts', 'events'] },
    },
    run: {
      id: 'design-test-run',
      runIdOnchain: RUN_ONCHAIN,
      status,
      chainId: 84532,
      registryAddress: null,
      createdAt: '2026-08-11T07:00:00.000Z',
      sealedAt,
      snapshotAt: '2026-08-11T08:00:00.000Z',
      deadline: null,
      plan: null,
      ledgerEvents: [],
      budget: {
        budgetUsdc: '10.000000',
        spentGasUsdc: '1.000000',
        spentPayUsdc: '0.000000',
        runEthUsd: '3000.000000',
      },
    },
    reconciliation: {
      verdict,
      runChecks: [],
      rows: [
        manifestRow({
          verdict,
          registryAvailable,
          ledgerState: status === 'SEALED_OK' ? 'LANDED' : 'VETOED',
        }),
      ],
    },
    sha256: MANIFEST_HASH,
  };
}

function timelineAttempt(values: Partial<TimelineAttempt> = {}): TimelineAttempt {
  return {
    attemptNo: 0,
    kind: 'SIMULATE',
    executionId: 'simulation-evidence',
    transactionHash: null,
    transactionLink: null,
    gasUsedWei: null,
    gasUsedUsdc: null,
    sponsored: null,
    wouldRevert: true,
    revertReason: null,
    khStatus: 'completed',
    errorCode: null,
    createdAt: '2026-08-11T07:30:00.000Z',
    ...values,
  };
}

function timelineItem(values: Partial<TimelineItem> = {}): TimelineItem {
  return {
    idx: 0,
    targetAddress: TARGET,
    functionName: 'commitRelease',
    functionArgs: ['1'],
    evidence: 'Recorded release evidence.',
    plannerRationale: 'The action is supported by the supplied evidence.',
    state: 'PLANNED',
    dependsOn: [],
    gasBudgetUsdc: null,
    vetoReason: null,
    attempts: [],
    ...values,
  };
}

function timelineEvent(
  id: string,
  itemIdx: number | null,
  type: string,
  payload: Record<string, unknown>,
): TimelineEvent {
  return {
    id,
    runId: 'design-test-run',
    itemIdx,
    type,
    payload,
    at: `2026-08-11T07:30:${id.padStart(2, '0')}.000Z`,
  };
}

function definitionLabel(label: string): RegExp {
  return new RegExp(`<dt[^>]*>${label}</dt>`);
}

describe('Run Board design integration', () => {
  it('renders a reconciled terminal manifest with the preserved proof labels', () => {
    const html = renderToStaticMarkup(
      <Manifest
        runId="design-test-run"
        runStatus="SEALED_OK"
        initialManifest={manifestDocument({ status: 'SEALED_OK', verdict: 'green' })}
      />,
    );

    expect(html).toContain('Proof manifest');
    expect(html).toContain('SEALED OK');
    expect(html).toContain('Canonical SHA-256');
    expect(html).toContain(MANIFEST_HASH);
    expect(html).toContain('All recorded reconciliation checks agree.');
    expect(html).toContain('committed');
  });

  it('renders partial and unavailable manifest evidence honestly', () => {
    const html = renderToStaticMarkup(
      <Manifest
        runId="design-test-run"
        runStatus="SEALED_PARTIAL"
        initialManifest={manifestDocument({
          status: 'SEALED_PARTIAL',
          verdict: 'amber',
          registryAvailable: false,
          sealedAt: null,
        })}
      />,
    );

    expect(html).toContain('SEALED PARTIAL');
    expect(html).toContain('At least one source is unavailable or disagrees');
    expect(html).toContain('not recorded');
    expect(html).toContain('unavailable');
    expect(html).not.toContain('>—<');
  });

  it('renders a sanitized KeeperHub manifest error instead of hiding it as absent', () => {
    const document = manifestDocument({ status: 'SEALED_PARTIAL', verdict: 'amber' });
    const row = manifestRow({
      verdict: 'amber',
      registryAvailable: true,
      ledgerState: 'FAILED',
      keeperHubError: 'status unavailable from the recorded provider',
    });
    const html = renderToStaticMarkup(
      <Manifest
        runId="design-test-run"
        runStatus="SEALED_PARTIAL"
        initialManifest={{
          ...document,
          reconciliation: { ...document.reconciliation, rows: [row] },
        }}
      />,
    );

    expect(html).toContain('status unavailable from the recorded provider');
  });

  it('does not decorate absent selectors or fabricate gas for a vetoed action', () => {
    const html = renderToStaticMarkup(
      <AuditDrawer
        item={timelineItem({
          state: 'VETOED',
          vetoReason: 'simulation would revert',
          attempts: [timelineAttempt()],
        })}
        events={[
          timelineEvent('1', 0, 'ITEM_VETOED', {
            reason: 'simulation would revert',
            wouldRevert: true,
          }),
          timelineEvent('2', 0, 'ITEM_FAILED', {
            selector: 'unrelated-event-value',
          }),
        ]}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Critique &amp; simulation');
    expect(html).toContain('revertReason');
    expect(html).toContain('not recorded');
    expect(html).not.toMatch(definitionLabel('selector'));
    expect(html).not.toContain('unrelated-event-value');
    expect(html).toContain('gas not recorded');
    expect(html).not.toContain('gas 0');
    expect(html).not.toContain('0 USDC');
  });

  it('describes terminal deferred work as recorded outcome, not active waiting', () => {
    const items = [
      timelineItem({ idx: 0, functionName: 'commitDependency', state: 'VETOED' }),
      timelineItem({ idx: 1, functionName: 'releaseTarget', state: 'DEFERRED', dependsOn: [0] }),
    ];
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'SEALED_OK',
        budgetUsdc: '10.000000',
        spentGasUsdc: '1.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items,
      events: [
        timelineEvent('1', 0, 'ITEM_VETOED', { reason: 'simulation would revert' }),
        timelineEvent('2', 1, 'ITEM_DEFERRED', { dependencies: [0] }),
        { ...timelineEvent('3', 1, 'RUN_SEALED', {}), itemIdx: null },
      ],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect(html).toContain(
      'The registry seal completed. Every recorded item outcome remains visible below.',
    );
    expect(html).not.toContain('every action landed');
    expect(html).toContain('remains deferred because');
    expect(html).toContain('did not land before the run sealed');
    expect(html).toContain('Needs review');
    expect(html).not.toContain('is waiting on');
  });

  it('marks fatal terminal execution as an issue instead of waiting', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'FAILED_FATAL',
        budgetUsdc: '10.000000',
        spentGasUsdc: '1.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items: [timelineItem({ state: 'FAILED' })],
      events: [],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect(html).toContain('The run stopped before a complete seal');
    expect((html.match(/Needs review/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('does not present default budget zeros as observed spend without receipt evidence', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'RECEIVED',
        budgetUsdc: '10.000000',
        spentGasUsdc: '0.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: null,
      },
      items: [timelineItem({ state: 'PLANNED' })],
      events: [],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect((html.match(/not recorded/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain('0.00 USDC');
  });

  it('does not treat receipt rows without gas values or wallet debit as spend evidence', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'SEALED_OK',
        budgetUsdc: '10.000000',
        spentGasUsdc: '0.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items: [timelineItem({ state: 'LANDED' })],
      events: [
        timelineEvent('1', 0, 'ITEM_LANDED', {
          gasUsdcConsumed: null,
          walletDebitedUsdc: '0.000000',
        }),
      ],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect((html.match(/not recorded/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain('0.00 USDC');
  });

  it('keeps receipt-backed gas visible when the aggregate budget total is unavailable', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'SEALED_OK',
        budgetUsdc: '10.000000',
        spentGasUsdc: '0.030967',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items: [
        timelineItem({
          state: 'LANDED',
          attempts: [timelineAttempt({ kind: 'EXECUTE', gasUsedUsdc: '0.030967' })],
        }),
      ],
      events: [timelineEvent('1', 0, 'ITEM_LANDED', { gasUsdcConsumed: '0.030967' })],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect(html).toContain('Policy budget used');
    expect(html).toContain('unavailable');
    expect(html).toContain('0.030967 USDC');
    expect(html).toMatch(/Payment<\/dt><dd[^>]*>not recorded<\/dd>/);
  });

  it('includes streamed open, commit, and target receipts in the live gas record', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'EXECUTING',
        budgetUsdc: '10.000000',
        spentGasUsdc: '0.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items: [
        timelineItem({
          state: 'LANDED',
          attempts: [
            timelineAttempt({
              kind: 'COMMIT',
              executionId: 'commit-execution',
              transactionHash: 'commit-transaction',
              gasUsedUsdc: '0.002000',
            }),
            timelineAttempt({
              kind: 'EXECUTE',
              executionId: 'target-execution',
              transactionHash: 'target-transaction',
              gasUsedUsdc: '0.003000',
            }),
          ],
        }),
      ],
      events: [
        timelineEvent('1', null, 'RUN_OPENED', {
          executionId: 'open-execution',
          txHash: 'open-transaction',
          gasUsdcConsumed: '0.001000',
        }),
        timelineEvent('2', 0, 'ITEM_COMMITTED', {
          executionId: 'commit-execution',
          txHash: 'commit-transaction',
          gasUsdcConsumed: '0.002000',
        }),
        timelineEvent('3', 0, 'ITEM_LANDED', {
          txHash: 'target-transaction',
          gasUsdcConsumed: '0.003000',
        }),
      ],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    expect(html).toContain('Policy budget used');
    expect(html).toContain('0.006 USDC');
    expect(html).toMatch(/Payment<\/dt><dd[^>]*>not recorded<\/dd>/);
    expect(html).toContain('unavailable');
  });

  it('keeps every run tab linked to a stable tabpanel', () => {
    const snapshot: TimelineSnapshot = {
      run: {
        id: 'design-test-run',
        status: 'SEALED_OK',
        budgetUsdc: '10.000000',
        spentGasUsdc: '1.000000',
        spentPayUsdc: '0.000000',
        deadline: null,
        plan: { items: [] },
      },
      items: [timelineItem({ state: 'LANDED' })],
      events: [],
    };
    const html = renderToStaticMarkup(<RunDetail runId="design-test-run" snapshot={snapshot} />);

    for (const id of ['timeline', 'dag', 'manifest']) {
      expect(html).toContain(`aria-controls="run-panel-${id}"`);
      expect(html).toContain(`id="run-panel-${id}"`);
      expect(html).toContain(`aria-labelledby="run-tab-${id}"`);
    }
  });

  it('shows gate condition fields only when the ledger supplies them', () => {
    const item = timelineItem({ state: 'DEFERRED', dependsOn: [0] });
    const withoutCondition = renderToStaticMarkup(
      <AuditDrawer item={item} events={[]} onClose={() => undefined} />,
    );

    expect(withoutCondition).toContain('No onchain condition was recorded for this action.');
    expect(withoutCondition).not.toMatch(definitionLabel('operator'));
    expect(withoutCondition).not.toMatch(definitionLabel('met'));
    expect(withoutCondition).not.toMatch(definitionLabel('observedValue'));
    expect(withoutCondition).not.toMatch(definitionLabel('targetValue'));

    const withCondition = renderToStaticMarkup(
      <AuditDrawer
        item={item}
        events={[
          timelineEvent('2', 0, 'ITEM_SUBMITTED', {
            condition: {
              operator: 'equals',
              met: false,
              observedValue: false,
              targetValue: true,
            },
          }),
        ]}
        onClose={() => undefined}
      />,
    );

    expect(withCondition).toMatch(definitionLabel('operator'));
    expect(withCondition).toMatch(definitionLabel('met'));
    expect(withCondition).toMatch(definitionLabel('observedValue'));
    expect(withCondition).toMatch(definitionLabel('targetValue'));
    expect(withCondition).toContain('equals');
    expect(withCondition).toContain('false');
    expect(withCondition).toContain('true');
  });

  it('provides a textual equivalent for the live dependency graph', () => {
    const items = [
      timelineItem({ idx: 0, functionName: 'commitDependency', state: 'PLANNED' }),
      timelineItem({ idx: 1, functionName: 'releaseTarget', state: 'DEFERRED', dependsOn: [0] }),
    ];
    const live = { events: [], items, runStatus: 'EXECUTING' };
    const graph = buildDagGraph(items, live.events);
    const html = renderToStaticMarkup(<DagView runId="design-test-run" live={live} />);

    expect(html).toContain('data-testid="dag-canvas"');
    expect(html).toContain('Same graph, as text');
    expect(html).toContain('Dependency list');
    expect(html).toContain('Waiting on #01 Commit Dependency.');
    expect(graph.edges[0]?.className).toBe('convoy-edge-deferred');
    expect(graph.edges[0]?.animated).toBe(true);
    expect(graph.edges[0]?.source).toBe('0');
    expect(graph.edges[0]?.target).toBe('1');
  });

  it('describes a terminal deferred dependency as unresolved history', () => {
    const items = [
      timelineItem({ idx: 0, functionName: 'commitDependency', state: 'VETOED' }),
      timelineItem({ idx: 1, functionName: 'releaseTarget', state: 'DEFERRED', dependsOn: [0] }),
    ];
    const live = { events: [], items, runStatus: 'SEALED_OK' };
    const html = renderToStaticMarkup(<DagView runId="design-test-run" live={live} />);

    expect(html).toContain('1 unresolved');
    expect(html).toContain(
      'Prerequisite #01 Commit Dependency did not land before the run sealed.',
    );
    expect(html).toContain('unmet / deferred');
    expect(html).not.toContain('Waiting on #01 Commit Dependency.');
  });
});
