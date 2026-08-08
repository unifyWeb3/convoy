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
  SKIPPED: { background: '#fffbeb', border: '#f59e0b', color: '#92400e' },
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
  const waitingEdges = graph.edges.filter((edge) => edge.animated).length;
  return (
    <section aria-labelledby="dag-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#D9D9D3] pb-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7A7A7A]">
            Supporting execution evidence
          </p>
          <h2
            id="dag-heading"
            className="font-convoy-display mt-2 text-3xl text-[#1A1816] sm:text-4xl"
          >
            Live dependency DAG
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#7A7A7A]">
            The action list is the primary release story. This graph proves the declared ordering
            and shows which prerequisite edges are still holding work.
          </p>
        </div>
        <div className="flex gap-2">
          <span className="border border-[#CFCFC8] bg-white px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wider text-[#4F4B47]">
            {graph.edges.length} dependencies
          </span>
          <span className="border border-[#CFCFC8] bg-white px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wider text-[#4F4B47]">
            {waitingEdges} waiting
          </span>
        </div>
      </div>
      <div
        className="convoy-dag h-[480px] border border-[#2B2825] bg-[#2B2825] sm:h-[620px]"
        data-testid="dag-canvas"
      >
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
          <Background color="#5B5651" gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="flex flex-col gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-[#7A7A7A] sm:flex-row sm:items-center sm:justify-between">
        <span>Dashed animated edge = waiting for prerequisite</span>
        <span className="break-all">Run {runId}</span>
      </div>
    </section>
  );
}
