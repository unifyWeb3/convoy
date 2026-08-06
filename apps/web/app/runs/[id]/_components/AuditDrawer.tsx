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
  return (
    <aside
      aria-label={`Audit for item ${item.idx}`}
      className="fixed inset-y-0 right-0 z-20 w-full max-w-xl overflow-y-auto border-l border-zinc-300 bg-white p-6 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-zinc-200 pb-4">
        <div>
          <p className="font-mono text-xs text-zinc-500">ITEM #{item.idx}</p>
          <h2 className="text-xl font-semibold text-zinc-950">{item.functionName}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close audit drawer"
          className="border border-zinc-300 px-2 py-1 text-sm"
        >
          Close
        </button>
      </div>
      <div className="space-y-5 py-5 text-sm">
        <section>
          <h3 className="font-semibold text-zinc-950">Planner reason</h3>
          <p className="mt-1 text-zinc-700">
            {item.plannerRationale ?? 'No Planner rationale was recorded.'}
          </p>
        </section>
        <section>
          <h3 className="font-semibold text-zinc-950">Critic and simulation</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-zinc-700">
            <dt>wouldRevert</dt>
            <dd>
              {wouldRevert === null || wouldRevert === undefined
                ? 'not recorded'
                : String(wouldRevert)}
            </dd>
            <dt>revertReason</dt>
            <dd>{String(revertReason)}</dd>
            <dt>gasEstimate</dt>
            <dd>{payloadValue(simulated, 'gasEstimate')}</dd>
            <dt>verdict</dt>
            <dd>
              {vetoed === undefined
                ? 'APPROVED'
                : `VETOED (${item.vetoReason ?? payloadValue(vetoed, 'reason')})`}
            </dd>
            <dt>decided by</dt>
            <dd>{payloadValue(verdict, 'decidedBy')}</dd>
            <dt>Critic consulted</dt>
            <dd>{payloadValue(verdict, 'criticConsulted')}</dd>
          </dl>
        </section>
        <section>
          <h3 className="font-semibold text-zinc-950">Attempts</h3>
          <div className="mt-2 space-y-2">
            {item.attempts.length === 0 ? (
              <p className="text-zinc-500">No KeeperHub attempts. 0 gas.</p>
            ) : (
              item.attempts.map((attempt) => (
                <div
                  key={`${attempt.kind}-${attempt.attemptNo}`}
                  className="border border-zinc-200 p-3"
                >
                  <div className="flex justify-between">
                    <span className="font-mono text-xs">
                      {attempt.kind} #{attempt.attemptNo + 1}
                    </span>
                    <span className="text-xs text-zinc-500">{attempt.khStatus ?? 'recorded'}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-600">
                    gas {attempt.gasUsedUsdc ?? '0'} USDC
                  </p>
                  {attempt.transactionLink ? (
                    <a
                      className="mt-1 block break-all font-mono text-xs text-sky-700 underline"
                      href={attempt.transactionLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {attempt.transactionHash ?? attempt.transactionLink}
                    </a>
                  ) : null}
                  {attempt.errorCode ? (
                    <p className="mt-1 text-xs text-red-700">{attempt.errorCode}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
        <section>
          <h3 className="font-semibold text-zinc-950">ConvoyRegistry event</h3>
          {commitAttempt?.transactionLink ? (
            <a
              className="mt-1 block break-all font-mono text-xs text-sky-700 underline"
              href={commitAttempt.transactionLink}
              target="_blank"
              rel="noreferrer"
            >
              {commitAttempt.transactionHash ?? commitAttempt.transactionLink}
            </a>
          ) : (
            <p className="mt-1 text-zinc-700">
              {payloadValue(
                itemEvents.find((event) => event.type === 'ITEM_COMMITTED'),
                'txHash',
              )}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
