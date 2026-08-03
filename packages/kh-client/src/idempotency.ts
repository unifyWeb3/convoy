// @convoy/kh-client — idempotency keys
//
// Format: `<runId>:<idx>:<attempt>` — per-org, 24h window. Simulate calls are
// EXEMPT: a simulate signs nothing, broadcasts nothing and creates no audit row,
// so giving it a key would burn one for a call that changed no state.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import type { AttemptRef } from './types.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** `runId` must not contain the separator, or keys become ambiguous. */
export function buildIdempotencyKey(ref: AttemptRef): string {
  const { runId, idx, attempt } = ref;
  if (runId === '') throw new Error('idempotency: runId must not be empty');
  if (runId.includes(':')) {
    throw new Error(`idempotency: runId must not contain ":" (got ${JSON.stringify(runId)})`);
  }
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`idempotency: idx must be a non-negative integer (got ${String(idx)})`);
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`idempotency: attempt must be a non-negative integer (got ${String(attempt)})`);
  }
  return `${runId}:${idx}:${attempt}`;
}

/** Inverse of {@link buildIdempotencyKey}; used by the manifest reconciler. */
export function parseIdempotencyKey(key: string): AttemptRef {
  const parts = key.split(':');
  if (parts.length !== 3) {
    throw new Error(`idempotency: malformed key ${JSON.stringify(key)}`);
  }
  const [runId, idxRaw, attemptRaw] = parts as [string, string, string];
  const idx = Number(idxRaw);
  const attempt = Number(attemptRaw);
  if (!Number.isInteger(idx) || !Number.isInteger(attempt)) {
    throw new Error(`idempotency: malformed key ${JSON.stringify(key)}`);
  }
  return { runId, idx, attempt };
}
