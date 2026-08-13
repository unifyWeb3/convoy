import { describe, expect, it } from 'vitest';

import { deferredItemsReadyForRelease, plannerPriority } from '../src/orchestrator.js';

describe('Planner order and dependency gates', () => {
  it('uses persisted Planner order for ready items', () => {
    expect(plannerPriority({ order: [2, 0, 1] }, [0, 1, 2])).toEqual([2, 0, 1]);
  });

  it('keeps dependency gating authoritative over Planner order', () => {
    const items = [
      { idx: 0, state: 'LANDED', dependsOn: [] },
      { idx: 1, state: 'DEFERRED', dependsOn: [0] },
      { idx: 2, state: 'DEFERRED', dependsOn: [3] },
      { idx: 3, state: 'LANDED', dependsOn: [] },
    ];
    const priority = plannerPriority(
      { order: [2, 1, 0, 3] },
      items.map((item) => item.idx),
    );
    expect(priority.slice(0, 2)).toEqual([2, 1]);
    expect(deferredItemsReadyForRelease(items)).toEqual([1, 2]);
    expect(priority.filter((idx) => deferredItemsReadyForRelease(items).includes(idx))).toEqual([
      2, 1,
    ]);
  });

  it('falls back to deterministic index order for malformed persisted order', () => {
    expect(plannerPriority({ order: [2, 2, 0] }, [0, 1, 2])).toEqual([0, 1, 2]);
  });
});
