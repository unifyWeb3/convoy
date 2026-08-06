import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Timeline } from '../app/runs/[id]/_components/Timeline';
import type { TimelineSnapshot } from '../lib/events';

const snapshot: TimelineSnapshot = {
  run: {
    id: 'run-1',
    status: 'EXECUTING',
    budgetUsdc: '10',
    spentGasUsdc: '1',
    spentPayUsdc: '0',
    deadline: null,
    plan: null,
  },
  items: [
    {
      idx: 0,
      targetAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'fund',
      functionArgs: ['5'],
      evidence: 'Fund the distributor.',
      plannerRationale: 'Funding follows the published root.',
      state: 'LANDED',
      dependsOn: [],
      gasBudgetUsdc: '2',
      vetoReason: null,
      attempts: [
        {
          attemptNo: 0,
          kind: 'EXECUTE',
          executionId: 'e1',
          transactionHash: '0xabc',
          transactionLink: 'https://sepolia.basescan.org/tx/0xabc',
          gasUsedWei: '1',
          gasUsedUsdc: '0.1',
          sponsored: true,
          wouldRevert: null,
          revertReason: null,
          khStatus: 'completed',
          errorCode: null,
          createdAt: '2026-08-06T00:00:00.000Z',
        },
      ],
    },
  ],
  events: [
    {
      id: '1',
      runId: 'run-1',
      itemIdx: 0,
      type: 'ITEM_LANDED',
      payload: { gasUsdcConsumed: '0.1', txHash: '0xabc' },
      at: '2026-08-06T00:00:00.000Z',
    },
  ],
};

describe('Timeline', () => {
  it('renders item state, gas, and an audit affordance', () => {
    const html = renderToStaticMarkup(<Timeline runId="run-1" initial={snapshot} />);
    expect(html).toContain('Execution timeline');
    expect(html).toContain('LANDED');
    expect(html).toContain('0.1 USDC gas');
    expect(html).toContain('fund');
  });
});
