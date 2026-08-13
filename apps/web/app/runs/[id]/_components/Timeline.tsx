'use client';

import React, { useEffect, useMemo, useState } from 'react';

import type { TimelineEvent, TimelineItem, TimelineSnapshot } from '@/lib/events';

import { AuditDrawer } from './AuditDrawer';
import { humanize, recordedText, StateChip, StateGlyph } from './RunBoardPrimitives';

const FLOW = ['PLANNED', 'SIMULATED', 'COMMITTED', 'SUBMITTED', 'LANDED'] as const;
type FlowPhase = (typeof FLOW)[number];
type PhaseProgress = 'reached' | 'current' | 'unreached';
const TERMINAL_RUNS = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);

const PHASE_EVENTS: Readonly<Record<FlowPhase, readonly string[]>> = {
  PLANNED: [
    'PLAN_READY',
    'ITEM_DEFERRED',
    'ITEM_SIMULATED',
    'ITEM_VETOED',
    'ITEM_COMMITTED',
    'ITEM_SUBMITTED',
    'ITEM_RETRY',
    'ITEM_LANDED',
  ],
  SIMULATED: [
    'ITEM_SIMULATED',
    'ITEM_VETOED',
    'ITEM_COMMITTED',
    'ITEM_SUBMITTED',
    'ITEM_RETRY',
    'ITEM_LANDED',
  ],
  COMMITTED: ['ITEM_COMMITTED', 'ITEM_SUBMITTED', 'ITEM_RETRY', 'ITEM_LANDED'],
  SUBMITTED: ['ITEM_SUBMITTED', 'ITEM_RETRY', 'ITEM_LANDED'],
  LANDED: ['ITEM_LANDED'],
};

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
  const byId = a.id.localeCompare(b.id);
  return byId !== 0 ? byId : a.at.localeCompare(b.at);
}

function phaseProgress(
  phase: FlowPhase,
  state: string,
  itemEvents: readonly TimelineEvent[],
): PhaseProgress {
  if (phase === state) return 'current';
  if (phase === 'PLANNED') return 'reached';

  const currentIndex = FLOW.findIndex((candidate) => candidate === state);
  const phaseIndex = FLOW.indexOf(phase);
  const reachedByState = currentIndex >= phaseIndex && currentIndex !== -1;
  const reachedByEvent = itemEvents.some((event) => PHASE_EVENTS[phase].includes(event.type));
  const reachedByVeto = state === 'VETOED' && phase === 'SIMULATED';
  return reachedByState || reachedByEvent || reachedByVeto ? 'reached' : 'unreached';
}

/** Derive the visible state by replaying ledger transitions in sequence order. */
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

