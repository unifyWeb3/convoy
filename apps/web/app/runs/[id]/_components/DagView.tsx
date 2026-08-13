'use client';

import React, { useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';

import type { TimelineEvent, TimelineItem } from '@/lib/events';

import { humanize, StateChip, StateGlyph } from './RunBoardPrimitives';
import { deriveItemState, type TimelineLiveState } from './Timeline';

interface DagNodeData extends Record<string, unknown> {
  readonly idx: number;
  readonly functionName: string;
  readonly state: string;
  readonly label: string;
}

const TERMINAL_RUNS = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);

const DAG_COLOURS: Readonly<Record<string, { background: string; border: string; color: string }>> =
  {
    DEFERRED: {
      background: 'var(--state-deferred-bg)',
      border: 'var(--state-deferred-edge)',
      color: 'var(--state-deferred-fg)',
    },
    LANDED: {
      background: 'var(--state-success-bg)',
      border: 'var(--state-success-edge)',
      color: 'var(--state-success-fg)',
    },
    VETOED: {
      background: 'var(--state-vetoed-bg)',
      border: 'var(--state-vetoed-edge)',
      color: 'var(--state-vetoed-fg)',
    },
    FAILED: {
      background: 'var(--state-failed-bg)',
      border: 'var(--state-failed-edge)',
      color: 'var(--state-failed-fg)',
    },
    SKIPPED: {
      background: 'var(--state-partial-bg)',
      border: 'var(--state-partial-edge)',
      color: 'var(--state-partial-fg)',
    },
    RETRYING: {
      background: 'var(--state-retrying-bg)',
      border: 'var(--state-retrying-edge)',
      color: 'var(--state-retrying-fg)',
    },
    SUBMITTED: {
      background: 'var(--state-active-bg)',
      border: 'var(--state-active-edge)',
      color: 'var(--state-active-fg)',
    },
    COMMITTED: {
      background: 'var(--state-active-bg)',
      border: 'var(--state-active-edge)',
      color: 'var(--state-active-fg)',
    },
    SIMULATED: {
      background: 'var(--state-active-bg)',
      border: 'var(--state-active-edge)',
      color: 'var(--state-active-fg)',
    },
    PLANNED: {
      background: 'var(--state-neutral-bg)',
      border: 'var(--state-neutral-edge)',
      color: 'var(--state-neutral-fg)',
    },
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
    const colours = DAG_COLOURS[state] ?? DAG_COLOURS['PLANNED']!;
    return {
      id: String(item.idx),
      type: 'convoy',
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      position: { x: level * 270, y: row * 120 },
      data: {
        idx: item.idx,
        functionName: item.functionName,
        state,
        label: `${String(item.idx + 1).padStart(2, '0')} · ${item.functionName} · ${state}`,
      } satisfies DagNodeData,
      className: `convoy-dag-node convoy-dag-node-${state.toLowerCase()}`,
      style: {
        ...colours,
        borderWidth: 2,
        borderRadius: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        width: 220,
      },
      ariaLabel: `Item ${item.idx + 1} ${item.functionName}, ${state}`,
    } satisfies Node<DagNodeData>;
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
          ? {
              stroke: 'var(--state-deferred-edge)',
              strokeWidth: 2,
              strokeDasharray: '7 5',
            }
          : { stroke: 'var(--state-neutral-edge)', strokeWidth: 2 },
        ariaLabel: `Item ${dependencyIdx + 1} dependency for item ${item.idx + 1}${waiting ? ', deferred' : ''}`,
      } satisfies Edge;
    }),
  );

  return { nodes, edges };
}

