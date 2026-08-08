// @convoy/kh-client — error classification
//
// Every KeeperHub failure is sorted into exactly one of four classes. The class
// decides what the orchestrator does, so a misclassification is a reliability
// bug, not a cosmetic one.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

/**
 * - `fatal`         — the credential itself is bad. Stop everything.
 * - `fatal-to-run`  — this run cannot proceed (daily cap, wallet unconfigured).
 * - `transient`     — retry with jittered backoff. Convoy's OWN retry of its own
 *                     request; never an onchain retry, which belongs to KeeperHub.
 * - `item-failed`   — a real, permanent answer about this item. Never retried.
 */
export type KhErrorClass = 'fatal' | 'fatal-to-run' | 'transient' | 'item-failed';

/** Coded run errors documented as transient: E-000x / N-000x / P-000x / C-0001-2. */
const CODED_RUN_ERROR = /\b((?:[ENP]-\d{4}|C-000[12]))\b/;

/**
 * Find a documented transient code in either an HTTP error body or a status
 * record. Status failures arrive on HTTP 200, so recovery cannot rely on the
 * HTTP classifier alone.
 */
export function transientRunErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string') return CODED_RUN_ERROR.exec(value)?.[1];
  if (value === null || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  for (const key of ['code', 'errorCode', 'error', 'message', 'detail', 'revertReason']) {
    const found = transientRunErrorCode(body[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface KhErrorInit {
  readonly message: string;
  readonly classification: KhErrorClass;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly body?: unknown;
  readonly reason: string;
}

export class KhError extends Error {
  readonly classification: KhErrorClass;
  readonly httpStatus: number | undefined;
  /** Coded run error (`E-0002`) when present. */
  readonly code: string | undefined;
  /** From `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  readonly body: unknown;
  /** Why this classification was chosen — surfaced in the audit drawer. */
  readonly reason: string;

  constructor(init: KhErrorInit) {
    super(init.message);
    this.name = 'KhError';
    this.classification = init.classification;
    this.httpStatus = init.httpStatus;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
    this.body = init.body;
    this.reason = init.reason;
  }

  get retryable(): boolean {
    return this.classification === 'transient';
  }
}

/** Pull a human message out of whatever shape the API returned. */
export function extractMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const k of ['error', 'message', 'revertReason', 'detail']) {
      const v = o[k];
      if (typeof v === 'string' && v !== '') return v;
    }
  }
  return '';
}

/** `Retry-After` is seconds or an HTTP date. Returns milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export interface ClassifyInput {
  readonly httpStatus: number;
  readonly body: unknown;
  readonly headers?: { get(name: string): string | null };
  readonly nowMs?: number;
}

/**
 * Sort one failed KeeperHub response into a class.
 *
 * Not called for a simulate that returns `wouldRevert:true` — that is a
 * successful simulate on HTTP 400, and `contractCall.ts` intercepts it before
 * reaching here. See docs/KNOWN_GAPS.md G-21.
 */
export function classifyHttpError(input: ClassifyInput): KhError {
  const { httpStatus, body } = input;
  const nowMs = input.nowMs ?? Date.now();
  const message = extractMessage(body);
  const retryAfterMs = parseRetryAfter(input.headers?.get('retry-after') ?? null, nowMs);
  const coded = transientRunErrorCode(body) ?? transientRunErrorCode(message);

  const mk = (classification: KhErrorClass, reason: string): KhError =>
    new KhError({
      message: message === '' ? `KeeperHub HTTP ${httpStatus}` : message,
      classification,
      httpStatus,
      code: coded,
      retryAfterMs,
      body,
      reason,
    });

  // A coded run error is transient wherever it appears — the code is the signal,
  // not the status. Checked first so it cannot be shadowed by a status rule.
  if (coded !== undefined) {
    return mk('transient', `coded run error ${coded} is documented transient`);
  }

  if (httpStatus === 401) {
    return mk('fatal', '401 — the API key itself is rejected; retrying cannot help');
  }
  if (httpStatus === 403) {
    return mk('fatal-to-run', '403 — daily spending cap exceeded (gap G-03); fatal to this run');
  }
  if (httpStatus === 422) {
    return mk('fatal-to-run', '422 — org wallet not configured (gap G-03); fatal to this run');
  }
  if (httpStatus === 429) {
    return mk('transient', '429 — rate limited; back off and honour Retry-After');
  }
  if (httpStatus === 409) {
    // Two different 409s with opposite handling.
    if (/in[_\s-]?progress/i.test(message)) {
      return mk('transient', '409 idempotency_in_progress — the same key is mid-flight; retry');
    }
    return mk(
      'item-failed',
      '409 idempotency_conflict — the same key was reused with a different body. ' +
        'That is a Convoy bug, not an API fault; fail the item rather than retrying',
    );
  }
  if (httpStatus >= 500) {
    return mk(
      'transient',
      `${httpStatus} — server-side; retried with backoff. Note an unsupported chain also ` +
        'returns 500 with an empty body (gap G-22), which is why the chain id is validated ' +
        'client-side before the request is ever sent',
    );
  }
  if (httpStatus === 400 || httpStatus === 404) {
    // A full message with no code is a config-revert: a real, permanent answer.
    return mk(
      'item-failed',
      `${httpStatus} with a full message and no error code — config-revert; the item is FAILED ` +
        'and is never retried',
    );
  }
  return mk('item-failed', `unmapped HTTP ${httpStatus}; treated as permanent rather than retried`);
}

/** Convoy's own faults — DNS, socket, timeout. Always transient. */
export function classifyTransportError(cause: unknown): KhError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new KhError({
    message,
    classification: 'transient',
    body: undefined,
    reason: "transport failure reaching KeeperHub — Convoy's own fault, retried with backoff",
  });
}
