/**
 * Graceful shutdown and the enqueue → handler → complete path, against a real
 * BullMQ worker and a real Redis.
 *
 * "In-flight jobs drain" is a claim about what BullMQ does when close() is
 * called while a handler is mid-await. Only a real worker can be wrong about it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { EXECUTE_FANOUT, WORKER_CONCURRENCY } from '../src/config.js';
import { createConnection, createQueue, enqueue, type ConvoyJobData } from '../src/queue.js';
import { createWorker, shutdown } from '../src/index.js';
import type { HandlerResult } from '../src/handlers/types.js';

let connection: IORedis;
let queue: Queue<ConvoyJobData>;

beforeAll(() => {
  connection = createConnection();
  queue = createQueue(connection);
});

afterEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await connection.quit();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('enqueue → handler → complete', () => {
  it('runs the handler for the enqueued phase and completes', async () => {
    const seen: ConvoyJobData[] = [];
    const worker = createWorker({
      connection: createConnection(),
      concurrency: 1,
      log: () => {},
      handlers: {
        execute: async (ctx): Promise<HandlerResult> => {
          seen.push(ctx.data);
          return await Promise.resolve({ outcome: 'done', detail: 'ok' });
        },
      },
    });

    const done = new Promise<void>((resolve) =>
      worker.once('completed', () => {
        resolve();
      }),
    );
    await enqueue(queue, { runId: 'run_ok', itemIdx: 2, phase: 'execute' });
    await done;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId: 'run_ok', itemIdx: 2, phase: 'execute', attempt: 0 });
    await worker.close();
  });

  it('a duplicate jobId does not run the handler twice', async () => {
    let runs = 0;
    const worker = createWorker({
      connection: createConnection(),
      concurrency: 1,
      log: () => {},
      handlers: {
        execute: async (): Promise<HandlerResult> => {
          runs += 1;
          return await Promise.resolve({ outcome: 'done', detail: 'ok' });
        },
      },
    });

    const key = { runId: 'run_dupe', itemIdx: 0, phase: 'execute' } as const;
    const done = new Promise<void>((resolve) =>
      worker.once('completed', () => {
        resolve();
      }),
    );
    await enqueue(queue, key);
    await done;

    // Re-enqueue the identical key after it has already completed. Completed
    // jobs are kept (removeOnComplete: false), so the id is still taken.
    await enqueue(queue, key);
    await sleep(500);

    expect(runs).toBe(1);
    await worker.close();
  });
});

describe('SIGTERM drains in-flight jobs', () => {
  it('a running handler is allowed to finish before close resolves', async () => {
    let finished = false;
    let started = false;

    const worker = createWorker({
      connection: createConnection(),
      concurrency: 1,
      log: () => {},
      handlers: {
        execute: async (): Promise<HandlerResult> => {
          started = true;
          await sleep(1_200);
          finished = true;
          return { outcome: 'done', detail: 'drained' };
        },
      },
    });

    await enqueue(queue, { runId: 'run_drain', itemIdx: 0, phase: 'execute' });
    while (!started) await sleep(25);

    const controller = new AbortController();
    await shutdown(worker, controller, () => {}, 10_000);

    // The whole point: close() waited rather than abandoning the handler.
    expect(finished).toBe(true);
  });

  it('fires the abort signal so cooperative handlers can wind down', async () => {
    let sawAbort = false;
    let started = false;

    const controller = new AbortController();
    const worker = createWorker({
      connection: createConnection(),
      concurrency: 1,
      abortController: controller,
      log: () => {},
      handlers: {
        execute: async (ctx): Promise<HandlerResult> => {
          started = true;
          for (let i = 0; i < 40; i += 1) {
            await sleep(50);
            if (ctx.signal.aborted) {
              sawAbort = true;
              break;
            }
          }
          return { outcome: 'done', detail: sawAbort ? 'aborted' : 'ran to completion' };
        },
      },
    });

    await enqueue(queue, { runId: 'run_abort', itemIdx: 0, phase: 'execute' });
    while (!started) await sleep(25);

    await shutdown(worker, controller, () => {}, 10_000);
    expect(sawAbort).toBe(true);
  });

  it('reports a forced close honestly rather than claiming a clean drain', async () => {
    const logs: string[] = [];
    let started = false;

    const worker = createWorker({
      connection: createConnection(),
      concurrency: 1,
      log: () => {},
      handlers: {
        // Ignores the abort signal on purpose — models a handler stuck in a
        // call it cannot interrupt.
        execute: async (): Promise<HandlerResult> => {
          started = true;
          await sleep(4_000);
          return { outcome: 'done', detail: 'late' };
        },
      },
    });

    await enqueue(queue, { runId: 'run_force', itemIdx: 0, phase: 'execute' });
    while (!started) await sleep(25);

    await shutdown(worker, new AbortController(), (m) => logs.push(m), 300);

    expect(logs.some((l) => /drain exceeded/.test(l))).toBe(true);
    expect(logs.some((l) => /drained cleanly/.test(l))).toBe(false);
  });
});

describe('safe execution fanout', () => {
  it('defaults to one unless an explicit measurement override is configured', () => {
    expect(EXECUTE_FANOUT).toBe(1);
  });

  it('WORKER_CONCURRENCY never falls below EXECUTE_FANOUT', () => {
    // A worker narrower than the fan-out silently re-serializes dispatch, which
    // is the exact bug DEC-002 exists to prevent — and it would look fine.
    expect(WORKER_CONCURRENCY).toBeGreaterThanOrEqual(EXECUTE_FANOUT);
  });

  it('a worker actually runs EXECUTE_FANOUT handlers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const worker = createWorker({
      connection: createConnection(),
      concurrency: EXECUTE_FANOUT,
      log: () => {},
      handlers: {
        execute: async (): Promise<HandlerResult> => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(400);
          inFlight -= 1;
          return { outcome: 'done', detail: 'ok' };
        },
      },
    });

    const total = EXECUTE_FANOUT * 2;
    for (let i = 0; i < total; i += 1) {
      await enqueue(queue, { runId: 'run_fanout', itemIdx: i, phase: 'execute' });
    }

    let completed = 0;
    await new Promise<void>((resolve) => {
      worker.on('completed', () => {
        completed += 1;
        if (completed === total) resolve();
      });
    });

    // Concurrent dispatch, genuinely observed — not asserted from config.
    expect(peak).toBe(EXECUTE_FANOUT);
    await worker.close();
  });
});
