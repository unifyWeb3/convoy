'use client';

import { useEffect, useState } from 'react';

import type { ManifestDocument, ManifestRow } from '@/lib/manifest';

import { recordedText, StateChip } from './RunBoardPrimitives';

export interface ManifestProps {
  readonly runId: string;
  readonly initialManifest?: ManifestDocument | null;
  readonly runStatus?: string;
}

const TERMINAL = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);

function terminalLabel(status: string | undefined): string {
  if (status === 'SEALED_OK') return 'SEALED OK';
  if (status === 'SEALED_PARTIAL') return 'SEALED PARTIAL';
  return status === undefined ? 'not recorded' : status.replace(/_/g, ' ');
}

function keeperHubCell(row: ManifestRow): string {
  const latest = row.keeperHub.executions.at(-1) ?? row.keeperHub.commit;
  if (latest === null) return 'not recorded';
  if (latest.error !== null) {
    return latest.status === null ? latest.error : `${latest.status}: ${latest.error}`;
  }
  if (latest.status !== null) return latest.status;
  return latest.available ? 'not recorded' : 'unavailable';
}

function registryCell(row: ManifestRow): string {
  if (row.registry.error !== null) return row.registry.error;
  if (row.registry.committedInStorage === true) return 'committed';
  if (row.registry.committedInStorage === false) return 'not committed';
  if (row.registry.available === false) return 'unavailable';
  return 'not recorded';
}

