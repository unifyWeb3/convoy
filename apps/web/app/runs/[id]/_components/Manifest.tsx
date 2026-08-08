'use client';

import { useState } from 'react';

import type { ManifestDocument } from '@/lib/manifest';

export interface ManifestProps {
  readonly runId: string;
  readonly initialManifest?: ManifestDocument | null;
  readonly runStatus?: string;
}

const TERMINAL = new Set(['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL']);

export function Manifest({ runId, initialManifest = null, runStatus }: ManifestProps) {
  const [manifest, setManifest] = useState<ManifestDocument | null>(initialManifest);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadManifest(): Promise<ManifestDocument> {
    if (manifest !== null) return manifest;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/manifest`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Manifest export failed (${response.status})`);
      const document = (await response.json()) as ManifestDocument;
      setManifest(document);
      return document;
    } finally {
      setBusy(false);
    }
  }

  async function copyJson(): Promise<void> {
    try {
      const document = await loadManifest();
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      setMessage('Copied');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Copy failed');
    }
  }

  async function downloadJson(): Promise<void> {
    try {
      const manifestDocument = await loadManifest();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(manifestDocument, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `convoy-manifest-${runId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('Downloaded');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Download failed');
    }
  }

  return (
    <section aria-labelledby="manifest-heading" className="space-y-6">
      <div className="grid gap-5 border-b border-[#D9D9D3] pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7A7A7A]">
            Final proof package
          </p>
          <h2
            id="manifest-heading"
            className="font-convoy-display mt-2 text-3xl text-[#1A1816] sm:text-4xl"
          >
            Proof manifest
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#7A7A7A]">
            Replay inputs plus a three-source reconciliation of KeeperHub status, the
            ConvoyRegistry, and Convoy&apos;s append-only ledger.
          </p>
          {manifest !== null ? (
            <div className="mt-5 bg-[#2B2825] p-4 text-white">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#B9B3AC]">
                Canonical SHA-256
              </p>
              <p className="mt-2 break-all font-mono text-[10px] text-[#87F1C1]">
                {manifest.sha256}
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={copyJson}
            disabled={busy}
            className="h-10 border border-[#CFCFC8] bg-white px-4 text-sm font-medium text-[#1A1816] hover:border-[#7A7A7A] disabled:opacity-50"
          >
            Copy JSON
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={busy}
            className="h-10 bg-[#007D4D] px-4 text-sm font-medium text-white hover:bg-[#00673F] disabled:opacity-50"
          >
            Download JSON
          </button>
        </div>
      </div>

      {message !== null ? (
        <p role="status" className="border-l-2 border-[#00C274] pl-3 text-sm text-[#4F4B47]">
          {message}
        </p>
      ) : null}

      {manifest === null ? (
        <div className="grid gap-px border border-[#E5E5E0] bg-[#E5E5E0] md:grid-cols-3">
          {[
            ['KeeperHub', 'Direct execution IDs, statuses, transaction links, and gas evidence.'],
            [
              'ConvoyRegistry',
              'Onchain commitments and the final run seal read from Base Sepolia.',
            ],
            ['Ledger', 'Plan, evidence, attempts, dependencies, events, and terminal item states.'],
          ].map(([source, detail]) => (
            <div key={source} className="bg-white p-5">
              <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#007D4D]">
                {source}
              </p>
              <p className="mt-3 text-sm leading-6 text-[#68645F]">{detail}</p>
            </div>
          ))}
          <p className="bg-[#F7F7F2] p-4 text-sm text-[#68645F] md:col-span-3">
            {busy
              ? 'Exporting and reconciling the terminal record…'
              : runStatus !== undefined && TERMINAL.has(runStatus)
                ? 'This run is terminal. Copy or download the replayable proof package.'
                : 'The manifest becomes authoritative after the run reaches a terminal state.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#E5E5E0] bg-white">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="bg-[#F7F7F2] font-mono text-[9px] uppercase tracking-[0.14em] text-[#7A7A7A]">
              <tr>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">KeeperHub</th>
                <th className="px-4 py-3">Registry</th>
                <th className="px-4 py-3">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {manifest.reconciliation.rows.map((row) => (
                <tr key={row.idx} className="border-t border-[#E5E5E0] align-top">
                  <td className="px-4 py-4 font-mono text-[10px]">
                    <span
                      className={
                        row.verdict === 'green' ? 'text-[#007D4D]' : 'font-semibold text-[#9A6500]'
                      }
                    >
                      {row.verdict.toUpperCase()}
                    </span>{' '}
                    #{row.idx}
                  </td>
                  <td className="px-4 py-4 text-[#4F4B47]">
                    {row.keeperHub.executions.at(-1)?.status ??
                      row.keeperHub.commit?.status ??
                      'no execution'}
                  </td>
                  <td className="px-4 py-4 text-[#4F4B47]">
                    {row.registry.error ??
                      (row.registry.committedInStorage === true ? 'committed' : 'not committed')}
                  </td>
                  <td className="px-4 py-4 text-[#4F4B47]">{row.ledger.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
