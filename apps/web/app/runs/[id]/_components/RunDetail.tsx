'use client';

import React, { useMemo, useState } from 'react';

import type { TimelineItem, TimelineSnapshot } from '@/lib/events';

import { DagView } from './DagView';
import { Manifest } from './Manifest';
import { humanize, StateChip, StateGlyph } from './RunBoardPrimitives';
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

interface BlockedDependency {
  readonly item: TimelineItem;
  readonly prerequisites: readonly TimelineItem[];
}

const TERMINAL_RUNS = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);
const TABS: readonly { readonly id: RunTab; readonly label: string }[] = [
  { id: 'timeline', label: 'Actions & timeline' },
  { id: 'dag', label: 'Dependency DAG' },
  { id: 'manifest', label: 'Proof manifest' },
];

function shortRunId(runId: string): string {
  return runId.length > 22 ? `${runId.slice(0, 10)}…${runId.slice(-8)}` : runId;
}

function displayItemNumber(idx: number): string {
  return `#${String(idx + 1).padStart(2, '0')}`;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUsdc(value: number | null): string {
  if (value === null) return 'not recorded';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function hasExplicitZero(event: { readonly payload: Record<string, unknown> }): boolean {
  return ['gasSpent', 'gasUsdcConsumed', 'gasUsedUsdc', 'gasUsedWei'].some((key) => {
    const value = event.payload[key];
    return value === 0 || value === 0n || value === '0' || value === '0.0' || value === '0.000000';
  });
}

function gasReceiptKey(
  values: { readonly executionId?: unknown; readonly transactionHash?: unknown },
  fallback: string,
): string {
  if (typeof values.transactionHash === 'string' && values.transactionHash !== '') {
    return `tx:${values.transactionHash.toLowerCase()}`;
  }
  if (typeof values.executionId === 'string' && values.executionId !== '') {
    return `execution:${values.executionId}`;
  }
  return fallback;
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

function firstBlockedDependency(
  items: readonly TimelineItem[],
  states: ReadonlyMap<number, string>,
): BlockedDependency | null {
  for (const item of items) {
    if (states.get(item.idx) !== 'DEFERRED') continue;
    const prerequisites = item.dependsOn
      .filter((dependencyIdx) => states.get(dependencyIdx) !== 'LANDED')
      .map((dependencyIdx) => items.find((candidate) => candidate.idx === dependencyIdx))
      .filter((candidate): candidate is TimelineItem => candidate !== undefined);
    if (prerequisites.length > 0) return { item, prerequisites };
  }
  return null;
}

function nowMessage(
  status: string,
  items: readonly TimelineItem[],
  states: ReadonlyMap<number, string>,
): string {
  if (status === 'RECEIVED') return 'The batch is recorded. No target write has been submitted.';
  if (status === 'OPENING') return 'The run record is being opened through KeeperHub.';
  if (status === 'PLANNING')
    return 'The Planner is ordering the supplied actions and dependencies.';
  if (status === 'CRITIQUING') {
    return 'Actions are being simulated and checked against their recorded evidence.';
  }
  if (status === 'EXECUTING') {
    const active = currentItem(items, states);
    if (active !== null && states.get(active.idx) === 'DEFERRED') {
      return `${displayItemNumber(active.idx)} ${humanize(active.functionName)} is waiting for its recorded prerequisites.`;
    }
    if (active !== null) {
      return `${displayItemNumber(active.idx)} ${humanize(active.functionName)} is advancing through the KeeperHub execution ledger.`;
    }
    return 'Every action is resolved. The run is preparing its seal and proof package.';
  }
  if (status === 'SEALING')
    return 'Action processing is complete. The registry seal is in progress.';
  if (status === 'SEALED_OK') {
    return 'The registry seal completed. Every recorded item outcome remains visible below.';
  }
  if (status === 'SEALED_PARTIAL') {
    return 'The run sealed with exceptions preserved in the proof manifest.';
  }
  if (status === 'ABORTED')
    return 'The run was aborted; its append-only evidence remains readable.';
  if (status === 'FAILED_FATAL') {
    return 'The run stopped before a complete seal. The ledger preserves the failure evidence.';
  }
  return 'The latest recorded run state is shown here.';
}

function terminalDeferredSuffix(status: string): string {
  if (status === 'ABORTED') return ' did not land before the run was aborted.';
  if (status === 'FAILED_FATAL') return ' did not land before processing stopped.';
  return ' did not land before the run sealed.';
}

function momentHeadline(status: string, active: TimelineItem | null, itemCount: number): string {
  if (status === 'EXECUTING' && active !== null) {
    return `${displayItemNumber(active.idx)} of ${itemCount}: ${humanize(active.functionName)}`;
  }
  return humanize(status);
}

function stageTone(state: StageState): React.CSSProperties {
  if (state === 'complete') {
    return { borderTopColor: 'var(--state-success-edge)', background: 'var(--convoy-paper)' };
  }
  if (state === 'active') {
    return {
      borderTopColor: 'var(--convoy-green-dark)',
      background: 'var(--convoy-green-soft)',
    };
  }
  if (state === 'issue') {
    return { borderTopColor: 'var(--state-partial-edge)', background: 'var(--state-partial-bg)' };
  }
  return { borderTopColor: 'var(--convoy-border)', background: 'var(--convoy-paper)' };
}

function stageLabel(state: StageState): string {
  if (state === 'complete') return 'Complete';
  if (state === 'active') return 'In progress';
  if (state === 'issue') return 'Needs review';
  return 'Waiting';
}

function stageGlyph(state: StageState): string {
  if (state === 'complete') return 'LANDED';
  if (state === 'active') return 'EXECUTING';
  if (state === 'issue') return 'SEALED_PARTIAL';
  return 'PLANNED';
}

function ConvoyMark() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--convoy-dark)]"
    >
      <span className="absolute left-2 top-2 h-2 w-2 bg-[var(--convoy-green)]" />
      <span className="absolute left-2 top-4 h-px w-5 bg-white" />
      <span className="absolute bottom-[6px] right-[6px] h-2 w-2 bg-[var(--convoy-green)]" />
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
    const prerequisitesLanded = dependencyItems.every((item) =>
      item.dependsOn.every((dependencyIdx) => states.get(dependencyIdx) === 'LANDED'),
    );
    const gateComplete = critiqueComplete && prerequisitesLanded;
    const executionComplete = [
      'SEALING',
      'SEALED_OK',
      'SEALED_PARTIAL',
      'ABORTED',
      'FAILED_FATAL',
    ].includes(live.runStatus);
    const issue = ['SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL'].includes(live.runStatus);
    const vetoed = stateCount('VETOED');
    const zeroGasVetoes = live.events.filter(
      (event) => event.type === 'ITEM_VETOED' && hasExplicitZero(event),
    ).length;

    const stages: readonly StageSummary[] = [
      {
        number: '01',
        name: 'Plan',
        verb: 'Order the batch',
        detail: 'Records only the supplied actions and their declared dependencies.',
        metric: `${live.items.length} action${live.items.length === 1 ? '' : 's'} recorded`,
        state: hasPlan
          ? 'complete'
          : ['RECEIVED', 'OPENING', 'PLANNING'].includes(live.runStatus)
            ? 'active'
            : 'waiting',
      },
      {
        number: '02',
        name: 'Critique',
        verb: 'Challenge each action',
        detail: 'Uses KeeperHub simulation and the recorded evidence before execution.',
        metric:
          vetoed === 0
            ? 'No vetoes recorded'
            : zeroGasVetoes > 0
              ? `${vetoed} vetoed · ${zeroGasVetoes} with zero gas recorded`
              : `${vetoed} vetoed`,
        state: critiqueComplete
          ? 'complete'
          : live.runStatus === 'CRITIQUING'
            ? 'active'
            : 'waiting',
      },
      {
        number: '03',
        name: 'Gate',
        verb: 'Hold prerequisites',
        detail: 'Requires app-side dependency release and the recorded registry condition.',
        metric: `${dependencyItems.length} dependency-bound`,
        state: gateComplete
          ? 'complete'
          : terminal
            ? 'issue'
            : live.runStatus === 'EXECUTING' && dependencyItems.length > 0
              ? 'active'
              : 'waiting',
      },
      {
        number: '04',
        name: 'Execute',
        verb: 'Submit approved writes',
        detail: 'KeeperHub executes surviving target writes and manages transaction ordering.',
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
        detail: 'Compares KeeperHub, registry, and ledger evidence in one export.',
        metric: terminal ? 'Terminal record ready' : 'Available after terminal state',
        state: terminal
          ? issue
            ? 'issue'
            : 'complete'
          : live.runStatus === 'SEALING'
            ? 'active'
            : 'waiting',
      },
    ];

    const gasByReceipt = new Map<string, number>();
    for (const event of live.events) {
      const gas = optionalNumber(event.payload['gasUsdcConsumed']);
      if (gas === null) continue;
      const key = gasReceiptKey(
        {
          executionId: event.payload['executionId'],
          transactionHash: event.payload['txHash'],
        },
        `event:${event.id}`,
      );
      gasByReceipt.set(key, gas);
    }
    for (const item of live.items) {
      for (const attempt of item.attempts) {
        const gas = optionalNumber(attempt.gasUsedUsdc);
        if (gas === null) continue;
        const key = gasReceiptKey(
          {
            executionId: attempt.executionId,
            transactionHash: attempt.transactionHash,
          },
          `attempt:${item.idx}:${attempt.kind}:${attempt.attemptNo}`,
        );
        if (!gasByReceipt.has(key)) gasByReceipt.set(key, gas);
      }
    }
    const liveGas =
      gasByReceipt.size === 0
        ? null
        : [...gasByReceipt.values()].reduce((sum, value) => sum + value, 0);
    const hasGasEvidence = liveGas !== null;
    const snapshotGas = hasGasEvidence ? optionalNumber(snapshot.run.spentGasUsdc) : null;
    const hasPaymentEvidence = live.events.some((event) =>
      ['spentPayUsdc', 'payUsdcConsumed', 'paymentUsdc'].some(
        (key) => event.payload[key] !== undefined && event.payload[key] !== null,
      ),
    );
    const spentPay = hasPaymentEvidence ? optionalNumber(snapshot.run.spentPayUsdc) : null;
    const budget = optionalNumber(snapshot.run.budgetUsdc);
    const gasCandidates = [liveGas, snapshotGas].filter((value): value is number => value !== null);
    const gasUsed = gasCandidates.length === 0 ? null : Math.max(...gasCandidates);
    const used = gasUsed === null || spentPay === null ? null : gasUsed + spentPay;
    const budgetPercent =
      used !== null && budget !== null && budget > 0
        ? Math.min(100, Math.max(0, (used / budget) * 100))
        : null;
    const active = currentItem(live.items, states);

    return {
      stages,
      states,
      terminal,
      landed: stateCount('LANDED'),
      vetoed,
      deferred: stateCount('DEFERRED'),
      failed: stateCount('FAILED'),
      skipped: stateCount('SKIPPED'),
      budget,
      gasUsed,
      spentPay,
      used,
      budgetPercent,
      active,
      blocked: firstBlockedDependency(live.items, states),
      lastEvent: live.events.at(-1) ?? null,
    };
  }, [live.events, live.items, live.runStatus, snapshot.run]);

  function handleTabKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const selected = TABS[next];
    if (selected === undefined) return;
    setTab(selected.id);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  }

  return (
    <div className="min-h-screen bg-[var(--convoy-cream)]">
      <a className="convoy-skip-link" href="#run-board-main">
        Skip to run board
      </a>

      <header className="sticky top-0 z-20 border-b border-[var(--convoy-border)] bg-white">
        <div className="mx-auto flex min-h-14 max-w-[1440px] items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <ConvoyMark />
            <div className="min-w-0">
              <p className="font-convoy-display text-lg leading-none text-[var(--convoy-ink)]">
                Convoy
              </p>
              <p className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
                Onchain release control
              </p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden border border-[var(--convoy-rule-strong)] bg-white px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)] sm:inline-flex">
              Base Sepolia · 84532
            </span>
            <StateChip state={live.runStatus} />
          </div>
        </div>
      </header>

      <main
        id="run-board-main"
        className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10"
      >
        <section className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)] lg:items-stretch">
          <div className="border border-[var(--convoy-border-card)] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
              Run board
            </p>
            <h1 className="font-convoy-display mt-3 text-4xl leading-none text-[var(--convoy-ink-soft)] sm:text-5xl">
              Run {shortRunId(runId)}
            </h1>
            <p className="convoy-proof-value mt-3 font-mono text-[10px] leading-5 text-[var(--convoy-text-meta)]">
              {runId}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <StateChip state={live.runStatus} />
              <span className="border border-[var(--convoy-rule-strong)] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)]">
                {live.items.length} action{live.items.length === 1 ? '' : 's'}
              </span>
              <span className="border border-[var(--convoy-rule-strong)] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)] sm:hidden">
                Base Sepolia · 84532
              </span>
            </div>
            <p className="mt-5 max-w-[68ch] text-sm leading-6 text-[var(--convoy-text-body)]">
              Status, action order, dependency release, and proof are all read from this run&apos;s
              append-only record.
            </p>
          </div>

          <aside
            aria-labelledby="now-heading"
            className="bg-[var(--convoy-dark)] p-5 text-white sm:p-6"
            role="status"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                id="now-heading"
                className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--convoy-on-dark-muted)]"
              >
                What is happening now
              </p>
              <StateChip state={live.runStatus} onDark />
            </div>
            <p className="font-convoy-display mt-7 text-2xl leading-tight text-white sm:text-3xl">
              {momentHeadline(live.runStatus, overview.active, live.items.length)}
            </p>
            <p className="mt-3 max-w-[72ch] text-sm leading-6 text-[var(--convoy-on-dark-body)]">
              {nowMessage(live.runStatus, live.items, overview.states)}
            </p>

            {overview.blocked !== null ? (
              <div className="mt-5 border border-[var(--state-deferred-edge)] bg-white/[0.04] p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-[var(--convoy-on-dark-amber)]">
                    <StateGlyph state="DEFERRED" size={14} />
                  </span>
                  <p className="text-xs leading-5 text-[var(--convoy-on-dark-body)]">
                    <strong className="font-semibold text-white">
                      {displayItemNumber(overview.blocked.item.idx)}{' '}
                      {humanize(overview.blocked.item.functionName)}
                    </strong>{' '}
                    {overview.terminal ? ' remains deferred because ' : ' is waiting on '}
                    {overview.blocked.prerequisites.map((prerequisite, index) => (
                      <React.Fragment key={prerequisite.idx}>
                        {index > 0 ? ', ' : ''}
                        <strong className="font-semibold text-white">
                          {displayItemNumber(prerequisite.idx)}{' '}
                          {humanize(prerequisite.functionName)}
                        </strong>
                      </React.Fragment>
                    ))}
                    {overview.terminal ? terminalDeferredSuffix(live.runStatus) : '.'}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="mt-6 grid gap-2 border-t border-white/15 pt-4 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-on-dark-muted)] sm:grid-cols-2">
              <span>
                {live.events.length} ledger event{live.events.length === 1 ? '' : 's'}
              </span>
              <span className="sm:text-right">
                Last event {overview.lastEvent?.id ?? 'not recorded'}
              </span>
            </div>
          </aside>
        </section>

        <section
          aria-labelledby="tally-heading"
          className="mt-6 grid border border-[var(--convoy-border-card)] bg-white lg:grid-cols-[1.35fr_0.65fr]"
        >
          <div className="p-5 sm:p-6 lg:border-r lg:border-[var(--convoy-border)]">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
                  Run progress
                </p>
                <h2
                  id="tally-heading"
                  className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)]"
                >
                  Action tally
                </h2>
              </div>
              <p className="max-w-sm text-xs leading-5 text-[var(--text-subtle)]">
                Counts follow the latest chronological state of each ledger item.
              </p>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-px bg-[var(--convoy-border)] sm:grid-cols-5">
              {[
                ['Landed', String(overview.landed)],
                ['Vetoed', String(overview.vetoed)],
                ['Deferred', String(overview.deferred)],
                ['Failed', String(overview.failed)],
                ['Skipped', String(overview.skipped)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className={`bg-white px-3 py-4 ${
                    label === 'Skipped' ? 'col-span-2 sm:col-span-1' : ''
                  }`}
                >
                  <dt className="font-mono text-[9px] uppercase tracking-[0.13em] text-[var(--text-label)]">
                    {label}
                  </dt>
                  <dd className="convoy-numeric font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="border-t border-[var(--convoy-border)] p-5 sm:p-6 lg:border-t-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.17em] text-[var(--text-label)]">
              Policy budget used
            </p>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <p className="convoy-numeric font-convoy-display text-3xl text-[var(--convoy-ink-soft)]">
                {overview.used === null ? 'unavailable' : formatUsdc(overview.used)}
                {overview.used === null ? null : (
                  <span className="ml-2 font-sans text-xs tracking-normal text-[var(--text-subtle)]">
                    USDC
                  </span>
                )}
              </p>
              <p className="convoy-numeric font-mono text-[10px] text-[var(--text-subtle)]">
                of {formatUsdc(overview.budget)}
              </p>
            </div>
            <div
              aria-label={
                overview.budgetPercent === null
                  ? 'Budget percentage unavailable'
                  : `${overview.budgetPercent.toFixed(1)} percent of budget used`
              }
              aria-valuemax={overview.budgetPercent === null ? undefined : 100}
              aria-valuemin={overview.budgetPercent === null ? undefined : 0}
              aria-valuenow={
                overview.budgetPercent === null
                  ? undefined
                  : Number(overview.budgetPercent.toFixed(1))
              }
              className="mt-4 h-2 bg-[var(--convoy-track)]"
              role={overview.budgetPercent === null ? undefined : 'progressbar'}
            >
              {overview.budgetPercent === null ? null : (
                <div
                  className="convoy-meter-fill h-full bg-[var(--convoy-green)]"
                  style={{ width: `${overview.budgetPercent}%` }}
                />
              )}
            </div>
            <dl className="mt-5 grid gap-2 border-t border-[var(--convoy-border)] pt-4 text-xs sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              <div>
                <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                  Gas
                </dt>
                <dd className="convoy-numeric mt-1 text-[var(--convoy-text-strong)]">
                  {formatUsdc(overview.gasUsed)}
                  {overview.gasUsed === null ? '' : ' USDC'}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                  Payment
                </dt>
                <dd className="convoy-numeric mt-1 text-[var(--convoy-text-strong)]">
                  {formatUsdc(overview.spentPay)}
                  {overview.spentPay === null ? '' : ' USDC'}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                  Deadline
                </dt>
                <dd className="mt-1 text-[var(--convoy-text-strong)]">
                  {snapshot.run.deadline === null
                    ? 'not recorded'
                    : new Date(snapshot.run.deadline).toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-[11px] leading-5 text-[var(--text-subtle)]">
              The total requires both receipt-backed gas and recorded payment spend. Available
              components remain listed above. Testnet USD remains notional.
            </p>
          </div>
        </section>

        <section aria-labelledby="pipeline-heading" className="mt-8">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
                Release method
              </p>
              <h2
                id="pipeline-heading"
                className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)]"
              >
                Plan → Critique → Gate → Execute → Prove
              </h2>
            </div>
            <p className="max-w-md text-xs leading-5 text-[var(--text-subtle)]">
              Each stage owns a count or evidence surface that can be checked below.
            </p>
          </div>
          <div className="convoy-mobile-scroll pb-2">
            <ol className="grid min-w-[860px] grid-cols-5 gap-px bg-[var(--convoy-border)]">
              {overview.stages.map((stage) => (
                <li
                  key={stage.name}
                  className="min-h-[170px] border-t-2 p-4"
                  style={stageTone(stage.state)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-mono text-[9px] text-[var(--text-label)]">
                      {stage.number}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-text-meta)]">
                      <StateGlyph state={stageGlyph(stage.state)} size={11} />
                      {stageLabel(stage.state)}
                    </span>
                  </div>
                  <h3 className="font-convoy-display mt-5 text-2xl text-[var(--convoy-ink-soft)]">
                    {stage.name}
                  </h3>
                  <p className="mt-1 text-sm font-semibold text-[var(--convoy-ink-soft)]">
                    {stage.verb}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-[var(--text-subtle)]">{stage.detail}</p>
                  <p className="mt-4 border-t border-[var(--convoy-border)] pt-3 font-mono text-[9px] uppercase tracking-[0.11em] text-[var(--convoy-text-meta)]">
                    {stage.metric}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mt-8" aria-label="Run board">
          <nav
            aria-label="Run views"
            className="convoy-mobile-scroll flex border-b border-[var(--convoy-rule)]"
            role="tablist"
          >
            {TABS.map((item, index) => (
              <button
                key={item.id}
                aria-controls={`run-panel-${item.id}`}
                aria-selected={tab === item.id}
                className={`min-h-11 shrink-0 border-b-2 px-4 text-sm font-medium transition-colors sm:px-5 ${
                  tab === item.id
                    ? 'border-[var(--convoy-green-dark)] text-[var(--convoy-ink)]'
                    : 'border-transparent text-[var(--text-subtle)] hover:text-[var(--convoy-ink)]'
                }`}
                id={`run-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => handleTabKey(event, index)}
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </nav>
          {TABS.map((item) => (
            <div
              key={item.id}
              aria-labelledby={`run-tab-${item.id}`}
              className={tab === item.id ? 'convoy-pane-in pt-6 sm:pt-8' : undefined}
              hidden={tab !== item.id}
              id={`run-panel-${item.id}`}
              role="tabpanel"
              tabIndex={0}
            >
              {tab === item.id && item.id === 'timeline' ? (
                <Timeline runId={runId} initial={snapshot} live={live} />
              ) : null}
              {tab === item.id && item.id === 'dag' ? <DagView runId={runId} live={live} /> : null}
              {tab === item.id && item.id === 'manifest' ? (
                <Manifest runId={runId} runStatus={live.runStatus} />
              ) : null}
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-[var(--convoy-border)] bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-5 font-mono text-[9px] uppercase tracking-[0.13em] text-[var(--text-label)] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-10">
          <span>Convoy holds no private keys and sets no nonce.</span>
          <span>Chain writes execute through KeeperHub.</span>
        </div>
      </footer>
    </div>
  );
}
