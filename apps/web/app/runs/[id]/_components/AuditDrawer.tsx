'use client';

import React, { useEffect, useRef } from 'react';

import type { TimelineAttempt, TimelineEvent, TimelineItem } from '@/lib/events';

import { humanize, recordedText, StateChip } from './RunBoardPrimitives';

export interface AuditDrawerProps {
  readonly item: TimelineItem;
  readonly events: readonly TimelineEvent[];
  readonly onClose: () => void;
}

type Payload = Record<string, unknown>;

function asRecord(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function payloadValue(event: TimelineEvent | undefined, key: string): string {
  const value = event?.payload[key];
  return recordedText(value);
}

function formatArguments(value: unknown): string {
  if (value === undefined) return 'unavailable';
  try {
    return JSON.stringify(value, null, 2) ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function chronological(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((left, right) => {
    if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
      const a = BigInt(left.id);
      const b = BigInt(right.id);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
  });
}

function firstPresent(events: readonly TimelineEvent[], keys: readonly string[]): unknown {
  for (const event of chronological(events).reverse()) {
    for (const key of keys) {
      const value = event.payload[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

interface ConditionEvidence {
  readonly operator?: unknown;
  readonly met?: unknown;
  readonly observedValue?: unknown;
  readonly targetValue?: unknown;
}

function conditionEvidence(events: readonly TimelineEvent[]): ConditionEvidence | null {
  for (const event of chronological(events).reverse()) {
    const nested =
      asRecord(event.payload['condition']) ?? asRecord(event.payload['conditionResult']);
    if (nested !== null) return nested as ConditionEvidence;
    if (
      event.payload['met'] !== undefined ||
      event.payload['observedValue'] !== undefined ||
      event.payload['targetValue'] !== undefined ||
      event.payload['operator'] !== undefined
    ) {
      return event.payload as ConditionEvidence;
    }
  }
  return null;
}

function mergeAttempts(
  item: TimelineItem,
  itemEvents: readonly TimelineEvent[],
): TimelineAttempt[] {
  const merged = new Map<string, TimelineAttempt>();
  for (const attempt of item.attempts) merged.set(`${attempt.kind}:${attempt.attemptNo}`, attempt);
  for (const event of itemEvents) {
    for (const attempt of event.attempts ?? []) {
      merged.set(`${attempt.kind}:${attempt.attemptNo}`, attempt);
    }
  }
  const phase = (kind: string): number =>
    kind === 'SIMULATE' ? 0 : kind === 'COMMIT' ? 1 : kind === 'EXECUTE' ? 2 : 3;
  return [...merged.values()].sort((left, right) => {
    if (left.attemptNo !== right.attemptNo) return left.attemptNo - right.attemptNo;
    const phaseOrder = phase(left.kind) - phase(right.kind);
    return phaseOrder !== 0 ? phaseOrder : left.createdAt.localeCompare(right.createdAt);
  });
}

function valueOrNotRecorded(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  return recordedText(value);
}

function EvidenceRows({ rows }: { readonly rows: readonly [string, string][] }) {
  return (
    <dl className="mt-5 grid grid-cols-1 border-t border-[var(--convoy-hairline)] text-sm sm:grid-cols-[160px_1fr]">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="border-b border-[var(--convoy-hairline)] py-2 font-mono text-[10px] text-[var(--text-label)]">
            {label}
          </dt>
          <dd className="convoy-proof-value break-words border-b border-[var(--convoy-hairline)] py-2 text-[var(--convoy-text-deep)] sm:pl-4">
            {value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function AuditDrawer({ item, events, onClose }: AuditDrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusPanel = () => {
      closeButtonRef.current?.focus();
    };
    if (typeof window.requestAnimationFrame === 'function')
      window.requestAnimationFrame(focusPanel);
    else focusPanel();

    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panelRef.current
        ? [...panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)].filter(
            (element) => element.offsetParent !== null,
          )
        : [];
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (openerRef.current !== null && document.contains(openerRef.current)) {
        openerRef.current.focus();
      }
    };
  }, []);

  const itemEvents = chronological(events.filter((event) => event.itemIdx === item.idx));
  const attempts = mergeAttempts(item, itemEvents);
  const simulated = itemEvents.find((event) => event.type === 'ITEM_SIMULATED');
  const vetoed = itemEvents.find((event) => event.type === 'ITEM_VETOED');
  const commitEvent = itemEvents.find((event) => event.type === 'ITEM_COMMITTED');
  const simulateAttempt = attempts.find((attempt) => attempt.kind === 'SIMULATE');
  const commitAttempt = attempts.find((attempt) => attempt.kind === 'COMMIT');
  const condition = conditionEvidence(itemEvents);
  const critiqueEvents = itemEvents.filter(
    (event) => event.type === 'ITEM_SIMULATED' || event.type === 'ITEM_VETOED',
  );
  const selector = firstPresent(critiqueEvents, ['selector', 'revertSelector']);
  const revertReason =
    firstPresent(critiqueEvents, ['revert', 'revertReason']) ?? simulateAttempt?.revertReason;
  const wouldRevert = simulated?.payload['wouldRevert'] ?? simulateAttempt?.wouldRevert;
  const verdict =
    item.state === 'VETOED' || vetoed !== undefined
      ? 'VETOED'
      : simulated !== undefined && simulated.payload['wouldRevert'] === false
        ? simulated.payload['criticConsulted'] === true
          ? 'APPROVED'
          : 'SIMULATION PASSED'
        : 'not recorded';
  const retries = itemEvents.filter((event) => event.type === 'ITEM_RETRY');
  const gateTxHash = commitAttempt?.transactionHash ?? commitEvent?.payload['txHash'];
  const gateTxLink = commitAttempt?.transactionLink;

  const critiqueRows: [string, string][] = [];
  if (wouldRevert !== undefined && wouldRevert !== null) {
    critiqueRows.push(['wouldRevert', valueOrNotRecorded(wouldRevert)]);
  }
  if (simulated !== undefined || vetoed !== undefined || simulateAttempt !== undefined) {
    critiqueRows.push(['revertReason', valueOrNotRecorded(revertReason)]);
  }
  if (simulated?.payload['gasEstimate'] !== undefined) {
    critiqueRows.push(['gasEstimate', valueOrNotRecorded(simulated.payload['gasEstimate'])]);
  }
  if (simulated !== undefined || vetoed !== undefined) {
    critiqueRows.push(['verdict', verdict]);
    critiqueRows.push(['decided by', payloadValue(vetoed ?? simulated, 'decidedBy')]);
    critiqueRows.push(['Critic consulted', payloadValue(vetoed ?? simulated, 'criticConsulted')]);
  }
  if (selector !== undefined && selector !== null && selector !== '') {
    critiqueRows.push(['selector', String(selector)]);
  }

  const gateRows: [string, string][] = [
    [
      'Dependencies',
      item.dependsOn.length === 0
        ? 'No prerequisites'
        : item.dependsOn.map((dependencyIdx) => `#${dependencyIdx + 1}`).join(', '),
    ],
  ];
  if (condition !== null) {
    if (condition.operator !== undefined && condition.operator !== null) {
      gateRows.push(['operator', valueOrNotRecorded(condition.operator)]);
    }
    if (condition.met !== undefined && condition.met !== null) {
      gateRows.push(['met', valueOrNotRecorded(condition.met)]);
    }
    if (condition.observedValue !== undefined && condition.observedValue !== null) {
      gateRows.push(['observedValue', valueOrNotRecorded(condition.observedValue)]);
    }
    if (condition.targetValue !== undefined && condition.targetValue !== null) {
      gateRows.push(['targetValue', valueOrNotRecorded(condition.targetValue)]);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close audit drawer"
        onClick={onClose}
        className="convoy-scrim-in fixed inset-0 z-20 !m-0 cursor-default border-0 bg-[var(--scrim)] backdrop-blur-[1px]"
      />
      <aside
        ref={panelRef}
        aria-describedby="audit-drawer-description"
        aria-label={`Audit for item ${item.idx + 1}`}
        aria-modal="true"
        className="convoy-drawer-in fixed inset-0 z-30 !m-0 w-full overflow-y-auto border-l border-[var(--convoy-rule)] bg-[var(--convoy-cream)] shadow-[var(--shadow-drawer)] sm:left-auto sm:max-w-[var(--drawer-max)]"
        role="dialog"
        tabIndex={-1}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--convoy-border)] bg-white px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--text-label)]">
              Action evidence · #{String(item.idx + 1).padStart(2, '0')}
            </p>
            <h2 className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)]">
              {humanize(item.functionName)}
            </h2>
            <p id="audit-drawer-description" className="mt-1 text-xs text-[var(--text-subtle)]">
              Evidence read from the append-only ledger.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <StateChip state={item.state} />
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close audit drawer"
              className="min-h-11 border border-[var(--convoy-rule)] bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--convoy-text-deep)] hover:border-[var(--convoy-border-hover)]"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-6">
          <section className="bg-[var(--convoy-dark)] p-5 text-white sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--convoy-on-dark-muted)]">
              1 · Exact call
            </p>
            <p className="convoy-proof-value mt-4 break-all font-mono text-xs text-[var(--convoy-on-dark-green)]">
              {item.functionName}
            </p>
            <pre className="convoy-proof-value mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-[var(--convoy-on-dark-code)]">
              {formatArguments(item.functionArgs)}
            </pre>
            <p className="convoy-proof-value mt-4 break-all border-t border-white/15 pt-4 font-mono text-[10px] text-[var(--convoy-on-dark-muted)]">
              target {recordedText(item.targetAddress, 'unavailable')}
            </p>
          </section>

          <section className="border border-[var(--convoy-border)] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
              2 · Plan &amp; evidence
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[var(--convoy-ink-soft)]">
              Why this action belongs
            </h3>
            <p className="mt-3 text-sm leading-6 text-[var(--convoy-text-strong)]">
              {recordedText(item.plannerRationale)}
            </p>
            <div className="mt-5 border-l-2 border-[var(--convoy-green-dark)] bg-[var(--convoy-cream)] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)]">
                Supplied evidence
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-strong)]">
                {recordedText(item.evidence)}
              </p>
            </div>
          </section>

          <section className="border border-[var(--convoy-border)] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
              3 · Critique &amp; simulation
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[var(--convoy-ink-soft)]">
              Deterministic checks first
            </h3>
            {critiqueRows.length === 0 ? (
              <p className="mt-4 text-sm leading-6 text-[var(--text-subtle)]">
                Critique and simulation evidence were not recorded for this action.
              </p>
            ) : (
              <EvidenceRows rows={critiqueRows} />
            )}
            {item.state === 'VETOED' ? (
              <div className="mt-4 flex items-start gap-3 border border-[var(--state-vetoed-border)] bg-[var(--state-vetoed-bg)] p-4 convoy-veto-hatch">
                <span className="mt-0.5 text-[var(--state-vetoed-fg)]">VETOED</span>
                <p className="text-sm leading-6 text-[var(--state-vetoed-fg)]">
                  {recordedText(item.vetoReason ?? vetoed?.payload['reason'])}
                </p>
              </div>
            ) : null}
          </section>

          <section className="border border-[var(--convoy-border)] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
              4 · Attempts
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[var(--convoy-ink-soft)]">
              KeeperHub execution ledger
            </h3>
            <div className="mt-5 space-y-2">
              {attempts.length === 0 && retries.length === 0 ? (
                <p className="border border-[var(--convoy-border)] bg-[var(--convoy-cream)] p-4 text-sm text-[var(--text-subtle)]">
                  No KeeperHub attempt was recorded for this action.
                </p>
              ) : (
                <>
                  {attempts.map((attempt) => (
                    <div
                      key={`${attempt.kind}-${attempt.attemptNo}`}
                      className="border border-[var(--convoy-border)] p-4"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--convoy-ink-soft)]">
                          {attempt.kind} #{attempt.attemptNo + 1}
                        </span>
                        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--text-label)]">
                          {recordedText(attempt.khStatus)}
                        </span>
                      </div>
                      <dl className="mt-3 grid gap-1 text-xs text-[var(--convoy-text-body)] sm:grid-cols-2">
                        <div>
                          <dt className="sr-only">Gas</dt>
                          <dd>
                            gas {recordedText(attempt.gasUsedUsdc)}
                            {attempt.gasUsedUsdc === null ? '' : ' USDC'}
                          </dd>
                        </div>
                        <div>
                          <dt className="sr-only">Sponsored</dt>
                          <dd>sponsored {valueOrNotRecorded(attempt.sponsored)}</dd>
                        </div>
                        {attempt.gasUsedWei !== null ? (
                          <div className="convoy-proof-value sm:col-span-2">
                            <dt className="sr-only">KeeperHub gas field</dt>
                            <dd>gasUsedWei {attempt.gasUsedWei}</dd>
                          </div>
                        ) : null}
                        {attempt.wouldRevert !== null ? (
                          <div className="sm:col-span-2">
                            <dt className="sr-only">Would revert</dt>
                            <dd>wouldRevert {String(attempt.wouldRevert)}</dd>
                          </div>
                        ) : null}
                        {attempt.revertReason !== null ? (
                          <div className="convoy-proof-value sm:col-span-2">
                            <dt className="sr-only">Revert reason</dt>
                            <dd>revertReason {attempt.revertReason}</dd>
                          </div>
                        ) : null}
                        <div className="convoy-proof-value sm:col-span-2">
                          <dt className="sr-only">Execution ID</dt>
                          <dd>executionId {recordedText(attempt.executionId)}</dd>
                        </div>
                        <div className="convoy-proof-value sm:col-span-2">
                          <dt className="sr-only">Created at</dt>
                          <dd>created {recordedText(attempt.createdAt)}</dd>
                        </div>
                      </dl>
                      {attempt.transactionHash ? (
                        <p className="convoy-proof-value mt-3 break-all font-mono text-[10px] text-[var(--convoy-text-deep)]">
                          hash: {attempt.transactionHash}
                        </p>
                      ) : null}
                      {attempt.transactionLink ? (
                        <a
                          className="convoy-proof-value mt-2 block break-all font-mono text-[10px] text-[var(--convoy-green-dark)] underline underline-offset-2"
                          href={attempt.transactionLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {attempt.transactionLink}
                        </a>
                      ) : null}
                      {attempt.errorCode ? (
                        <p className="mt-2 text-xs text-[var(--text-danger)]">
                          {attempt.errorCode}
                        </p>
                      ) : null}
                    </div>
                  ))}
                  {retries.map((retry) => (
                    <div
                      key={`retry-${retry.id}`}
                      className="border border-[var(--state-retrying-border)] bg-[var(--state-retrying-bg)] p-4"
                    >
                      <div className="flex justify-between gap-3">
                        <span className="font-mono text-[10px] text-[var(--state-retrying-fg)]">
                          RETRY OBSERVED
                          {retry.payload['retryCount'] === undefined ||
                          retry.payload['retryCount'] === null
                            ? ''
                            : ` · PROVIDER COUNT ${String(retry.payload['retryCount'])}`}
                        </span>
                        <span className="text-xs text-[var(--state-retrying-fg)]">observed</span>
                      </div>
                      <p className="mt-2 text-xs text-[var(--state-retrying-fg)]">
                        {retry.payload['code'] === undefined || retry.payload['code'] === null
                          ? 'transient condition observed'
                          : `code: ${String(retry.payload['code'])}`}
                      </p>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>

          <section className="border border-[var(--convoy-border)] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
              5 · Gate &amp; onchain evidence
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[var(--convoy-ink-soft)]">
              ConvoyRegistry condition
            </h3>
            {condition === null ? (
              <p className="mt-4 text-sm leading-6 text-[var(--text-subtle)]">
                No onchain condition was recorded for this action.
              </p>
            ) : null}
            <EvidenceRows rows={gateRows} />
            <div className="mt-4 border-t border-[var(--convoy-hairline)] pt-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                Commitment transaction
              </p>
              {gateTxLink ? (
                <a
                  className="convoy-proof-value mt-2 block break-all font-mono text-[10px] text-[var(--convoy-green-dark)] underline underline-offset-2"
                  href={gateTxLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  {recordedText(gateTxHash ?? gateTxLink)}
                </a>
              ) : (
                <p className="convoy-proof-value mt-2 break-all font-mono text-[10px] text-[var(--convoy-text-deep)]">
                  {recordedText(gateTxHash)}
                </p>
              )}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
