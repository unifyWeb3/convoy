// Queue, Redis connection and job-id scheme.
//
// One queue. `jobId = runId:phase:itemIdx` so a duplicate enqueue does not
// double-run.
//
// NOTE on concurrency: this file does NOT serialize submissions. Run-level phase
// orchestration is serial, but EXECUTE dispatch fans out — see DEC-002 and
// `config.ts`. KeeperHub's sequential nonce is what serializes writes, and that
// contention is the point rather than something to avoid.

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

import { JOB_ATTEMPTS, JOB_BACKOFF_MS, QUEUE_NAME, redisUrl } from './config.js';

/** The four phases of a run, in the order the state machine advances them. */
export const PHASES = ['plan', 'critique', 'execute', 'seal'] as const;
export type Phase = (typeof PHASES)[number];

/** Phases that operate on the run as a whole rather than one item. */
const RUN_LEVEL_PHASES: readonly Phase[] = ['plan', 'seal'];

/**
 * Job payload.
 *
 * `attempt` is fixed here, at enqueue time, and is NEVER recomputed inside a
 * handler (DEC-003). It feeds `Idempotency-Key: <runId>:<idx>:<attempt>`. A
 * stalled job re-picked by BullMQ carries byte-identical data, so it produces
 * the identical key and KeeperHub collapses it to one execution rather than
 * submitting twice (gap G-26). Deriving it from a row count or from
 * `job.attemptsMade` — which BullMQ increments on stall — would turn the safety
 * mechanism into a double-spend.
 */
export interface ConvoyJobData {
  readonly runId: string;
  /** Null for run-level phases (`plan`, `seal`). */
  readonly itemIdx: number | null;
  readonly phase: Phase;
  readonly attempt: number;
}

/** The idempotency triple that keys a handler. */
export interface HandlerKey {
  readonly runId: string;
  readonly itemIdx: number | null;
  readonly phase: Phase;
}

export function isItemPhase(phase: Phase): boolean {
  return !RUN_LEVEL_PHASES.includes(phase);
}

/**
 * `runId:phase:itemIdx`, with `-` for run-level phases.
 *
 * Deliberately excludes `attempt`: the id identifies the *unit of work*, so a
 * duplicate enqueue of the same work is dropped by BullMQ. A genuine Convoy-side
 * retry is different work with a different attempt number and is enqueued with
 * `enqueueRetry`, which appends the attempt so it gets its own id and its own
 * idempotency key.
 */
export function buildJobId(key: HandlerKey): string {
  // Two colons is BullMQ's hard limit for a custom job id (gap G-27), and the
  // triple below uses both. A runId carrying one would push the id over.
  if (key.runId.includes(':') || key.runId.includes('#')) {
    throw new Error(`runId must not contain ":" or "#" (got ${JSON.stringify(key.runId)})`);
  }
  if (isItemPhase(key.phase) && key.itemIdx === null) {
    throw new Error(`phase ${key.phase} is item-scoped and requires an itemIdx`);
  }
  if (!isItemPhase(key.phase) && key.itemIdx !== null) {
    throw new Error(`phase ${key.phase} is run-scoped and must not carry an itemIdx`);
  }
  return `${key.runId}:${key.phase}:${key.itemIdx ?? '-'}`;
}

/**
 * A retry's job id: the base id with `#<attempt>` appended.
 *
 * `#` and not `:` — **BullMQ 6 rejects a custom job id containing more than two
 * colons** (`Custom Id cannot contain :`), and `runId:phase:itemIdx` already
 * uses both. Measured, not assumed: `a:b:0` is accepted, `a:b:0:1` is rejected,
 * `a:b:0#1` is accepted. See gap G-27 — any future extension of this id must
 * not add a third colon either.
 */
export function retryJobId(key: HandlerKey, attempt: number): string {
  return `${buildJobId(key)}#${attempt}`;
}

/** BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on. */
export function createConnection(url = redisUrl()): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
  // Completed and failed jobs are KEPT. BullMQ frees a jobId once the job is
  // removed, so removing on completion would silently break the dedupe
  // guarantee: re-enqueueing the same jobId afterwards would run it again. A
  // run is ~12 items; keeping them costs almost nothing and keeps
  // "a duplicate jobId does not double-run" true for the whole run.
  removeOnComplete: false,
  removeOnFail: false,
};

export function createQueue(connection: ConnectionOptions): Queue<ConvoyJobData> {
  return new Queue<ConvoyJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/** Enqueue one unit of work. A second call with the same key is a no-op. */
export async function enqueue(
  queue: Queue<ConvoyJobData>,
  key: HandlerKey,
  attempt = 0,
): Promise<string> {
  const jobId = buildJobId(key);
  await queue.add(
    key.phase,
    { runId: key.runId, itemIdx: key.itemIdx, phase: key.phase, attempt },
    { jobId },
  );
  return jobId;
}

/**
 * Enqueue a Convoy-side retry: new attempt number, new job id, new idempotency
 * key. Only for Convoy's own faults — onchain retries belong to KeeperHub and
 * are observed, never performed here.
 */
export async function enqueueRetry(
  queue: Queue<ConvoyJobData>,
  key: HandlerKey,
  attempt: number,
): Promise<string> {
  if (attempt < 1) throw new Error('a retry must have attempt >= 1');
  const jobId = retryJobId(key, attempt);
  await queue.add(
    key.phase,
    { runId: key.runId, itemIdx: key.itemIdx, phase: key.phase, attempt },
    { jobId },
  );
  return jobId;
}
