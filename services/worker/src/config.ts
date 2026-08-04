// @convoy/worker — queue and worker configuration.
//
// Every value here is a named constant with a documented default, because each
// one is a decision someone will need to revisit with a reason.

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

export const QUEUE_NAME = 'convoy';

/**
 * How many ready items one run's EXECUTE phase dispatches concurrently.
 *
 * **This must never be 1.** See DEC-002. `docs/ARCHITECTURE.md` requires Convoy
 * to submit concurrently against the single org wallet so that KeeperHub's
 * sequential-nonce manager is what serializes them — that contention is the
 * demo's reliability beat and the deterministic half of backup path d. Submit
 * serially and there is nothing to serialize, and the narration becomes an
 * overclaim.
 *
 * Run-level *phase* orchestration stays serial regardless: PLAN → CRITIQUE →
 * EXECUTE → SEAL, one phase at a time. This governs fan-out inside EXECUTE only.
 *
 * Default 4 is **provisional**, chosen properly at CVY-008 against a real
 * 12-item batch: enough to create genuine nonce contention, comfortably under
 * the observed KeeperHub rate limit (`x-ratelimit-limit: 60`).
 */
export const EXECUTE_FANOUT = intFromEnv('CONVOY_EXECUTE_FANOUT', 4);

/**
 * Jobs this worker processes simultaneously.
 *
 * Clamped to at least EXECUTE_FANOUT: a worker that runs fewer jobs at once than
 * the fan-out asks for silently re-serializes the dispatch, reintroducing the
 * exact bug DEC-002 exists to prevent — and it would do so invisibly, because
 * everything would still "work".
 */
export const WORKER_CONCURRENCY = Math.max(
  intFromEnv('CONVOY_WORKER_CONCURRENCY', 4),
  EXECUTE_FANOUT,
);

/**
 * How long before an unrenewed job lock counts as stalled and the job is
 * re-picked. Set explicitly rather than left at BullMQ's default so the
 * crash-resume test at CVY-015 can reason about the timing (gap G-26).
 */
export const STALLED_INTERVAL_MS = intFromEnv('CONVOY_STALLED_INTERVAL_MS', 30_000);

/** How many times a job may stall before it is failed outright. */
export const MAX_STALLED_COUNT = intFromEnv('CONVOY_MAX_STALLED_COUNT', 1);

/**
 * Convoy's own retries — LLM timeouts, DB blips, network faults — with jittered
 * backoff. **Onchain retries are KeeperHub's and are only observed**, never
 * performed here.
 */
export const JOB_ATTEMPTS = intFromEnv('CONVOY_JOB_ATTEMPTS', 3);
export const JOB_BACKOFF_MS = intFromEnv('CONVOY_JOB_BACKOFF_MS', 1_000);

/** Graceful shutdown: how long in-flight jobs get to drain before we stop waiting. */
export const SHUTDOWN_GRACE_MS = intFromEnv('CONVOY_SHUTDOWN_GRACE_MS', 30_000);

export function redisUrl(): string {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('REDIS_URL is not set — the worker cannot start without a queue backend');
  }
  return url;
}