function eventDetail(event: TimelineEvent | undefined): string | null {
  if (event === undefined) return null;
  const payload = event.payload;
  for (const key of ['detail', 'reason', 'revert', 'code', 'status']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function vetoDetail(event: TimelineEvent | undefined): string | null {
  if (event === undefined) return null;
  for (const key of ['revert', 'detail', 'reason', 'code']) {
    const value = event.payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function formatArguments(value: unknown): string {
  if (value === null || value === undefined) return 'unavailable';
  try {
    const formatted = JSON.stringify(value);
    if (formatted === undefined) return 'unavailable';
    return formatted.length > 82 ? `${formatted.slice(0, 79)}…` : formatted;
  } catch {
    return 'unavailable';
  }
}

function stateExplanation(
  state: string,
  itemEvents: readonly TimelineEvent[],
  runStatus: string,
): string {
  if (state === 'LANDED') return 'Landed on Base Sepolia';
  if (state === 'VETOED') return 'Stopped before execution';
  if (state === 'FAILED') return 'Stopped with recorded evidence';
  if (state === 'SKIPPED') {
    return (
      eventDetail(itemEvents.find((event) => event.type === 'ITEM_FAILED')) ??
      'No target write was recorded'
    );
  }
  if (state === 'RETRYING') return 'A real transient condition was observed';
  if (state === 'DEFERRED') {
    if (runStatus === 'ABORTED') return 'Prerequisite did not land before the run was aborted';
    if (runStatus === 'FAILED_FATAL') return 'Prerequisite did not land before processing stopped';
    if (TERMINAL_RUNS.has(runStatus)) return 'Prerequisite did not land before the run sealed';
    return 'Waiting for prerequisite actions';
  }
  if (state === 'SIMULATED') {
    const simulation = itemEvents.find((event) => event.type === 'ITEM_SIMULATED');
    if (simulation?.payload['gateBypassed'] === true) {
      return 'Simulation and Critic were bypassed in the recorded ablation';
    }
    if (simulation?.payload['criticConsulted'] === true) {
      return 'Simulation passed; the Critic approved the action';
    }
    return 'Simulation passed; approval evidence was recorded';
  }
  if (state === 'COMMITTED') return 'Committed in ConvoyRegistry';
  if (state === 'SUBMITTED') return 'Submitted through KeeperHub';
  return 'Ready for safety review';
}

function explicitZeroGas(event: TimelineEvent | undefined): boolean {
  if (event === undefined) return false;
  return ['gasSpent', 'gasUsdcConsumed', 'gasUsedUsdc', 'gasUsedWei'].some((key) => {
    const value = event.payload[key];
    return value === 0 || value === '0' || value === '0.0' || value === '0.000000';
  });
}

function gasRecord(
  item: TimelineItem,
  state: string,
  itemEvents: readonly TimelineEvent[],
): string {
  const landed = itemEvents.find((event) => event.type === 'ITEM_LANDED');
  const consumed = landed?.payload['gasUsdcConsumed'];
  if (consumed !== null && consumed !== undefined && consumed !== '') {
    return `${String(consumed)} USDC consumed`;
  }
  const veto = itemEvents.find((event) => event.type === 'ITEM_VETOED');
  if (state === 'VETOED' && explicitZeroGas(veto)) return '0 gas recorded';
  if (item.gasBudgetUsdc !== null) return `${item.gasBudgetUsdc} USDC allocation`;
  return 'not recorded';
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
        // The append-only replay remains the recovery path for malformed frames.
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

function streamDetail(event: TimelineEvent): string {
  return (
    eventDetail(event) ??
    (event.itemIdx === null ? 'run-level ledger transition' : 'item transition')
  );
}

export function Timeline({ runId, initial, live: providedLive }: TimelineProps) {
  const internalLive = useTimelineLive(runId, initial, providedLive === undefined);
  const live = providedLive ?? internalLive;
  const [selected, setSelected] = useState<number | null>(null);
  const terminal = TERMINAL_RUNS.has(live.runStatus);

  const activeItem = useMemo(() => {
    if (selected === null) return null;
    const item = live.items.find((candidate) => candidate.idx === selected);
    return item === undefined ? null : { ...item, state: deriveItemState(item, live.events) };
  }, [live.events, live.items, selected]);
  const orderedEvents = useMemo(() => [...live.events].sort(compareEventIds), [live.events]);

  return (
    <section aria-labelledby="timeline-heading" className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--convoy-rule)] pb-5">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
            Primary release narrative
          </p>
          <h2
            id="timeline-heading"
            className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)] sm:text-4xl"
          >
            Execution timeline
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--convoy-text-body)]">
            Decision → dependency release → execution → receipt → final state. Open any action for
            the full evidence case file.
          </p>
        </div>
        <StateChip state={live.runStatus} />
      </div>

      <ul className="space-y-3" aria-label="Run items">
        {live.items.map((item) => {
          const state = deriveItemState(item, live.events);
          const itemEvents = live.events
            .filter((event) => event.itemIdx === item.idx)
            .sort(compareEventIds);
          const retries = itemEvents.filter((event) => event.type === 'ITEM_RETRY');
          const failure = itemEvents.find((event) => event.type === 'ITEM_FAILED');
          const veto = itemEvents.find((event) => event.type === 'ITEM_VETOED');
          const rationale = item.plannerRationale;
          const dependencies = item.dependsOn.map((dependencyIdx) => {
            const dependency = live.items.find((candidate) => candidate.idx === dependencyIdx);
            return dependency === undefined
              ? `#${dependencyIdx + 1}`
              : `#${dependencyIdx + 1} ${humanize(dependency.functionName)}`;
          });
          const vetoZero = state === 'VETOED' && explicitZeroGas(veto);
          const recordedVetoDetail = vetoDetail(veto);
          return (
            <li key={item.idx} role="listitem">
              <button
                type="button"
                onClick={() => setSelected(item.idx)}
                aria-label={`Open audit for action ${item.idx + 1}, ${item.functionName}`}
                className={`group convoy-state-tint block min-h-11 w-full border text-left transition hover:border-[var(--convoy-border-hover)] focus-visible:border-[var(--convoy-green-dark)] ${
                  state === 'VETOED'
                    ? 'convoy-veto-hatch border-[var(--state-vetoed-border)] bg-[var(--state-vetoed-bg)]'
                    : 'border-[var(--convoy-border-row)] bg-white'
                }`}
              >
                <div className="grid sm:grid-cols-[76px_minmax(0,1fr)]">
                  <div className="flex items-center justify-between border-b border-[var(--convoy-border)] px-4 py-3 sm:flex-col sm:items-start sm:justify-start sm:border-b-0 sm:border-r sm:px-5 sm:py-5">
                    <span className="convoy-numeric font-convoy-display text-3xl leading-none text-[var(--convoy-ink-soft)]">
                      {String(item.idx + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)] sm:mt-3">
                      Action
                    </span>
                  </div>

                  <div className="min-w-0 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-convoy-display text-2xl leading-tight text-[var(--convoy-ink-soft)] sm:text-[1.7rem]">
                          {humanize(item.functionName)}
                        </h3>
                        <p className="convoy-proof-value mt-1 font-mono text-[10px] text-[var(--text-label)]">
                          {item.functionName}({formatArguments(item.functionArgs)}) ·{' '}
                          {shortAddress(item.targetAddress)}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right">
                        <StateChip state={state} />
                        <p className="max-w-[18rem] text-[11px] text-[var(--text-subtle)]">
                          {stateExplanation(state, itemEvents, live.runStatus)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 grid gap-4 border-y border-[var(--convoy-hairline)] py-4 lg:grid-cols-[1.35fr_0.8fr_0.65fr]">
                      <div>
                        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)]">
                          Why this action
                        </p>
                        <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-strong)]">
                          {recordedText(rationale)}
                        </p>
                      </div>
                      <div>
                        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)]">
                          Dependency gate
                        </p>
                        <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-strong)]">
                          {dependencies.length === 0
                            ? 'No prerequisites'
                            : `After ${dependencies.join(', ')}`}
                        </p>
                      </div>
                      <div>
                        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)]">
                          Gas record
                        </p>
                        <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-strong)]">
                          {gasRecord(item, state, itemEvents)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                        {FLOW.map((phase) => {
                          const progress = phaseProgress(phase, state, itemEvents);
                          return (
                            <span
                              key={phase}
                              aria-label={`${phase}: ${progress}`}
                              className={`flex items-center gap-1 border-l border-[var(--convoy-rule)] pl-2 first:border-0 first:pl-0 ${
                                progress === 'current'
                                  ? 'font-semibold text-[var(--convoy-ink-soft)]'
                                  : 'text-[var(--text-label)]'
                              }`}
                              data-phase={phase}
                              data-phase-state={progress}
                            >
                              <StateGlyph
                                state={progress === 'unreached' ? 'PENDING' : phase}
                                size={10}
                              />
                              {phase}
                            </span>
                          );
                        })}
                        {state === 'VETOED' || state === 'DEFERRED' ? (
                          <span
                            className={`flex items-center gap-1 border px-1 ${
                              state === 'VETOED'
                                ? 'border-[var(--state-vetoed-border)] bg-[var(--state-vetoed-bg)] text-[var(--state-vetoed-fg)]'
                                : 'border-[var(--state-deferred-border)] bg-[var(--state-deferred-bg)] text-[var(--state-deferred-fg)]'
                            }`}
                            data-current-item-state={state}
                          >
                            <StateGlyph state={state} size={10} />
                            {state === 'VETOED' || terminal ? 'stopped' : 'current'} · {state}
                          </span>
                        ) : null}
                        {retries.map((retry) => {
                          const retryCount = retry.payload['retryCount'];
                          return (
                            <span
                              key={retry.id}
                              className="border border-[var(--state-retrying-border)] bg-[var(--state-retrying-bg)] px-1 text-[var(--state-retrying-fg)]"
                            >
                              retry observed
                              {retryCount === undefined || retryCount === null
                                ? ''
                                : ` · provider count ${String(retryCount)}`}
                              {eventDetail(retry) ? ` · ${eventDetail(retry)}` : ''}
                            </span>
                          );
                        })}
                        {state === 'VETOED' && (vetoZero || recordedVetoDetail !== null) ? (
                          <span className="border border-[var(--state-vetoed-border)] bg-[var(--state-vetoed-bg)] px-1 text-[var(--state-vetoed-fg)]">
                            {vetoZero ? '0 gas recorded' : null}
                            {vetoZero && recordedVetoDetail !== null ? ' · ' : null}
                            {recordedVetoDetail}
                          </span>
                        ) : null}
                        {state === 'FAILED' ? (
                          <span className="border border-[var(--state-failed-border)] bg-[var(--state-failed-bg)] px-1 text-[var(--state-failed-fg)]">
                            {eventDetail(failure) ?? 'failed'}
                          </span>
                        ) : null}
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--convoy-green-dark)] group-hover:underline">
                        Open evidence →
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="event-stream-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
              Ledger stream
            </p>
            <h3
              id="event-stream-heading"
              className="font-convoy-display mt-2 text-2xl text-[var(--convoy-ink-soft)] sm:text-3xl"
            >
              Every event, in append order
            </h3>
          </div>
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            {orderedEvents.length} event{orderedEvents.length === 1 ? '' : 's'} · replayable ledger
          </p>
        </div>
        <div className="max-h-[28rem] overflow-y-auto border border-[var(--convoy-dark)] bg-[var(--convoy-dark)] p-2">
          {orderedEvents.length === 0 ? (
            <p className="p-4 text-sm text-[var(--convoy-on-dark-body)]">No events recorded.</p>
          ) : (
            <ol className="space-y-px">
              {orderedEvents.map((event, index) => (
                <li
                  key={event.id}
                  className={`grid gap-2 border-b border-white/10 px-3 py-3 last:border-0 sm:grid-cols-[90px_170px_minmax(0,1fr)] ${
                    index === orderedEvents.length - 1 ? 'convoy-append' : ''
                  }`}
                >
                  <span className="font-mono text-[10px] text-[var(--convoy-on-dark-green)]">
                    #{event.id}
                  </span>
                  <time
                    className="font-mono text-[10px] text-[var(--convoy-on-dark-muted)]"
                    dateTime={event.at}
                  >
                    {event.at}
                  </time>
                  <span className="min-w-0 text-xs text-[var(--convoy-on-dark-code)]">
                    <strong className="font-mono text-[10px] uppercase tracking-[0.08em] text-white">
                      {event.type}
                    </strong>{' '}
                    <span className="text-[var(--convoy-on-dark-body)]">{streamDetail(event)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      {activeItem !== null ? (
        <AuditDrawer item={activeItem} events={live.events} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
