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
    targetAddress: `0x${String(idx + 1).padStart(40, '0')}`,
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
): TimelineSnapshot {
  return {
    run: {
      id: 'run-1',
      status: 'EXECUTING',
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
    expect(html).toContain('border-sky-200 bg-sky-50 text-sky-800">SUBMITTED</span>');
  });

  it('stacks multiple observed retries visibly', () => {
    const events = [
      event('2', 0, 'ITEM_RETRY', { attempt: 1, code: 'N-0001' }),
      event('3', 0, 'ITEM_SUBMITTED', { attempt: 1 }),
      event('4', 0, 'ITEM_RETRY', { attempt: 2, code: 'E-0002' }),
      event('5', 0, 'ITEM_SUBMITTED', { attempt: 2 }),
    ];
    const html = renderToStaticMarkup(
      <Timeline runId="run-1" initial={snapshot([item(0)], events)} />,
    );

    expect(html).toContain('retry 1 N-0001');
    expect(html).toContain('retry 2 E-0002');
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
    expect(html).toContain('RETRY #1');
    expect(html).toContain('code: N-0001');
  });

  it('shows required veto and failure details', () => {
    const vetoed = item(0, { state: 'VETOED', vetoReason: 'would_revert' });
    const failed = item(1, { state: 'FAILED' });
    const events = [
      event('1', 0, 'ITEM_VETOED', {
        reason: 'would_revert',
        revert: 'RootAlreadySet()',
      }),
      event('2', 1, 'ITEM_FAILED', { code: 'C-0001', reason: 'execution failed' }),
    ];
    const html = renderToStaticMarkup(
      <Timeline runId="run-1" initial={snapshot([vetoed, failed], events)} />,
    );

    expect(html).toContain('0 gas · RootAlreadySet()');
    expect(html).toContain('execution failed');
    expect(html).toContain('VETOED');
    expect(html).toContain('FAILED');
  });
});
