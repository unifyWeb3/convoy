'use client';

import React, { useMemo, useState } from 'react';

import type { TimelineItem, TimelineSnapshot } from '@/lib/events';

import { DagView } from './DagView';
import { Manifest } from './Manifest';
import { deriveItemState, Timeline, useTimelineLive } from './Timeline';

type RunTab = 'timeline' | 'dag' | 'manifest';
type StageState = 'complete' | 'active' | 'waiting' | 'issue';

interface StageSummary {
  readonly number: string;
  readonly name: string;
  readonly verb: string;
  readonly detail: string;
  readonly metric: string;
  readonly state: StageState;
}

const TERMINAL_RUNS = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);
const RESOLVED_ITEMS = new Set(['LANDED', 'VETOED', 'FAILED', 'SKIPPED']);

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function shortRunId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 8)}…${runId.slice(-6)}` : runId;
}

function formatUsdc(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function runTone(status: string): string {
  if (status === 'SEALED_OK') return 'border-[#00C274]/40 bg-[#00C274]/10 text-[#87f1c1]';
  if (status === 'SEALED_PARTIAL' || status === 'FAILED_FATAL' || status === 'ABORTED') {
    return 'border-[#E53935]/40 bg-[#E53935]/10 text-[#ff9d9b]';
  }
  return 'border-white/20 bg-white/5 text-white';
}

function stageTone(state: StageState): string {
  if (state === 'complete') return 'border-[#00C274] bg-white';
  if (state === 'active') return 'border-[#007D4D] bg-[#EAF8F1]';
  if (state === 'issue') return 'border-[#E53935] bg-[#FFF5F4]';
  return 'border-[#E5E5E0] bg-white';
}

function stageLabel(state: StageState): string {
  if (state === 'complete') return 'Complete';
  if (state === 'active') return 'In progress';
  if (state === 'issue') return 'Needs review';
  return 'Waiting';
}

function currentItem(
  items: readonly TimelineItem[],
  states: ReadonlyMap<number, string>,
): TimelineItem | null {
  const priority = ['RETRYING', 'SUBMITTED', 'COMMITTED', 'SIMULATED', 'PLANNED', 'DEFERRED'];
  for (const state of priority) {
    const item = items.find((candidate) => states.get(candidate.idx) === state);
    if (item !== undefined) return item;
  }
  return null;
}

function nowMessage(
  status: string,
  items: readonly TimelineItem[],
  states: ReadonlyMap<number, string>,
): string {
  if (status === 'RECEIVED') return 'Batch received. No onchain write has been submitted yet.';
  if (status === 'OPENING') {
    return 'Opening the run record through KeeperHub direct execution on Base Sepolia.';
  }
  if (status === 'PLANNING') {
    return 'The Planner is ordering the supplied actions and assigning their gas allocations.';
  }
  if (status === 'CRITIQUING') {
    return 'Each action is being simulated and checked against its supporting evidence.';
  }
  if (status === 'EXECUTING') {
    const active = currentItem(items, states);
    if (active !== null && states.get(active.idx) === 'DEFERRED') {
      return `The gate is holding #${active.idx} ${humanize(active.functionName).toLowerCase()} until every prerequisite lands.`;
    }
    if (active !== null) {
      return `KeeperHub is advancing #${active.idx} ${humanize(active.functionName).toLowerCase()} through the execution ledger.`;
    }
    return 'Every action is resolved. Convoy is preparing the onchain seal and proof package.';
  }
  if (status === 'SEALING') {
    return 'Action writes are finished. Convoy is sealing the registry record before export.';
  }
  if (status === 'SEALED_OK') {
    return 'Run sealed. Every surviving action is resolved and the proof manifest is ready.';
  }
  if (status === 'SEALED_PARTIAL') {
    return 'Run sealed with exceptions. The manifest records exactly what landed and what did not.';
  }
  if (status === 'ABORTED')
    return 'Run aborted. Its append-only ledger remains available for audit.';
  return 'The run stopped before a complete seal. The ledger preserves the failure evidence.';
}

function ConvoyMark() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-9 w-9 shrink-0 items-center justify-center bg-[#2B2825]"
    >
      <span className="absolute left-[9px] top-[9px] h-2 w-2 bg-[#00C274]" />
      <span className="absolute left-[9px] top-[17px] h-px w-5 bg-white" />
      <span className="absolute bottom-[8px] right-[8px] h-2 w-2 bg-[#00C274]" />
    </span>
  );
}

