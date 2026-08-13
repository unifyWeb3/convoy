import { describe, expect, it } from 'vitest';

import { buildDagGraph } from '../app/runs/[id]/_components/DagView';
import type { TimelineEvent, TimelineItem } from '../lib/events';

function item(idx: number, dependsOn: readonly number[] = [], state = 'PLANNED'): TimelineItem {
  return {
    idx,
    targetAddress: `target-${idx}`,
    functionName: `action${idx}`,
    functionArgs: [],
    evidence: `evidence ${idx}`,
    plannerRationale: null,
    state,
    dependsOn,
    gasBudgetUsdc: null,
    vetoReason: null,
    attempts: [],
  };
}

function event(id: string, itemIdx: number, type: string): TimelineEvent {
  return {
    id,
    runId: 'run-1',
    itemIdx,
    type,
    payload: {},
    at: `2026-08-07T00:00:${id.padStart(2, '0')}.000Z`,
  };
}

describe('DagView render model', () => {
  it('renders one node per item and dependencyIdx -> itemIdx edges', () => {
    const graph = buildDagGraph([item(0), item(1, [0]), item(2, [0, 1])], []);
    expect(graph.nodes.map((node) => node.id)).toEqual(['0', '1', '2']);
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ['0', '1'],
      ['0', '2'],
      ['1', '2'],
    ]);
  });

  it('colours nodes from chronological live state transitions', () => {
    const graph = buildDagGraph(
      [item(0, [], 'RETRYING'), item(1, [], 'PLANNED')],
      [
        event('10', 0, 'ITEM_RETRY'),
        event('11', 0, 'ITEM_SUBMITTED'),
        event('12', 1, 'ITEM_LANDED'),
      ],
    );
    const submitted = graph.nodes.find((node) => node.id === '0');
    const landed = graph.nodes.find((node) => node.id === '1');
    expect(submitted?.data['label']).toContain('SUBMITTED');
    expect(submitted?.style).toMatchObject({
      background: 'var(--state-active-bg)',
      border: 'var(--state-active-edge)',
    });
    expect(landed?.data['label']).toContain('LANDED');
    expect(landed?.style).toMatchObject({
      background: 'var(--state-success-bg)',
      border: 'var(--state-success-edge)',
    });
  });

  it('keeps a budget-exhausted node visibly SKIPPED', () => {
    const skippedEvent: TimelineEvent = {
      ...event('1', 0, 'ITEM_FAILED'),
      payload: { reason: 'budget exhausted', skipped: true },
    };
    const graph = buildDagGraph([item(0, [], 'SKIPPED')], [skippedEvent]);
    expect(graph.nodes[0]?.data['label']).toContain('SKIPPED');
    expect(graph.nodes[0]?.style).toMatchObject({
      background: 'var(--state-partial-bg)',
      border: 'var(--state-partial-edge)',
    });
  });

  it('dashes and animates every still-blocked deferred edge', () => {
    const graph = buildDagGraph([item(0), item(1), item(2, [0, 1], 'DEFERRED')], []);
    expect(graph.edges).toHaveLength(2);
    for (const edge of graph.edges) {
      expect(edge.animated).toBe(true);
      expect(edge.className).toBe('convoy-edge-deferred');
      expect(edge.style).toMatchObject({
        strokeDasharray: '7 5',
        stroke: 'var(--state-deferred-edge)',
      });
    }
  });

  it('removes deferred styling from live edges after prerequisites land', () => {
    const graph = buildDagGraph(
      [item(0), item(1, [0], 'DEFERRED')],
      [event('1', 0, 'ITEM_LANDED'), event('2', 1, 'ITEM_SIMULATED')],
    );
    expect(graph.edges[0]).toMatchObject({
      source: '0',
      target: '1',
      animated: false,
      className: 'convoy-edge-ready',
    });
    expect(graph.nodes[1]?.data['label']).toContain('SIMULATED');
  });
});
