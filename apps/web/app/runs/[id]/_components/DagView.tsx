'use client';

import React, { useMemo } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';

import type { TimelineEvent, TimelineItem } from '@/lib/events';

import { deriveItemState, type TimelineLiveState } from './Timeline';

const STATE_COLOURS: Readonly<
  Record<string, { background: string; border: string; color: string }>
> = {
  DEFERRED: { background: '#fffbeb', border: '#f59e0b', color: '#92400e' },
  LANDED: { background: '#ecfdf5', border: '#10b981', color: '#065f46' },
  VETOED: { background: '#f4f4f5', border: '#a1a1aa', color: '#52525b' },
  FAILED: { background: '#fef2f2', border: '#ef4444', color: '#991b1b' },
  RETRYING: { background: '#fff7ed', border: '#f97316', color: '#9a3412' },
  SUBMITTED: { background: '#eff6ff', border: '#3b82f6', color: '#1e40af' },
  COMMITTED: { background: '#eef2ff', border: '#6366f1', color: '#3730a3' },
  SIMULATED: { background: '#f0f9ff', border: '#0ea5e9', color: '#075985' },
  PLANNED: { background: '#fafafa', border: '#71717a', color: '#27272a' },
};

export interface DagGraph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

function levelFor(
  item: TimelineItem,
  byIdx: ReadonlyMap<number, TimelineItem>,
  memo: Map<number, number>,
  visiting: Set<number>,
): number {
  const known = memo.get(item.idx);
  if (known !== undefined) return known;
  if (visiting.has(item.idx)) return 0;
  visiting.add(item.idx);
  const level = item.dependsOn.reduce((max, dependencyIdx) => {
    const dependency = byIdx.get(dependencyIdx);
    return dependency === undefined
      ? max
      : Math.max(max, levelFor(dependency, byIdx, memo, visiting) + 1);
  }, 0);
  visiting.delete(item.idx);
  memo.set(item.idx, level);
  return level;
}

export function buildDagGraph(
  items: readonly TimelineItem[],
  events: readonly TimelineEvent[],
): DagGraph {
  const byIdx = new Map(items.map((item) => [item.idx, item]));
  const states = new Map(items.map((item) => [item.idx, deriveItemState(item, events)]));
  const levels = new Map<number, number>();
  const rowsByLevel = new Map<number, number>();

  const nodes = items.map((item) => {
    const state = states.get(item.idx) ?? item.state;
    const level = levelFor(item, byIdx, levels, new Set());
    const row = rowsByLevel.get(level) ?? 0;
    rowsByLevel.set(level, row + 1);
    const colours = STATE_COLOURS[state] ?? STATE_COLOURS['PLANNED']!;
    return {
      id: String(item.idx),
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      position: { x: level * 270, y: row * 120 },
      data: { label: `#${item.idx} ${item.functionName} · ${state}` },
      style: {
        ...colours,
        borderWidth: 2,
        borderRadius: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        width: 220,
      },
      ariaLabel: `Item ${item.idx} ${item.functionName}, ${state}`,
    } satisfies Node;
  });

  const edges = items.flatMap((item) =>
    item.dependsOn.map((dependencyIdx) => {
      const waiting = states.get(item.idx) === 'DEFERRED' && states.get(dependencyIdx) !== 'LANDED';
      return {
        id: `${dependencyIdx}->${item.idx}`,
        source: String(dependencyIdx),
        target: String(item.idx),
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: waiting,
        className: waiting ? 'convoy-edge-deferred' : 'convoy-edge-ready',
        style: waiting
          ? { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '7 5' }
          : { stroke: '#71717a', strokeWidth: 2 },
        ariaLabel: `Item ${dependencyIdx} dependency for item ${item.idx}${waiting ? ', deferred' : ''}`,
      } satisfies Edge;
    }),
  );

  return { nodes, edges };
}

export function DagView({ runId, live }: { runId: string; live: TimelineLiveState }) {
  const graph = useMemo(() => buildDagGraph(live.items, live.events), [live.events, live.items]);
  return (
    <section aria-labelledby="dag-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 pb-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Run {runId}</p>
          <h1 id="dag-heading" className="text-2xl font-semibold text-zinc-950">
            Live dependency DAG
          </h1>
        </div>
        <span className="border border-zinc-300 px-2 py-1 text-xs font-semibold text-zinc-700">
          {live.runStatus}
        </span>
      </div>
      <div className="h-[620px] border border-zinc-200 bg-white" data-testid="dag-canvas">
        <ReactFlow
          nodes={[...graph.nodes]}
          edges={[...graph.edges]}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          aria-label="Run dependency graph"
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="text-xs text-zinc-500">
        Dashed animated edges are waiting for their prerequisite to land.
      </p>
    </section>
  );
}
