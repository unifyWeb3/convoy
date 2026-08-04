// @convoy/kh-client — execution status
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import type { KhClient } from './client.js';
import { isTerminalStatus } from './types.js';
import type { StatusResult, WriteResult } from './types.js';

export const POLL_HINT_HEADER = 'X-Poll-Interval-Hint';

export function statusPath(executionId: string): string {
  return `/api/execute/${encodeURIComponent(executionId)}/status`;
}

/** The hint is in seconds; `0` means terminal. Returns milliseconds. */
export function parsePollHint(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

export async function getExecutionStatus(
  client: KhClient,
  executionId: string,
): Promise<StatusResult> {
  const response = await client.request({
    method: 'GET',
    path: statusPath(executionId),
    tapeKey: `STATUS ${executionId}`,
  });

  const b =
    response.body !== null && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const status = s(b['status']) ?? 'pending';
  const hintMs = parsePollHint(response.headers.get(POLL_HINT_HEADER));

  return {
    executionId,
    status,
    transactionHash: s(b['transactionHash']),
    transactionLink: s(b['transactionLink']),
    gasUsedUnits: s(b['gasUsedWei']),
    gasPriceWei: s(b['gasPriceWei']),
    // A 0 hint is an explicit terminal signal even if the status string lags.
    terminal: isTerminalStatus(status) || hintMs === 0,
    pollIntervalHintMs: hintMs,
    raw: response.body,
  };
}

export interface PollOptions {
  readonly maxPolls?: number;
  readonly defaultIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until terminal, honouring `X-Poll-Interval-Hint`.
 *
 * Short-circuits on an already-terminal write (gap G-02) — but **only when that
 * write actually carries a transaction hash**. Measured against the live API on
 * 2026-08-03, a synchronous write returns `202 {status:"completed"}` with **no**
 * `transactionHash`; the hash appears only on `GET /status` (gap G-23). A
 * short-circuit keyed on terminality alone therefore discards the one field the
 * manifest, the honesty table and the Basescan link all depend on.
 *
 * The architecture's `SUBMITTED → LANDED` guard requires `completed` **and** a
 * non-null `transactionHash`; this function is what supplies the second half.
 */
export async function pollUntilTerminal(
  client: KhClient,
  write: WriteResult,
  options: PollOptions = {},
): Promise<StatusResult> {
  const maxPolls = options.maxPolls ?? 30;
  const defaultIntervalMs = options.defaultIntervalMs ?? 2_000;
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  if (write.terminal && write.transactionHash !== undefined) {
    return {
      executionId: write.executionId,
      status: write.status,
      transactionHash: write.transactionHash,
      transactionLink: write.transactionLink,
      gasUsedUnits: write.gasUsedUnits,
      gasPriceWei: write.gasPriceWei,
      terminal: true,
      raw: write.raw,
    };
  }

  let latest: StatusResult | undefined;
  for (let i = 0; i < maxPolls; i += 1) {
    latest = await getExecutionStatus(client, write.executionId);
    if (latest.terminal) return latest;
    await sleep(latest.pollIntervalHintMs ?? defaultIntervalMs);
  }

  // Never fabricate terminality. A run that did not settle is reported as such.
  throw new Error(
    `status poll for ${write.executionId} did not reach a terminal state in ${maxPolls} polls ` +
      `(last status: ${latest?.status ?? 'unknown'})`,
  );
}
