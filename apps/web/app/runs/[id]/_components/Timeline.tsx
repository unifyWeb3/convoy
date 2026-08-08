'use client';

import React, { useEffect, useMemo, useState } from 'react';

import type { TimelineEvent, TimelineItem, TimelineSnapshot } from '@/lib/events';

import { AuditDrawer } from './AuditDrawer';

const FLOW = ['PLANNED', 'SIMULATED', 'COMMITTED', 'SUBMITTED', 'LANDED'] as const;

function chipClass(state: string): string {
  if (state === 'LANDED' || state === 'SEALED_OK')
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (state === 'VETOED') return 'border-zinc-300 bg-zinc-100 text-zinc-500';
  if (state === 'SKIPPED') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (state === 'FAILED' || state === 'FAILED_FATAL' || state === 'SEALED_PARTIAL')
    return 'border-red-200 bg-red-50 text-red-800';
  if (state === 'RETRYING') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-sky-200 bg-sky-50 text-sky-800';
}

const EVENT_STATE: Readonly<Record<string, string>> = {
  PLAN_READY: 'PLANNED',
  ITEM_DEFERRED: 'DEFERRED',
  ITEM_SIMULATED: 'SIMULATED',
  ITEM_VETOED: 'VETOED',
  ITEM_COMMITTED: 'COMMITTED',
  ITEM_SUBMITTED: 'SUBMITTED',
  ITEM_RETRY: 'RETRYING',
  ITEM_LANDED: 'LANDED',
  ITEM_FAILED: 'FAILED',
};

function compareEventIds(a: TimelineEvent, b: TimelineEvent): number {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a.id.localeCompare(b.id);
}

export function deriveItemState(item: TimelineItem, events: readonly TimelineEvent[]): string {
  let state = item.state === 'PENDING' ? 'PLANNED' : item.state;
  const itemEvents = events.filter((event) => event.itemIdx === item.idx).sort(compareEventIds);
  for (const event of itemEvents) {
    state =
      event.type === 'ITEM_FAILED' && event.payload['skipped'] === true
        ? 'SKIPPED'
        : (EVENT_STATE[event.type] ?? state);
  }
  return state;
}

function eventDetail(event: TimelineEvent): string | null {
  const payload = event.payload;
  for (const key of ['detail', 'reason', 'revert', 'code', 'status']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function formatArguments(value: unknown): string {
  try {
    const formatted = JSON.stringify(value);
    if (formatted === undefined) return '[]';
    return formatted.length > 82 ? `${formatted.slice(0, 79)}…` : formatted;
  } catch {
    return '[unavailable]';
  }
}

function stateExplanation(state: string): string {
  if (state === 'LANDED') return 'Landed on Base Sepolia';
  if (state === 'VETOED') return 'Stopped before execution';
  if (state === 'FAILED') return 'Stopped with recorded evidence';
  if (state === 'SKIPPED') return 'Skipped after the run budget was exhausted';
  if (state === 'RETRYING') return 'A real transient failure was observed';
  if (state === 'DEFERRED') return 'Waiting for prerequisite actions';
  if (state === 'SIMULATED') return 'Simulation and critique approved';
  if (state === 'COMMITTED') return 'Committed in ConvoyRegistry';
  if (state === 'SUBMITTED') return 'Submitted through KeeperHub';
  return 'Ready for safety review';
}

export interface TimelineLiveState {
  readonly events: readonly TimelineEvent[];
  readonly items: readonly TimelineItem[];
  readonly runStatus: string;
}

export function useTimelineLive(
  runId: string,
  initial: TimelineSnapshot,
  enabled = true,
): TimelineLiveState {
  const [live, setLive] = useState<TimelineLiveState>({
    events: initial.events,
    items: initial.items,
    runStatus: initial.run.status,
  });

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const handleMessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as TimelineEvent;
        setLive((current) => applyTimelineEvent(current, event));
      } catch {
        // Ignore malformed events; the next refresh replays the append-only log.
      }
    };
    source.addEventListener('convoy', handleMessage as EventListener);
    source.addEventListener('convoy-end', () => source.close());
    return () => {
      source.removeEventListener('convoy', handleMessage as EventListener);
      source.close();
    };
  }, [enabled, runId]);

  return live;
}