function DagNode({ data }: NodeProps<Node<DagNodeData>>) {
  return (
    <div
      aria-label={`Item ${data.idx + 1}, ${humanize(data.functionName)}, ${humanize(data.state)}`}
      className={`flex min-h-11 w-full items-center gap-2 border-0 bg-transparent px-2 py-1 text-left text-[11px] font-medium text-current`}
      role="img"
    >
      <Handle
        className="!h-2 !w-2 !border-white !bg-[var(--state-neutral-edge)]"
        position={Position.Left}
        type="target"
      />
      <StateGlyph state={data.state} size={14} />
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        <span className="font-mono">#{String(data.idx + 1).padStart(2, '0')}</span>{' '}
        {humanize(data.functionName)}
      </span>
      <Handle
        className="!h-2 !w-2 !border-white !bg-[var(--state-neutral-edge)]"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

const nodeTypes = { convoy: DagNode };

function dependencyRelation(
  item: TimelineItem,
  items: readonly TimelineItem[],
  states: ReadonlyMap<number, string>,
  runStatus: string,
): string {
  if (item.dependsOn.length === 0) return 'No prerequisites — eligible from the start.';
  const prerequisites = item.dependsOn.map((idx) =>
    items.find((candidate) => candidate.idx === idx),
  );
  const labels = prerequisites.map((prerequisite, index) =>
    prerequisite === undefined
      ? item.dependsOn[index] === undefined
        ? 'item unavailable'
        : `#${(item.dependsOn[index] ?? 0) + 1}`
      : `#${String(prerequisite.idx + 1).padStart(2, '0')} ${humanize(prerequisite.functionName)}`,
  );
  const unmet = prerequisites.filter(
    (prerequisite) => prerequisite !== undefined && states.get(prerequisite.idx) !== 'LANDED',
  );
  if (unmet.length === 0) {
    return `App-side prerequisites satisfied: ${labels.join(', ')} all landed.`;
  }
  const waiting = unmet.map(
    (prerequisite) =>
      `#${String(prerequisite!.idx + 1).padStart(2, '0')} ${humanize(prerequisite!.functionName)}`,
  );
  if (TERMINAL_RUNS.has(runStatus)) {
    const subject = waiting.length === 1 ? 'Prerequisite' : 'Prerequisites';
    const ending =
      runStatus === 'ABORTED'
        ? 'before the run was aborted.'
        : runStatus === 'FAILED_FATAL'
          ? 'before processing stopped.'
          : 'before the run sealed.';
    return `${subject} ${waiting.join(' and ')} did not land ${ending}`;
  }
  return `Waiting on ${waiting.join(' and ')}.`;
}

export function DagView({ runId, live }: { runId: string; live: TimelineLiveState }) {
  const graph = useMemo(() => buildDagGraph(live.items, live.events), [live.events, live.items]);
  const states = useMemo(
    () =>
      new Map(live.items.map((item) => [item.idx, deriveItemState(item, live.events)] as const)),
    [live.events, live.items],
  );
  const terminal = TERMINAL_RUNS.has(live.runStatus);
  const waitingEdges = graph.edges.filter((edge) => edge.animated).length;
  const renderedEdges = useMemo(
    () =>
      terminal
        ? graph.edges.map((edge) => ({
            ...edge,
            animated: false,
            style: { ...edge.style, animation: 'none', opacity: 0.75 },
          }))
        : graph.edges,
    [graph.edges, terminal],
  );

  return (
    <section aria-labelledby="dag-heading" className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--convoy-rule)] pb-5">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
            Supporting execution evidence
          </p>
          <h2
            id="dag-heading"
            className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)] sm:text-4xl"
          >
            Live dependency DAG
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--convoy-text-body)]">
            Edges run from prerequisite to dependent. Positions are deterministic, so a state change
            does not move an action. On narrow screens, scroll sideways or use the text equivalent
            below.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="border border-[var(--convoy-rule-strong)] bg-white px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)]">
            {graph.edges.length} dependenc{graph.edges.length === 1 ? 'y' : 'ies'}
          </span>
          <span className="border border-[var(--convoy-rule-strong)] bg-white px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)]">
            {waitingEdges} {terminal ? 'unresolved' : 'waiting'}
          </span>
        </div>
      </div>

      <div className="convoy-mobile-scroll border border-[var(--convoy-dark)] bg-[var(--convoy-dark)] p-3 sm:p-4">
        <div
          className="convoy-dag convoy-grid h-[480px] min-w-[760px] border border-white/10 bg-[var(--convoy-dark)] sm:h-[620px]"
          data-testid="dag-canvas"
        >
          <ReactFlow
            edges={[...renderedEdges]}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            maxZoom={1.5}
            minZoom={0.25}
            nodeTypes={nodeTypes}
            nodes={[...graph.nodes]}
            nodesConnectable={false}
            nodesDraggable={false}
            aria-label="Run dependency graph"
          >
            <Background color="var(--convoy-dag-grid)" gap={32} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-3 font-mono text-[9px] uppercase tracking-[0.11em] text-[var(--convoy-on-dark-muted)]">
          <span className="flex items-center gap-2">
            <span className="h-px w-7 bg-[var(--state-neutral-edge)]" /> prerequisite landed
          </span>
          <span className="flex items-center gap-2">
            <span className="w-7 border-t-2 border-dashed border-[var(--state-deferred-edge)]" />
            {terminal ? 'unmet / deferred' : 'waiting / deferred'}
          </span>
        </div>
      </div>

      <section aria-labelledby="dag-list-heading" className="space-y-4">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
            Same graph, as text
          </p>
          <h3
            id="dag-list-heading"
            className="font-convoy-display mt-2 text-2xl text-[var(--convoy-ink-soft)] sm:text-3xl"
          >
            Dependency list
          </h3>
          <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-body)]">
            Every relationship above is stated in reading order for keyboard and screen-reader
            users.
          </p>
        </div>
        <ol className="grid gap-px border border-[var(--convoy-border)] bg-[var(--convoy-border)]">
          {live.items.map((item) => {
            const state = states.get(item.idx) ?? item.state;
            return (
              <li
                key={item.idx}
                className={`grid gap-3 bg-white p-3 sm:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)] sm:items-center sm:px-4 ${
                  state === 'VETOED' ? 'convoy-veto-hatch' : ''
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StateGlyph state={state} size={13} title={humanize(state)} />
                  <span className="font-mono text-[10px] text-[var(--convoy-text-meta)]">
                    #{String(item.idx + 1).padStart(2, '0')}
                  </span>
                  <span className="convoy-proof-value min-w-0 text-sm font-semibold text-[var(--convoy-ink-soft)]">
                    {humanize(item.functionName)}
                  </span>
                  <span className="ml-auto sm:hidden">
                    <StateChip state={state} />
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs leading-5 text-[var(--convoy-text-body)]">
                    {dependencyRelation(item, live.items, states, live.runStatus)}
                  </p>
                  <span className="hidden shrink-0 sm:inline-flex">
                    <StateChip state={state} />
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <p className="convoy-proof-value break-all font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-subtle)]">
        Run {runId}
      </p>
    </section>
  );
}
