// @convoy/worker — BullMQ worker bootstrap.
//
// Runs OFF Vercel (Vercel cannot host long-lived processes). Handles SIGTERM by
// calling worker.close() so in-flight jobs drain rather than being abandoned
// mid-execution — an abandoned EXECUTE job is a transaction whose outcome
// nobody recorded.

import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';

import {
  MAX_STALLED_COUNT,
  QUEUE_NAME,
  SHUTDOWN_GRACE_MS,
  STALLED_INTERVAL_MS,
  WORKER_CONCURRENCY,
} from './config.js';
import { createConnection, type ConvoyJobData, type Phase } from './queue.js';
import { handlePlan } from './handlers/plan.js';
import { handleCritique } from './handlers/critique.js';
import { handleExecute } from './handlers/execute.js';
import { handleSeal } from './handlers/seal.js';
import type { HandlerResult, PhaseHandler } from './handlers/types.js';

const HANDLERS: Record<Phase, PhaseHandler> = {
  plan: handlePlan,
  critique: handleCritique,
  execute: handleExecute,
  seal: handleSeal,
};

export interface CreateWorkerOptions {
  readonly connection: IORedis;
  readonly concurrency?: number;
  /** Cooperative abort shared by every in-flight handler. */
  readonly abortController?: AbortController;
  readonly log?: (message: string) => void;
  /** Test seam: replaces the phase handlers. */
  readonly handlers?: Partial<Record<Phase, PhaseHandler>>;
}

export function createWorker(options: CreateWorkerOptions): Worker<ConvoyJobData, HandlerResult> {
  const log = options.log ?? ((m: string): void => console.log(m));
  const controller = options.abortController ?? new AbortController();
  const handlers = { ...HANDLERS, ...options.handlers };

  return new Worker<ConvoyJobData, HandlerResult>(
    QUEUE_NAME,
    async (job: Job<ConvoyJobData>): Promise<HandlerResult> => {
      const handler = handlers[job.data.phase];
      if (handler === undefined) {
        throw new Error(`unknown phase ${JSON.stringify(job.data.phase)}`);
      }
      return await handler({
        data: job.data,
        signal: controller.signal,
        log: (m) => {
          log(`[${job.id ?? '?'}] ${m}`);
        },
      });
    },
    {
      connection: options.connection,
      // Not 1. See DEC-002 — EXECUTE must be able to fan out so KeeperHub's
      // sequential nonce is what serializes writes.
      concurrency: options.concurrency ?? WORKER_CONCURRENCY,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    },
  );
}

/**
 * Stop accepting new jobs and wait for the in-flight ones.
 *
 * `worker.close()` with no argument is the graceful path: BullMQ stops fetching
 * and waits for running handlers. The abort signal fires first so cooperative
 * handlers can wind down rather than being cut off mid-await.
 */
export async function shutdown(
  worker: Worker<ConvoyJobData, HandlerResult>,
  controller: AbortController,
  log: (message: string) => void = console.log,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<void> {
  log('SIGTERM — draining in-flight jobs, not accepting new ones');
  controller.abort();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, graceMs);
  });

  const result = await Promise.race([worker.close().then(() => 'closed' as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (result === 'timeout') {
    // Never claim a clean drain that did not happen. A job still running here is
    // re-picked as stalled (gap G-26), and its idempotency key makes the re-run
    // safe — but that is recovery, not a graceful shutdown.
    log(`drain exceeded ${graceMs}ms — forcing close; stalled jobs will be re-picked`);
    await worker.close(true);
  } else {
    log('drained cleanly');
  }
}

export async function main(): Promise<void> {
  const connection = createConnection();
  const controller = new AbortController();
  const worker = createWorker({ connection, abortController: controller });

  worker.on('completed', (job, result) => {
    console.log(`[${job.id ?? '?'}] ${result.outcome}: ${result.detail}`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[${job?.id ?? '?'}] failed: ${err.message}`);
  });

  console.log(
    `convoy worker up — queue=${QUEUE_NAME} concurrency=${WORKER_CONCURRENCY} ` +
      `stalledInterval=${STALLED_INTERVAL_MS}ms`,
  );

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown(worker, controller)
        .then(async () => connection.quit())
        .then(() => {
          process.exit(0);
        })
        .catch((e: unknown) => {
          console.error(e);
          process.exit(1);
        });
    });
  }

  await Promise.resolve();
}

/** Run only when executed directly, so tests can import the factories. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) void main();
