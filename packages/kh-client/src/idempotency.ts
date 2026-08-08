// @convoy/kh-client — idempotency keys
//
// Format: `<runId>:<idx>:<attempt>` — per-org, 24h window. Simulate calls are
// EXEMPT: a simulate signs nothing, broadcasts nothing and creates no audit row,
// so giving it a key would burn one for a call that changed no state.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import type { AttemptRef } from './types.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export type IdempotencyPhase = 'o' | 'c' | 'x' | 's';

export function foldRunIdForPhase(runId: string, phase: IdempotencyPhase): string {
  if (runId === '') throw new Error('idempotency: runId must not be empty');
  return `${runId.slice(0, 8)}-${phase}`;
}

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

/**
 * Build Convoy's phase-folded key without changing the frozen three-part
 * `<runId>:<idx>:<attempt>` structure. The eight-character run component is
 * the established G-29 mitigation and is intentionally shared by recovery and
 * the initial submission.
 */
export function buildPhaseIdempotencyKey(
  runId: string,
  phase: IdempotencyPhase,
  idx: number,
  attempt: number,
): string {
  return buildIdempotencyKey({ runId: foldRunIdForPhase(runId, phase), idx, attempt });
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
