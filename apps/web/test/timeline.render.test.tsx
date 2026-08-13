import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AuditDrawer } from '../app/runs/[id]/_components/AuditDrawer';
import {
  applyTimelineEvent,
  deriveItemState,
  Timeline,
  type TimelineLiveState,
} from '../app/runs/[id]/_components/Timeline';
import type { TimelineAttempt, TimelineEvent, TimelineItem, TimelineSnapshot } from '../lib/events';

function attempt(
  kind: string,
  attemptNo: number,
  values: Partial<TimelineAttempt> = {},
): TimelineAttempt {
  return {
    attemptNo,
    kind,
    executionId: `${kind.toLowerCase()}-${attemptNo}`,
    transactionHash: null,
    transactionLink: null,
    gasUsedWei: null,
    gasUsedUsdc: null,
    sponsored: null,
    wouldRevert: null,
    revertReason: null,
    khStatus: 'completed',
    errorCode: null,
    createdAt: `2026-08-06T00:00:0${attemptNo}.000Z`,
    ...values,
  };
}

function item(idx: number, values: Partial<TimelineItem> = {}): TimelineItem {
  return {
    idx,
    targetAddress: `target-${idx}`,
    functionName: `action${idx}`,
    functionArgs: [],
    evidence: `Evidence for ${idx}`,
    plannerRationale: `Rationale for ${idx}`,
    state: 'PLANNED',
    dependsOn: [],
    gasBudgetUsdc: '2',
    vetoReason: null,
    attempts: [],
    ...values,
  };
}

function event(
  id: string,
  itemIdx: number,
  type: string,
  payload: Record<string, unknown> = {},
  attempts?: readonly TimelineAttempt[],
): TimelineEvent {
  return {
    id,
    runId: 'run-1',
    itemIdx,
    type,
    payload,
    at: `2026-08-06T00:00:${id.padStart(2, '0')}.000Z`,
    ...(attempts === undefined ? {} : { attempts }),
  };
}

function snapshot(
  items: readonly TimelineItem[],
  events: readonly TimelineEvent[],
  status = 'EXECUTING',
): TimelineSnapshot {
  return {
    run: {
      id: 'run-1',
      status,
      budgetUsdc: '10',
      spentGasUsdc: '1',
      spentPayUsdc: '0',
      deadline: null,
      plan: null,
    },
    items,
    events,
  };
}

