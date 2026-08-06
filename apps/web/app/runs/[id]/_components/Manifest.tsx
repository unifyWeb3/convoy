'use client';

import { useState } from 'react';

import type { ManifestDocument } from '@/lib/manifest';

export interface ManifestProps {
  readonly runId: string;
  readonly initialManifest?: ManifestDocument | null;
}

export function Manifest({ runId, initialManifest = null }: ManifestProps) {
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
    <section aria-labelledby="manifest-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="manifest-heading" className="text-lg font-semibold text-zinc-950">
            Manifest
          </h2>
          {manifest !== null ? (
            <p className="font-mono text-xs text-zinc-500">{manifest.sha256}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyJson}
            disabled={busy}
            className="h-9 border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-800 disabled:opacity-50"
          >
            Copy JSON
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={busy}
            className="h-9 bg-zinc-950 px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            Download JSON
          </button>
        </div>
      </div>

      {message !== null ? (
        <p role="status" className="text-sm text-zinc-600">
          {message}
        </p>
      ) : null}

      {manifest === null ? (
        <p className="text-sm text-zinc-600">
          {busy ? 'Exporting...' : 'Export is ready after sealing.'}
        </p>
      ) : (
        <div className="overflow-x-auto border border-zinc-200">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">KeeperHub</th>
                <th className="px-3 py-2">Registry</th>
                <th className="px-3 py-2">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {manifest.reconciliation.rows.map((row) => (
                <tr key={row.idx} className="border-t border-zinc-200 align-top">
                  <td className="px-3 py-3 font-mono">
                    <span
                      className={
                        row.verdict === 'green'
                          ? 'text-emerald-700'
                          : 'font-semibold text-amber-700'
                      }
                    >
                      {row.verdict}
                    </span>{' '}
                    #{row.idx}
                  </td>
                  <td className="px-3 py-3 text-zinc-700">
                    {row.keeperHub.executions.at(-1)?.status ??
                      row.keeperHub.commit?.status ??
                      'no execution'}
                  </td>
                  <td className="px-3 py-3 text-zinc-700">
                    {row.registry.error ??
                      (row.registry.committedInStorage === true ? 'committed' : 'not committed')}
                  </td>
                  <td className="px-3 py-3 text-zinc-700">{row.ledger.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