export function RunDetail({ runId, snapshot }: { runId: string; snapshot: TimelineSnapshot }) {
  const [tab, setTab] = useState<RunTab>('timeline');
  const live = useTimelineLive(runId, snapshot);

  const overview = useMemo(() => {
    const states = new Map(
      live.items.map((item) => [item.idx, deriveItemState(item, live.events)] as const),
    );
    const stateCount = (state: string): number =>
      [...states.values()].filter((value) => value === state).length;
    const terminal = TERMINAL_RUNS.has(live.runStatus);
    const hasPlan =
      snapshot.run.plan !== null ||
      live.events.some((event) => event.itemIdx === null && event.type === 'PLAN_READY');
    const critiqueSummary = live.events.find(
      (event) =>
        event.itemIdx === null &&
        event.type === 'PLAN_READY' &&
        Array.isArray(event.payload['ready']),
    );
    const critiqueComplete =
      critiqueSummary !== undefined ||
      ['EXECUTING', 'SEALING', 'SEALED_OK', 'SEALED_PARTIAL', 'ABORTED'].includes(live.runStatus);
    const dependencyItems = live.items.filter((item) => item.dependsOn.length > 0);
    const gateComplete =
      critiqueComplete &&
      (dependencyItems.length === 0 ||
        dependencyItems.every((item) => RESOLVED_ITEMS.has(states.get(item.idx) ?? item.state)));
    const executionComplete = ['SEALING', 'SEALED_OK', 'SEALED_PARTIAL', 'ABORTED'].includes(
      live.runStatus,
    );
    const issue = ['SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL'].includes(live.runStatus);

    const stages: readonly StageSummary[] = [
      {
        number: '01',
        name: 'Plan',
        verb: 'Order the batch',
        detail: 'Orders only the actions supplied to this run and preserves declared dependencies.',
        metric: `${live.items.length} action${live.items.length === 1 ? '' : 's'}`,
        state: hasPlan
          ? 'complete'
          : ['RECEIVED', 'OPENING', 'PLANNING'].includes(live.runStatus)
            ? 'active'
            : 'waiting',
      },
      {
        number: '02',
        name: 'Critique',
        verb: 'Challenge every action',
        detail: 'Simulates first, then checks whether the evidence actually justifies the write.',
        metric: `${stateCount('VETOED')} vetoed at zero gas`,
        state: critiqueComplete
          ? 'complete'
          : live.runStatus === 'CRITIQUING'
            ? 'active'
            : 'waiting',
      },
      {
        number: '03',
        name: 'Gate',
        verb: 'Enforce prerequisites',
        detail: 'Waits for every dependency, then checks a registry commitment before the target.',
        metric: `${dependencyItems.length} dependency-bound`,
        state: gateComplete
          ? 'complete'
          : live.runStatus === 'EXECUTING' && dependencyItems.length > 0
            ? 'active'
            : 'waiting',
      },
      {
        number: '04',
        name: 'Execute',
        verb: 'Submit approved writes',
        detail: 'KeeperHub sends direct execution REST calls and manages the onchain nonce.',
        metric: `${stateCount('LANDED')} of ${live.items.length} landed`,
        state: executionComplete
          ? issue
            ? 'issue'
            : 'complete'
          : live.runStatus === 'EXECUTING'
            ? 'active'
            : 'waiting',
      },
      {
        number: '05',
        name: 'Prove',
        verb: 'Reconcile the record',
        detail: 'Exports KeeperHub status, registry events, and the append-only ledger as JSON.',
        metric: terminal ? 'Manifest available' : 'Available after sealing',
        state: terminal
          ? issue
            ? 'issue'
            : 'complete'
          : live.runStatus === 'SEALING'
            ? 'active'
            : 'waiting',
      },
    ];

    const eventGas = live.events.reduce((sum, event) => {
      if (event.type !== 'ITEM_LANDED') return sum;
      const value = event.payload['gasUsdcConsumed'];
      const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : 0;
      return Number.isFinite(parsed) ? sum + parsed : sum;
    }, 0);
    const snapshotGas = Number(snapshot.run.spentGasUsdc);
    const budget = Number(snapshot.run.budgetUsdc);
    const spentPay = Number(snapshot.run.spentPayUsdc);
    const consumed = Math.max(Number.isFinite(snapshotGas) ? snapshotGas : 0, eventGas);
    const used = consumed + (Number.isFinite(spentPay) ? spentPay : 0);

    return {
      stages,
      states,
      terminal,
      issue,
      landed: stateCount('LANDED'),
      vetoed: stateCount('VETOED'),
      failed: stateCount('FAILED') + stateCount('SKIPPED'),
      deferred: stateCount('DEFERRED'),
      budget,
      used,
      budgetPercent: budget > 0 ? Math.min(100, Math.max(0, (used / budget) * 100)) : 0,
      now: currentItem(live.items, states),
    };
  }, [live.events, live.items, live.runStatus, snapshot.run]);

  return (
    <div className="min-h-screen bg-[#F7F7F2]">
      <header className="border-b border-[#E5E5E0] bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-10">
          <div className="flex items-center gap-3">
            <ConvoyMark />
            <div>
              <p className="font-convoy-display text-2xl leading-none text-[#111111]">Convoy</p>
              <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[#7A7A7A]">
                Onchain release control
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="border border-[#E5E5E0] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5E5A55]">
              SSE ledger feed
            </span>
            <span className="border border-[#E5E5E0] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5E5A55]">
              KeeperHub direct REST
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
        <section className="grid gap-7 border-b border-[#D9D9D3] pb-9 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)] lg:items-end lg:gap-14 lg:pb-12">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#007D4D]">
              Autonomous onchain release operator
            </p>
            <h1 className="font-convoy-display mt-4 max-w-4xl text-[clamp(2.7rem,6vw,5.8rem)] leading-[0.94] text-[#111111]">
              From release intent to onchain proof.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#68645F] sm:text-lg">
              Convoy turns an evidence-backed batch into ordered, critiqued, dependency-gated writes
              through KeeperHub—and leaves a replayable proof trail.
            </p>
          </div>

          <aside className="bg-[#2B2825] p-5 text-white sm:p-6" aria-labelledby="now-heading">
            <div className="flex items-center justify-between gap-4">
              <p
                id="now-heading"
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#B9B3AC]"
              >
                What is happening now
              </p>
              <span
                className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${runTone(live.runStatus)}`}
              >
                {humanize(live.runStatus)}
              </span>
            </div>
            <p className="font-convoy-display mt-8 text-2xl leading-tight text-white sm:text-3xl">
              {live.runStatus === 'EXECUTING' && overview.now !== null
                ? `Action ${overview.now.idx + 1} of ${live.items.length}`
                : live.runStatus === 'RECEIVED'
                  ? 'Batch received'
                  : humanize(live.runStatus)}
            </p>
            <p className="mt-3 text-sm leading-6 text-[#D5D0CA]">
              {nowMessage(live.runStatus, live.items, overview.states)}
            </p>
            <div className="mt-7 flex items-center gap-2 border-t border-white/15 pt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-[#B9B3AC]">
              <span
                className={`h-2 w-2 ${overview.terminal ? 'bg-[#B9B3AC]' : 'animate-pulse bg-[#00C274]'}`}
              />
              {overview.terminal ? 'Append-only replay complete' : 'Live events over SSE'}
            </div>
          </aside>
        </section>

        <section aria-labelledby="pipeline-heading" className="py-9 lg:py-12">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7A7A7A]">
                Release method
              </p>
              <h2
                id="pipeline-heading"
                className="font-convoy-display mt-2 text-3xl text-[#1A1816] sm:text-4xl"
              >
                Plan → Critique → Gate → Execute → Prove
              </h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-[#7A7A7A]">
              Each stage narrows uncertainty before the next onchain write is allowed.
            </p>
          </div>

          <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {overview.stages.map((stage) => (
              <li
                key={stage.name}
                className={`relative border-t-2 p-4 sm:min-h-[220px] ${stageTone(stage.state)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="font-mono text-[10px] text-[#8A847C]">{stage.number}</span>
                  <span
                    className={`font-mono text-[9px] uppercase tracking-[0.14em] ${
                      stage.state === 'complete'
                        ? 'text-[#007D4D]'
                        : stage.state === 'active'
                          ? 'text-[#007D4D]'
                          : stage.state === 'issue'
                            ? 'text-[#E53935]'
                            : 'text-[#8A847C]'
                    }`}
                  >
                    {stageLabel(stage.state)}
                  </span>
                </div>
                <h3 className="font-convoy-display mt-7 text-2xl text-[#1A1816]">{stage.name}</h3>
                <p className="mt-1 text-sm font-semibold text-[#1A1816]">{stage.verb}</p>
                <p className="mt-3 text-xs leading-5 text-[#7A7A7A]">{stage.detail}</p>
                <p className="mt-5 border-t border-[#E5E5E0] pt-3 font-mono text-[10px] uppercase tracking-wide text-[#5E5A55]">
                  {stage.metric}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid border border-[#DFDFD9] bg-white lg:grid-cols-[1.3fr_0.7fr]">
          <div className="p-5 sm:p-7 lg:border-r lg:border-[#E5E5E0]">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7A7A7A]">
              Active run
            </p>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-convoy-display text-3xl text-[#1A1816] sm:text-4xl">
                  Release {shortRunId(runId)}
                </h2>
                <p className="mt-2 break-all font-mono text-[10px] text-[#8A847C]">{runId}</p>
              </div>
              <span className="border border-[#CFCFC8] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#3F3B37]">
                Base Sepolia · 84532
              </span>
            </div>

            <dl className="mt-7 grid grid-cols-2 gap-px bg-[#E5E5E0] sm:grid-cols-4">
              {[
                ['Landed', String(overview.landed)],
                ['Vetoed', String(overview.vetoed)],
                ['Deferred', String(overview.deferred)],
                ['Failed / skipped', String(overview.failed)],
              ].map(([label, value]) => (
                <div key={label} className="bg-white px-3 py-4">
                  <dt className="font-mono text-[9px] uppercase tracking-[0.13em] text-[#8A847C]">
                    {label}
                  </dt>
                  <dd className="font-convoy-display mt-2 text-3xl text-[#1A1816]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="border-t border-[#E5E5E0] p-5 sm:p-7 lg:border-t-0">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.17em] text-[#7A7A7A]">
                  Policy budget used
                </p>
                <p className="font-convoy-display mt-2 text-3xl text-[#1A1816]">
                  {formatUsdc(overview.used)}
                  <span className="ml-2 font-sans text-xs tracking-normal text-[#7A7A7A]">
                    USDC
                  </span>
                </p>
              </div>
              <p className="font-mono text-[10px] text-[#7A7A7A]">
                of {formatUsdc(overview.budget)}
              </p>
            </div>
            <div
              className="mt-5 h-2 bg-[#ECECE7]"
              aria-label={`${overview.budgetPercent.toFixed(1)} percent of budget used`}
            >
              <div
                className={`h-full ${overview.budgetPercent >= 100 ? 'bg-[#E53935]' : 'bg-[#00C274]'}`}
                style={{ width: `${overview.budgetPercent}%` }}
              />
            </div>
            <p className="mt-4 text-xs leading-5 text-[#7A7A7A]">
              Real receipt-composed gas drains this run policy. Testnet USD is notional; wallet
              debit and sponsorship are recorded separately in the audit evidence.
            </p>
            <div className="mt-5 flex items-center justify-between border-t border-[#E5E5E0] pt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5E5A55]">
              <span>Deadline</span>
              <span>
                {snapshot.run.deadline === null
                  ? 'Not set'
                  : new Date(snapshot.run.deadline).toLocaleString('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
              </span>
            </div>
          </div>
        </section>

        <section className="mt-8 sm:mt-10" aria-label="Run board">
          <nav
            aria-label="Run views"
            className="flex gap-1 overflow-x-auto border-b border-[#D9D9D3]"
          >
            {(
              [
                ['timeline', 'Actions & timeline'],
                ['dag', 'Dependency DAG'],
                ['manifest', 'Proof manifest'],
              ] as const
            ).map(([view, label]) => (
              <button
                key={view}
                type="button"
                onClick={() => setTab(view)}
                aria-current={tab === view ? 'page' : undefined}
                className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors sm:px-5 ${
                  tab === view
                    ? 'border-[#007D4D] text-[#111111]'
                    : 'border-transparent text-[#7A7A7A] hover:text-[#111111]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="pt-7 sm:pt-9">
            {tab === 'timeline' ? <Timeline runId={runId} initial={snapshot} live={live} /> : null}
            {tab === 'dag' ? <DagView runId={runId} live={live} /> : null}
            {tab === 'manifest' ? <Manifest runId={runId} runStatus={live.runStatus} /> : null}
          </div>
        </section>
      </main>

      <footer className="border-t border-[#E5E5E0] bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-5 font-mono text-[9px] uppercase tracking-[0.13em] text-[#8A847C] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-10">
          <span>Convoy holds no private keys and sets no nonce.</span>
          <span>Writes execute through KeeperHub direct REST.</span>
        </div>
      </footer>
    </div>
  );
}
