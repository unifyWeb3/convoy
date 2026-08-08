'use client';

import React from 'react';

import type { TimelineEvent, TimelineItem } from '@/lib/events';

export interface AuditDrawerProps {
  readonly item: TimelineItem;
  readonly events: readonly TimelineEvent[];
  readonly onClose: () => void;
}

function payloadValue(event: TimelineEvent | undefined, key: string): string {
  const value = event?.payload[key];
  return value === undefined || value === null ? 'not recorded' : String(value);
}

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatArguments(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '[]';
  } catch {
    return '[unavailable]';
  }
}

export function AuditDrawer({ item, events, onClose }: AuditDrawerProps) {
  const itemEvents = events.filter((event) => event.itemIdx === item.idx);
  const simulated = itemEvents.find((event) => event.type === 'ITEM_SIMULATED');
  const vetoed = itemEvents.find((event) => event.type === 'ITEM_VETOED');
  const simulateAttempt = item.attempts.find((attempt) => attempt.kind === 'SIMULATE');
  const commitAttempt = item.attempts.find((attempt) => attempt.kind === 'COMMIT');
  const verdict = vetoed ?? simulated;
  const wouldRevert = simulated?.payload['wouldRevert'] ?? simulateAttempt?.wouldRevert;
  const revertReason =
    vetoed?.payload['revert'] ??
    vetoed?.payload['detail'] ??
    simulateAttempt?.revertReason ??
    'not recorded';
  const verdictLabel =
    vetoed !== undefined
      ? `VETOED (${item.vetoReason ?? payloadValue(vetoed, 'reason')})`
      : simulated !== undefined || simulateAttempt?.wouldRevert === false
        ? 'APPROVED'
        : 'not recorded';

  return (
    <>
      <button
        type="button"
        aria-label="Close audit drawer"
        onClick={onClose}
        className="fixed inset-0 z-20 !m-0 cursor-default bg-[#111111]/35 backdrop-blur-[1px]"
      />
      <aside
        aria-label={`Audit for item ${item.idx}`}
        aria-modal="true"
        role="dialog"
        className="fixed inset-0 z-30 !m-0 w-full overflow-y-auto border-l border-[#D9D9D3] bg-[#F7F7F2] shadow-2xl sm:left-auto sm:max-w-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[#E5E5E0] bg-white px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#007D4D]">
              Action evidence · #{item.idx}
            </p>
            <h2 className="font-convoy-display mt-2 text-3xl text-[#1A1816]">
              {humanize(item.functionName)}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close audit drawer"
            className="border border-[#D9D9D3] bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#3F3B37] hover:border-[#7A7A7A]"
          >
            Close
          </button>
        </div>

        <div className="space-y-4 p-4 sm:p-6">
          <section className="bg-[#2B2825] p-5 text-white sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#B9B3AC]">
              Exact call
            </p>
            <p className="mt-4 break-all font-mono text-xs text-[#87F1C1]">{item.functionName}</p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-[#E9E5DF]">
              {formatArguments(item.functionArgs)}
            </pre>
            <p className="mt-4 break-all border-t border-white/15 pt-4 font-mono text-[10px] text-[#B9B3AC]">
              target {item.targetAddress}
            </p>
          </section>

          <section className="border border-[#E5E5E0] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8A847C]">
              Plan · why it belongs
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[#1A1816]">Planner reason</h3>
            <p className="mt-3 text-sm leading-6 text-[#4F4B47]">
              {item.plannerRationale ?? 'No Planner rationale was recorded.'}
            </p>
            <div className="mt-5 border-l-2 border-[#00C274] bg-[#F7F7F2] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#8A847C]">
                Supplied evidence
              </p>
              <p className="mt-2 text-sm leading-6 text-[#4F4B47]">{item.evidence}</p>
            </div>
          </section>

          <section className="border border-[#E5E5E0] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8A847C]">
              Critique · deterministic checks first
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[#1A1816]">
              Critic and simulation
            </h3>
            <dl className="mt-5 grid grid-cols-1 border-t border-[#E5E5E0] text-sm sm:grid-cols-[160px_1fr]">
              {[
                [
                  'wouldRevert',
                  wouldRevert === null || wouldRevert === undefined
                    ? 'not recorded'
                    : String(wouldRevert),
                ],
                ['revertReason', String(revertReason)],
                ['gasEstimate', payloadValue(simulated, 'gasEstimate')],
                ['verdict', verdictLabel],
                ['decided by', payloadValue(verdict, 'decidedBy')],
                ['Critic consulted', payloadValue(verdict, 'criticConsulted')],
              ].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="border-b border-[#ECECE7] py-2 font-mono text-[10px] text-[#8A847C]">
                    {label}
                  </dt>
                  <dd className="break-words border-b border-[#ECECE7] py-2 text-[#3F3B37] sm:pl-4">
                    {value}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </section>

          <section className="border border-[#E5E5E0] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8A847C]">
              Execute · KeeperHub ledger
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[#1A1816]">Attempts</h3>
            <div className="mt-5 space-y-2">
              {item.attempts.length === 0 &&
              itemEvents.filter((event) => event.type === 'ITEM_RETRY').length === 0 ? (
                <p className="border border-[#E5E5E0] bg-[#F7F7F2] p-4 text-sm text-[#7A7A7A]">
                  No KeeperHub attempts. 0 gas.
                </p>
              ) : (
                <>
                  {item.attempts.map((attempt) => (
                    <div
                      key={`${attempt.kind}-${attempt.attemptNo}`}
                      className="border border-[#E5E5E0] p-4"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-mono text-[10px] font-semibold tracking-wide text-[#1A1816]">
                          {attempt.kind} #{attempt.attemptNo + 1}
                        </span>
                        <span className="font-mono text-[9px] uppercase tracking-wider text-[#7A7A7A]">
                          {attempt.khStatus ?? 'recorded'}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#68645F]">
                        <span>gas {attempt.gasUsedUsdc ?? '0'} USDC</span>
                        <span>
                          sponsored{' '}
                          {attempt.sponsored === null ? 'not recorded' : String(attempt.sponsored)}
                        </span>
                      </div>
                      {attempt.transactionHash ? (
                        <p className="mt-3 break-all font-mono text-[10px] text-[#3F3B37]">
                          hash: {attempt.transactionHash}
                        </p>
                      ) : null}
                      {attempt.transactionLink ? (
                        <a
                          className="mt-2 block break-all font-mono text-[10px] text-[#007D4D] underline underline-offset-2"
                          href={attempt.transactionLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {attempt.transactionLink}
                        </a>
                      ) : null}
                      {attempt.errorCode ? (
                        <p className="mt-2 text-xs text-[#E53935]">{attempt.errorCode}</p>
                      ) : null}
                    </div>
                  ))}
                  {itemEvents
                    .filter((event) => event.type === 'ITEM_RETRY')
                    .map((retry) => (
                      <div
                        key={`retry-${retry.id}`}
                        className="border border-[#E7C76D] bg-[#FFF9E9] p-4"
                      >
                        <div className="flex justify-between gap-3">
                          <span className="font-mono text-[10px]">
                            RETRY #{String(retry.payload['attempt'] ?? 'unknown')}
                          </span>
                          <span className="text-xs text-[#8D6811]">observed</span>
                        </div>
                        <p className="mt-2 text-xs text-[#6D5212]">
                          {retry.payload['code'] === null || retry.payload['code'] === undefined
                            ? 'transient retry observed'
                            : `code: ${String(retry.payload['code'])}`}
                        </p>
                      </div>
                    ))}
                </>
              )}
            </div>
          </section>

          <section className="border border-[#E5E5E0] bg-white p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#8A847C]">
              Gate · onchain evidence
            </p>
            <h3 className="font-convoy-display mt-3 text-2xl text-[#1A1816]">
              ConvoyRegistry event
            </h3>
            {commitAttempt?.transactionLink ? (
              <a
                className="mt-4 block break-all font-mono text-[10px] text-[#007D4D] underline underline-offset-2"
                href={commitAttempt.transactionLink}
                target="_blank"
                rel="noreferrer"
              >
                {commitAttempt.transactionHash ?? commitAttempt.transactionLink}
              </a>
            ) : (
              <p className="mt-4 break-all font-mono text-[10px] text-[#4F4B47]">
                {payloadValue(
                  itemEvents.find((event) => event.type === 'ITEM_COMMITTED'),
                  'txHash',
                )}
              </p>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