export interface TimelineProps {
  readonly runId: string;
  readonly initial: TimelineSnapshot;
  readonly live?: TimelineLiveState;
}

function runStatusAfterEvent(current: string, event: TimelineEvent): string {
  if (event.type === 'RUN_OPENED') return 'PLANNING';
  if (event.type === 'PLAN_READY') {
    return Array.isArray(event.payload['ready']) ? 'EXECUTING' : 'CRITIQUING';
  }
  if (event.type === 'RUN_SEALED') {
    return event.payload['phase'] === 'sealing' ? 'SEALING' : 'SEALED_OK';
  }
  if (event.type === 'RUN_SEALED_PARTIAL') return 'SEALED_PARTIAL';
  return current;
}

export function applyTimelineEvent(
  current: TimelineLiveState,
  event: TimelineEvent,
): TimelineLiveState {
  if (current.events.some((item) => item.id === event.id)) return current;
  const items =
    event.itemIdx === null || event.attempts === undefined
      ? current.items
      : current.items.map((item) =>
          item.idx === event.itemIdx
            ? { ...item, attempts: event.attempts ?? item.attempts }
            : item,
        );
  const runStatus = runStatusAfterEvent(current.runStatus, event);
  return { events: [...current.events, event], items, runStatus };
}

export function Timeline({ runId, initial, live: providedLive }: TimelineProps) {
  const internalLive = useTimelineLive(runId, initial, providedLive === undefined);
  const live = providedLive ?? internalLive;
  const [selected, setSelected] = useState<number | null>(null);

  const activeItem = useMemo(
    () => (selected === null ? null : (live.items.find((item) => item.idx === selected) ?? null)),
    [live.items, selected],
  );

  return (
    <section aria-labelledby="timeline-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#D9D9D3] pb-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7A7A7A]">
            Primary release narrative
          </p>
          <h2
            id="timeline-heading"
            className="font-convoy-display mt-2 text-3xl text-[#1A1816] sm:text-4xl"
          >
            Execution timeline
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#7A7A7A]">
            Read top to bottom. Every action shows why it exists, what must land first, and the
            evidence Convoy recorded.
          </p>
        </div>
        <span className={`border px-2 py-1 text-xs font-semibold ${chipClass(live.runStatus)}`}>
          {humanize(live.runStatus)}
        </span>
      </div>

      <div className="space-y-3" role="list" aria-label="Run items">
        {live.items.map((item) => {
          const state = deriveItemState(item, live.events);
          const itemEvents = live.events.filter((event) => event.itemIdx === item.idx);
          const retries = itemEvents.filter((event) => event.type === 'ITEM_RETRY');
          const gas = itemEvents.find((event) => event.type === 'ITEM_LANDED')?.payload[
            'gasUsdcConsumed'
          ];
          const veto = itemEvents.find((event) => event.type === 'ITEM_VETOED');
          const failure = itemEvents.find((event) => event.type === 'ITEM_FAILED');
          const dependencies = item.dependsOn.map((dependencyIdx) => {
            const dependency = live.items.find((candidate) => candidate.idx === dependencyIdx);
            return dependency === undefined
              ? `#${dependencyIdx}`
              : `#${dependencyIdx} ${humanize(dependency.functionName)}`;
          });
          const rationale = item.plannerRationale ?? item.evidence;
          return (
            <button
              key={item.idx}
              type="button"
              role="listitem"
              onClick={() => setSelected(item.idx)}
              aria-label={`Open audit for action ${item.idx}, ${item.functionName}`}
              className={`group block w-full border text-left transition hover:border-[#9B9992] focus-visible:border-[#007D4D] ${
                state === 'VETOED' ? 'border-[#D8D8D2] bg-[#F1F1ED]' : 'border-[#E2E2DC] bg-white'
              }`}
            >
              <div className="grid sm:grid-cols-[76px_minmax(0,1fr)]">
                <div className="flex items-center justify-between border-b border-[#E5E5E0] px-4 py-3 sm:flex-col sm:items-start sm:justify-start sm:border-b-0 sm:border-r sm:px-5 sm:py-5">
                  <span className="font-convoy-display text-3xl leading-none text-[#1A1816]">
                    {String(item.idx + 1).padStart(2, '0')}
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8A847C] sm:mt-3">
                    Action
                  </span>
                </div>

                <div className="min-w-0 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-convoy-display text-2xl leading-tight text-[#1A1816] sm:text-[1.7rem]">
                        {humanize(item.functionName)}
                      </h3>
                      <p className="mt-1 break-all font-mono text-[10px] text-[#8A847C]">
                        {item.functionName}({formatArguments(item.functionArgs)}) ·{' '}
                        {shortAddress(item.targetAddress)}
                      </p>
                    </div>
                    <div className="text-right">
                      <span
                        className={`border px-2 py-1 text-xs font-semibold ${chipClass(state)}`}
                      >
                        {state}
                      </span>
                      <p className="mt-2 text-[11px] text-[#7A7A7A]">{stateExplanation(state)}</p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 border-y border-[#ECECE7] py-4 lg:grid-cols-[1.35fr_0.8fr_0.65fr]">
                    <div>
                      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8A847C]">
                        Why this action
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[#4F4B47]">{rationale}</p>
                    </div>
                    <div>
                      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8A847C]">
                        Dependency gate
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[#4F4B47]">
                        {dependencies.length === 0
                          ? 'No prerequisites'
                          : `After ${dependencies.join(', ')}`}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8A847C]">
                        Gas record
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[#4F4B47]">
                        {typeof gas === 'string'
                          ? `${gas} USDC consumed`
                          : state === 'VETOED'
                            ? '0 gas'
                            : item.gasBudgetUsdc === null
                              ? 'Run budget'
                              : `${item.gasBudgetUsdc} USDC allocation`}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wide text-[#AAA49D]">
                      {FLOW.map((phase) => (
                        <span
                          key={phase}
                          className={`border-l border-[#D9D9D3] pl-2 first:border-0 first:pl-0 ${
                            phase === state ? 'font-semibold text-[#1A1816]' : ''
                          }`}
                        >
                          {phase}
                        </span>
                      ))}
                      {retries.map((retry, index) => (
                        <span
                          key={retry.id}
                          className="border border-amber-200 bg-amber-50 px-1 text-amber-800"
                        >
                          retry {index + 1}
                          {eventDetail(retry) ? ` ${eventDetail(retry)}` : ''}
                        </span>
                      ))}
                      {state === 'VETOED' ? (
                        <span className="border border-zinc-300 bg-zinc-100 px-1 text-zinc-500">
                          0 gas
                          {typeof veto?.payload['revert'] === 'string'
                            ? ` · ${veto.payload['revert']}`
                            : ''}
                        </span>
                      ) : null}
                      {state === 'FAILED' ? (
                        <span className="border border-red-200 bg-red-50 px-1 text-red-800">
                          {eventDetail(
                            failure ?? {
                              id: '',
                              runId,
                              itemIdx: item.idx,
                              type: 'ITEM_FAILED',
                              payload: {},
                              at: '',
                            },
                          ) ?? 'failed'}
                        </span>
                      ) : null}
                      {typeof gas === 'string' ? (
                        <span className="border border-emerald-200 bg-emerald-50 px-1 text-emerald-800">
                          {gas} USDC gas
                        </span>
                      ) : null}
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#007D4D] group-hover:underline">
                      Open evidence →
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {activeItem !== null ? (
        <AuditDrawer item={activeItem} events={live.events} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