describe('Timeline', () => {
  it('uses chronological transitions when ITEM_RETRY is followed by ITEM_SUBMITTED', () => {
    const row = item(0, { state: 'RETRYING' });
    const events = [
      event('10', 0, 'ITEM_RETRY', { attempt: 1, code: 'N-0001' }),
      event('11', 0, 'ITEM_SUBMITTED', { attempt: 1 }),
    ];

    expect(deriveItemState(row, events)).toBe('SUBMITTED');
    const html = renderToStaticMarkup(<Timeline runId="run-1" initial={snapshot([row], events)} />);
    expect(html).toContain('data-state="SUBMITTED"');
  });

  it('preserves budget-exhausted items as SKIPPED instead of relabelling them FAILED', () => {
    const skipped = item(0, { state: 'SKIPPED' });
    const events = [event('10', 0, 'ITEM_FAILED', { reason: 'budget exhausted', skipped: true })];

    expect(deriveItemState(skipped, events)).toBe('SKIPPED');
    const html = renderToStaticMarkup(
      <Timeline runId="run-1" initial={snapshot([skipped], events)} />,
    );
    expect(html).toContain('>SKIPPED</span>');
    expect(html).toContain('budget exhausted');
  });

  it('stacks multiple observed retries visibly', () => {
    const events = [
      event('2', 0, 'ITEM_RETRY', { retryCount: 1, code: 'N-0001' }),
      event('3', 0, 'ITEM_SUBMITTED', { attempt: 1 }),
      event('4', 0, 'ITEM_RETRY', { retryCount: 2, code: 'E-0002' }),
      event('5', 0, 'ITEM_SUBMITTED', { attempt: 2 }),
    ];
    const html = renderToStaticMarkup(
      <Timeline runId="run-1" initial={snapshot([item(0)], events)} />,
    );

    expect(html).toContain('retry observed · provider count 1 · N-0001');
    expect(html).toContain('retry observed · provider count 2 · E-0002');
  });

  it('does not invent a retry count when the ledger did not record one', () => {
    const html = renderToStaticMarkup(
      <Timeline
        runId="run-1"
        initial={snapshot([item(0)], [event('2', 0, 'ITEM_RETRY', { code: 'N-0001' })])}
      />,
    );

    expect(html).toContain('retry observed · N-0001');
    expect(html).not.toContain('provider count');
  });

  it('merges live attempt snapshots into the audit drawer', () => {
    const attempts = [
      attempt('SIMULATE', 0, { wouldRevert: false, khStatus: '200' }),
      attempt('COMMIT', 0, {
        transactionHash: '0xcommit',
        transactionLink: 'https://sepolia.basescan.org/tx/0xcommit',
      }),
      attempt('EXECUTE', 1, {
        transactionHash: '0xexecute',
        transactionLink: 'https://sepolia.basescan.org/tx/0xexecute',
        gasUsedUsdc: '0.100000',
      }),
    ];
    const initial: TimelineLiveState = {
      events: [event('1', 0, 'ITEM_SIMULATED', { wouldRevert: false, gasEstimate: '90000' })],
      items: [item(0)],
      runStatus: 'EXECUTING',
    };
    const retry = event('2', 0, 'ITEM_RETRY', { attempt: 1, code: 'N-0001' });
    const live = applyTimelineEvent(
      applyTimelineEvent(initial, retry),
      event('3', 0, 'ITEM_LANDED', { txHash: '0xexecute' }, attempts),
    );
    const liveItem = live.items[0];
    expect(liveItem).toBeDefined();

    const html = renderToStaticMarkup(
      <AuditDrawer item={liveItem!} events={live.events} onClose={() => undefined} />,
    );
    expect(html).toContain('SIMULATE #1');
    expect(html).toContain('COMMIT #1');
    expect(html).toContain('EXECUTE #2');
    expect(html).toContain('hash: 0xcommit');
    expect(html).toContain('hash: 0xexecute');
    expect(html).toContain('href="https://sepolia.basescan.org/tx/0xexecute"');
    expect(html).toContain('RETRY OBSERVED');
    expect(html).toContain('code: N-0001');
  });

  it('does not claim Critic approval before simulation evidence exists', () => {
    const beforeSimulation = renderToStaticMarkup(
      <AuditDrawer item={item(0)} events={[]} onClose={() => undefined} />,
    );
    expect(beforeSimulation).toContain('not recorded');
    expect(beforeSimulation).not.toContain('APPROVED</dd>');

    const afterSimulation = renderToStaticMarkup(
      <AuditDrawer
        item={item(0)}
        events={[event('1', 0, 'ITEM_SIMULATED', { wouldRevert: false, criticConsulted: true })]}
        onClose={() => undefined}
      />,
    );
    expect(afterSimulation).toContain('APPROVED</dd>');

    const withoutCritic = renderToStaticMarkup(
      <AuditDrawer
        item={item(0)}
        events={[event('1', 0, 'ITEM_SIMULATED', { wouldRevert: false, criticConsulted: false })]}
        onClose={() => undefined}
      />,
    );
    expect(withoutCritic).toContain('SIMULATION PASSED</dd>');
    expect(withoutCritic).not.toContain('APPROVED</dd>');
  });

  it('treats pre-seal RUN_SEALED as SEALING until the final event', () => {
    const initial: TimelineLiveState = {
      events: [],
      items: [item(0)],
      runStatus: 'EXECUTING',
    };
    const sealing = applyTimelineEvent(initial, {
      ...event('1', 0, 'RUN_SEALED', { phase: 'sealing' }),
      itemIdx: null,
    });
    const sealed = applyTimelineEvent(sealing, {
      ...event('2', 0, 'RUN_SEALED_PARTIAL'),
      itemIdx: null,
    });

    expect(sealing.runStatus).toBe('SEALING');
    expect(sealed.runStatus).toBe('SEALED_PARTIAL');
  });

  it('shows required veto and failure details', () => {
    const vetoed = item(0, { state: 'VETOED', vetoReason: 'would_revert' });
    const failed = item(1, { state: 'FAILED' });
    const events = [
      event('1', 0, 'ITEM_VETOED', {
        reason: 'would_revert',
        revert: 'RootAlreadySet()',
        gasSpent: 0,
      }),
      event('2', 1, 'ITEM_FAILED', { code: 'C-0001', reason: 'execution failed' }),
    ];
    const html = renderToStaticMarkup(
      <Timeline runId="run-1" initial={snapshot([vetoed, failed], events)} />,
    );

    expect(html).toContain('0 gas recorded · RootAlreadySet()');
    expect(html).toContain('execution failed');
    expect(html).toContain('VETOED');
    expect(html).toContain('FAILED');
  });

  it('marks phases after a veto as unreached', () => {
    const vetoed = item(0, { state: 'VETOED', vetoReason: 'would_revert' });
    const html = renderToStaticMarkup(
      <Timeline
        runId="run-1"
        initial={snapshot(
          [vetoed],
          [
            event('1', 0, 'ITEM_SIMULATED', { wouldRevert: true }),
            event('2', 0, 'ITEM_VETOED', { reason: 'would_revert' }),
          ],
        )}
      />,
    );

    expect(html).toMatch(/data-phase="PLANNED" data-phase-state="reached"/);
    expect(html).toMatch(/data-phase="SIMULATED" data-phase-state="reached"/);
    expect(html).toMatch(
      /data-phase="COMMITTED" data-phase-state="unreached"[^>]*>.*?data-state="PENDING".*?COMMITTED<\/span>/,
    );
    expect(html).toMatch(/data-phase="SUBMITTED" data-phase-state="unreached"/);
    expect(html).toMatch(/data-phase="LANDED" data-phase-state="unreached"/);
    expect(html).toContain('data-current-item-state="VETOED"');
    expect(html).toContain('stopped · VETOED');
  });

  it('keeps deferred work current without implying later phases occurred', () => {
    const deferred = item(0, { state: 'DEFERRED', dependsOn: [1] });
    const html = renderToStaticMarkup(
      <Timeline
        runId="run-1"
        initial={snapshot([deferred, item(1)], [event('1', 0, 'ITEM_DEFERRED', {})])}
      />,
    );

    expect(html).toMatch(/data-phase="PLANNED" data-phase-state="reached"/);
    for (const phase of ['SIMULATED', 'COMMITTED', 'SUBMITTED', 'LANDED']) {
      expect(html).toMatch(new RegExp(`data-phase="${phase}" data-phase-state="unreached"`));
    }
    expect(html).toContain('data-current-item-state="DEFERRED"');
    expect(html).toContain('current · DEFERRED');
  });

  it('renders terminal deferred work as stopped rather than actively waiting', () => {
    const deferred = item(0, { state: 'DEFERRED', dependsOn: [1] });
    const html = renderToStaticMarkup(
      <Timeline
        runId="run-1"
        initial={snapshot(
          [deferred, item(1, { state: 'VETOED' })],
          [event('1', 0, 'ITEM_DEFERRED', {})],
          'SEALED_OK',
        )}
      />,
    );

    expect(html).toContain('Prerequisite did not land before the run sealed');
    expect(html).toContain('stopped · DEFERRED');
    expect(html).not.toContain('current · DEFERRED');
    expect(html).not.toContain('Waiting for prerequisite actions');
  });
});
