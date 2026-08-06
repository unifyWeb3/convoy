'use client';

import React, { useEffect, useMemo, useState } from 'react';

import { AuditDrawer } from './AuditDrawer';
import type { TimelineEvent, TimelineItem, TimelineSnapshot } from '@/lib/events';

const FLOW = ['PLANNED', 'SIMULATED', 'COMMITTED', 'SUBMITTED', 'LANDED'] as const;

function chipClass(state: string): string {
  if (state === 'LANDED') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (state === 'VETOED') return 'border-zinc-300 bg-zinc-100 text-zinc-500';
  if (state === 'FAILED') return 'border-red-200 bg-red-50 text-red-800';
  if (state === 'RETRYING') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-sky-200 bg-sky-50 text-sky-800';
}

function itemState(item: TimelineItem, events: readonly TimelineEvent[]): string {
  const itemEvents = events.filter((event) => event.itemIdx === item.idx);
  const terminal = [...itemEvents]
    .reverse()
    .find((event) =>
      ['ITEM_LANDED', 'ITEM_VETOED', 'ITEM_FAILED', 'ITEM_RETRY'].includes(event.type),
    );
  if (terminal?.type === 'ITEM_LANDED') return 'LANDED';
  if (terminal?.type === 'ITEM_VETOED') return 'VETOED';
  if (terminal?.type === 'ITEM_FAILED') return 'FAILED';
  if (terminal?.type === 'ITEM_RETRY') return 'RETRYING';
  const phases = itemEvents.map((event) => event.type);
  if (phases.includes('ITEM_SUBMITTED')) return 'SUBMITTED';
  if (phases.includes('ITEM_COMMITTED')) return 'COMMITTED';
  if (phases.includes('ITEM_SIMULATED')) return 'SIMULATED';
  if (phases.includes('ITEM_DEFERRED')) return 'DEFERRED';
  return item.state === 'PENDING' ? 'PLANNED' : item.state;
}

function eventDetail(event: TimelineEvent): string | null {
  const payload = event.payload;
  for (const key of ['detail', 'reason', 'revert', 'code', 'status']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export interface TimelineProps {
  readonly runId: string;
  readonly initial: TimelineSnapshot;
}

export function Timeline({ runId, initial }: TimelineProps) {
  const [events, setEvents] = useState<readonly TimelineEvent[]>(initial.events);
  const [selected, setSelected] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState(initial.run.status);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const handleMessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as TimelineEvent;
        setEvents((current) =>
          current.some((item) => item.id === event.id) ? current : [...current, event],
        );
        if (event.type === 'RUN_SEALED') setRunStatus('SEALED_OK');
        if (event.type === 'RUN_SEALED_PARTIAL') setRunStatus('SEALED_PARTIAL');
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
  }, [runId]);

  const activeItem = useMemo(
    () =>
      selected === null ? null : (initial.items.find((item) => item.idx === selected) ?? null),
    [initial.items, selected],
  );

  return (
    <section aria-labelledby="timeline-heading" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 pb-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Run {runId}</p>
          <h1 id="timeline-heading" className="text-2xl font-semibold text-zinc-950">
            Execution timeline
          </h1>
        </div>
        <span className={`border px-2 py-1 text-xs font-semibold ${chipClass(runStatus)}`}>
          {runStatus}
        </span>
      </div>

      <div className="space-y-2" role="list" aria-label="Run items">
        {initial.items.map((item) => {
          const state = itemState(item, events);
          const itemEvents = events.filter((event) => event.itemIdx === item.idx);
          const retries = itemEvents.filter((event) => event.type === 'ITEM_RETRY');
          const gas = itemEvents.find((event) => event.type === 'ITEM_LANDED')?.payload[
            'gasUsdcConsumed'
          ];
          const veto = itemEvents.find((event) => event.type === 'ITEM_VETOED');
          const failure = itemEvents.find((event) => event.type === 'ITEM_FAILED');
          return (
            <button
              key={item.idx}
              type="button"
              role="listitem"
              onClick={() => setSelected(item.idx)}
              className={`block w-full border px-4 py-3 text-left transition hover:border-zinc-500 ${state === 'VETOED' ? 'bg-zinc-50' : 'bg-white'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm text-zinc-950">
                  #{item.idx} {item.functionName}
                </span>
                <span className={`border px-2 py-1 text-xs font-semibold ${chipClass(state)}`}>
                  {state}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] uppercase tracking-wide text-zinc-400">
                {FLOW.map((phase) => (
                  <span
                    key={phase}
                    className={phase === state ? 'font-semibold text-zinc-800' : ''}
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
            </button>
          );
        })}
      </div>

      {activeItem !== null ? (
        <AuditDrawer item={activeItem} events={events} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}