export function Manifest({ runId, initialManifest = null, runStatus }: ManifestProps) {
  const [manifest, setManifest] = useState<ManifestDocument | null>(initialManifest);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isTerminal = runStatus === undefined || TERMINAL.has(runStatus);

  useEffect(() => {
    if (!isTerminal || manifest !== null) return;

    const controller = new AbortController();
    let active = true;
    setBusy(true);
    setMessage(null);

    void (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/manifest`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('manifest request failed');
        const document = (await response.json()) as ManifestDocument;
        if (active) setManifest(document);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) {
          setMessage('Manifest could not be loaded.');
        }
      } finally {
        if (active) setBusy(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [isTerminal, manifest, runId]);

  async function copyJson(): Promise<void> {
    if (manifest === null) {
      setMessage('Manifest is not available yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
      setMessage('Copied');
    } catch {
      setMessage('Copy unavailable. Use Download JSON.');
    }
  }

  async function downloadJson(): Promise<void> {
    if (manifest === null) {
      setMessage('Manifest is not available yet.');
      return;
    }
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `convoy-manifest-${runId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Downloaded');
    } catch {
      setMessage('Download failed. Try again.');
    }
  }

  return (
    <section aria-busy={busy} aria-labelledby="manifest-heading" className="space-y-7">
      <div className="grid gap-5 border-b border-[var(--convoy-rule)] pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
            Final proof package
          </p>
          <h2
            id="manifest-heading"
            className="font-convoy-display mt-2 text-3xl text-[var(--convoy-ink-soft)] sm:text-4xl"
          >
            Proof manifest
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--convoy-text-body)]">
            Replay inputs plus reconciliation of KeeperHub status, the ConvoyRegistry, and the
            append-only ledger.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runStatus !== undefined ? <StateChip state={runStatus} /> : null}
          <button
            type="button"
            onClick={copyJson}
            disabled={busy || !isTerminal || manifest === null}
            className="min-h-11 border border-[var(--convoy-rule-strong)] bg-white px-4 text-sm font-medium text-[var(--convoy-ink-soft)] hover:border-[var(--convoy-border-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Copy JSON
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={busy || !isTerminal || manifest === null}
            className="min-h-11 bg-[var(--convoy-green-dark)] px-4 text-sm font-medium text-white hover:bg-[var(--convoy-green-press)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download JSON
          </button>
        </div>
      </div>

      {message !== null ? (
        <p
          role="status"
          className="border-l-2 border-[var(--convoy-green-dark)] pl-3 text-sm text-[var(--convoy-text-strong)]"
        >
          {message}
        </p>
      ) : null}

      {manifest === null ? (
        <div className="border border-[var(--convoy-border)] bg-white">
          <div className="grid gap-px bg-[var(--convoy-border)] md:grid-cols-3">
            {[
              ['KeeperHub', 'Direct execution IDs, statuses, transaction links, and gas evidence.'],
              [
                'ConvoyRegistry',
                'Onchain commitments and the final run seal read from Base Sepolia.',
              ],
              [
                'Ledger',
                'Plan, evidence, attempts, dependencies, events, and terminal item states.',
              ],
            ].map(([source, detail]) => (
              <div key={source} className="bg-white p-5">
                <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[var(--convoy-green-dark)]">
                  {source}
                </p>
                <p className="mt-3 text-sm leading-6 text-[var(--convoy-text-body)]">{detail}</p>
              </div>
            ))}
          </div>
          <div className="border-t border-[var(--convoy-border)] bg-[var(--convoy-cream)] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--text-label)]">
              {busy ? 'Export in progress' : `Run state: ${terminalLabel(runStatus)}`}
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-body)]">
              {busy
                ? 'Reconciling the terminal record…'
                : runStatus !== undefined && !TERMINAL.has(runStatus)
                  ? 'The proof manifest is not authoritative until the run reaches a terminal state.'
                  : 'The manifest is available after the terminal record can be reconciled.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <section className="border border-[var(--convoy-border)] bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--text-label)]">
                  Overall verdict
                </p>
                <span
                  className={`convoy-state-chip ${
                    manifest.reconciliation.verdict === 'green'
                      ? 'convoy-state-role-success'
                      : 'convoy-state-role-deferred'
                  }`}
                >
                  {manifest.reconciliation.verdict.toUpperCase()}
                </span>
              </div>
              <p className="mt-4 text-sm leading-6 text-[var(--convoy-text-body)]">
                {manifest.reconciliation.verdict === 'green'
                  ? 'All recorded reconciliation checks agree.'
                  : 'At least one source is unavailable or disagrees; the amber result is preserved.'}
              </p>
              <dl className="mt-5 grid gap-3 border-t border-[var(--convoy-hairline)] pt-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                    Run status
                  </dt>
                  <dd className="mt-1 text-[var(--convoy-text-deep)]">
                    {terminalLabel(runStatus ?? manifest.run.status)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text-label)]">
                    Sealed at
                  </dt>
                  <dd className="convoy-proof-value mt-1 break-all text-[var(--convoy-text-deep)]">
                    {recordedText(manifest.run.sealedAt)}
                  </dd>
                </div>
              </dl>
            </section>
            <section className="bg-[var(--convoy-dark)] p-5 text-white sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--convoy-on-dark-muted)]">
                  Canonical SHA-256
                </p>
                <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--convoy-on-dark-green)]">
                  {terminalLabel(manifest.run.status)}
                </span>
              </div>
              <p className="convoy-proof-value mt-3 break-all font-mono text-[10px] leading-5 text-[var(--convoy-on-dark-green)]">
                {manifest.sha256}
              </p>
              <p className="mt-4 text-xs leading-5 text-[var(--convoy-on-dark-body)]">
                The digest covers the ordered ledger, attempts, and reconciliation rows.
              </p>
            </section>
          </div>

          <section aria-labelledby="manifest-reconciliation-heading" className="space-y-4">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-label)]">
                Reconciliation
              </p>
              <h3
                id="manifest-reconciliation-heading"
                className="font-convoy-display mt-2 text-2xl text-[var(--convoy-ink-soft)] sm:text-3xl"
              >
                Three sources, checked row by row
              </h3>
              <p className="mt-2 text-sm leading-6 text-[var(--convoy-text-body)]">
                A row is green only when KeeperHub, the registry, and the ledger agree.
              </p>
            </div>
            <div className="overflow-x-auto border border-[var(--convoy-border)] bg-white">
              <table className="min-w-[680px] table-fixed border-collapse text-left text-sm">
                <thead className="bg-[var(--convoy-cream)] font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-label)]">
                  <tr>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">KeeperHub</th>
                    <th className="px-4 py-3">Registry</th>
                    <th className="px-4 py-3">Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.reconciliation.rows.map((row) => (
                    <tr key={row.idx} className="border-t border-[var(--convoy-border)] align-top">
                      <td className="px-4 py-4 font-mono text-[10px]">
                        <span
                          className={
                            row.verdict === 'green'
                              ? 'text-[var(--verdict-green)]'
                              : 'font-semibold text-[var(--state-deferred-fg)]'
                          }
                        >
                          {row.verdict.toUpperCase()}
                        </span>{' '}
                        #{row.idx + 1}
                      </td>
                      <td className="convoy-proof-value px-4 py-4 text-[var(--convoy-text-strong)]">
                        {keeperHubCell(row)}
                      </td>
                      <td className="convoy-proof-value px-4 py-4 text-[var(--convoy-text-strong)]">
                        {registryCell(row)}
                      </td>
                      <td className="convoy-proof-value px-4 py-4 text-[var(--convoy-text-strong)]">
                        {recordedText(row.ledger.state, 'unavailable')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
