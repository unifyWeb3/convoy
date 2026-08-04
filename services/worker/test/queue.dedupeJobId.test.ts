/**
 * Job-id dedupe, against a real Redis. The claim "a duplicate enqueue does not
 * double-run" is about BullMQ's actual behaviour, so a mock would only prove the
 * mock agrees with itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';

import { QUEUE_NAME } from '../src/config.js';
import {
  buildJobId,
  createConnection,
  createQueue,
  enqueue,
  enqueueRetry,
  isItemPhase,
  retryJobId,
  type ConvoyJobData,
} from '../src/queue.js';

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

const RUN = 'run_dedupe_1';

describe('buildJobId', () => {
  it('is runId:phase:itemIdx', () => {
    expect(buildJobId({ runId: RUN, itemIdx: 3, phase: 'execute' })).toBe('run_dedupe_1:execute:3');
  });

  it('uses "-" for run-level phases', () => {
    expect(buildJobId({ runId: RUN, itemIdx: null, phase: 'plan' })).toBe('run_dedupe_1:plan:-');
    expect(buildJobId({ runId: RUN, itemIdx: null, phase: 'seal' })).toBe('run_dedupe_1:seal:-');
  });

  it('knows which phases are item-scoped', () => {
    expect(isItemPhase('execute')).toBe(true);
    expect(isItemPhase('critique')).toBe(true);
    expect(isItemPhase('plan')).toBe(false);
    expect(isItemPhase('seal')).toBe(false);
  });

  it('rejects a mismatched scope rather than silently building a wrong id', () => {
    expect(() => buildJobId({ runId: RUN, itemIdx: null, phase: 'execute' })).toThrow(
      /item-scoped/,
    );
    expect(() => buildJobId({ runId: RUN, itemIdx: 0, phase: 'plan' })).toThrow(/run-scoped/);
  });

  it('rejects a runId containing a separator — ids would become ambiguous', () => {
    expect(() => buildJobId({ runId: 'a:b', itemIdx: 0, phase: 'execute' })).toThrow(/":"/);
    expect(() => buildJobId({ runId: 'a#b', itemIdx: 0, phase: 'execute' })).toThrow(/"#"/);
  });

  it('a retry id uses "#", because BullMQ rejects a third colon (G-27)', () => {
    const key = { runId: RUN, itemIdx: 0, phase: 'execute' } as const;
    expect(retryJobId(key, 1)).toBe('run_dedupe_1:execute:0#1');
    // Two colons is the hard limit; the base id already spends both.
    expect((retryJobId(key, 1).match(/:/g) ?? []).length).toBe(2);
  });

  it('distinguishes every item and every phase', () => {
    const ids = new Set([
      buildJobId({ runId: RUN, itemIdx: 0, phase: 'execute' }),
      buildJobId({ runId: RUN, itemIdx: 1, phase: 'execute' }),
      buildJobId({ runId: RUN, itemIdx: 0, phase: 'critique' }),
      buildJobId({ runId: 'other', itemIdx: 0, phase: 'execute' }),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('duplicate enqueue does not create a second job', () => {
  it('the same key twice yields one job', async () => {
    const key = { runId: RUN, itemIdx: 0, phase: 'execute' } as const;
    await enqueue(queue, key);
    await enqueue(queue, key);
    await enqueue(queue, key);

    expect(await queue.getWaitingCount()).toBe(1);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe('run_dedupe_1:execute:0');
  });

  it('different items in the same phase are different jobs — fan-out is not dedupe', async () => {
    // DEC-002: EXECUTE fans out. If distinct items collapsed to one job there
    // would be no concurrent submission and nothing for the nonce to serialize.
    for (const idx of [0, 1, 2, 3]) {
      await enqueue(queue, { runId: RUN, itemIdx: idx, phase: 'execute' });
    }
    expect(await queue.getWaitingCount()).toBe(4);
  });

  it('the same item in different phases are different jobs', async () => {
    await enqueue(queue, { runId: RUN, itemIdx: 0, phase: 'critique' });
    await enqueue(queue, { runId: RUN, itemIdx: 0, phase: 'execute' });
    expect(await queue.getWaitingCount()).toBe(2);
  });
});

describe('attempt travels in the payload (DEC-003)', () => {
  it('an enqueued job carries attempt 0 by default', async () => {
    await enqueue(queue, { runId: RUN, itemIdx: 0, phase: 'execute' });
    const [job] = await queue.getJobs(['waiting']);
    expect(job?.data.attempt).toBe(0);
    expect(job?.data.runId).toBe(RUN);
    expect(job?.data.itemIdx).toBe(0);
    expect(job?.data.phase).toBe('execute');
  });

  it('a retry is a DIFFERENT job id with a DIFFERENT attempt', async () => {
    // This is what keeps the idempotency key correct: a re-picked stalled job
    // reuses the original payload and key, while a genuine Convoy-side retry
    // deliberately gets a new one.
    const key = { runId: RUN, itemIdx: 0, phase: 'execute' } as const;
    await enqueue(queue, key);
    await enqueueRetry(queue, key, 1);

    expect(await queue.getWaitingCount()).toBe(2);
    const jobs = await queue.getJobs(['waiting']);
    const byId = new Map(jobs.map((j) => [j.id, j.data.attempt]));
    expect(byId.get(retryJobId(key, 1))).toBe(1);
    expect(byId.get(buildJobId(key))).toBe(0);
  });

  it('rejects a retry with attempt 0 — that is the original, not a retry', async () => {
    await expect(
      enqueueRetry(queue, { runId: RUN, itemIdx: 0, phase: 'execute' }, 0),
    ).rejects.toThrow(/attempt >= 1/);
  });
});

describe('queue configuration', () => {
  it('keeps completed jobs, so the jobId dedupe guarantee survives completion', async () => {
    // BullMQ frees a jobId when the job is removed. removeOnComplete would make
    // "a duplicate jobId does not double-run" quietly false after the first run.
    const q = new Queue(QUEUE_NAME, { connection });
    const opts = (queue as unknown as { opts: { defaultJobOptions?: Record<string, unknown> } })
      .opts;
    expect(opts.defaultJobOptions?.['removeOnComplete']).toBe(false);
    expect(opts.defaultJobOptions?.['removeOnFail']).toBe(false);
    await q.close();
  });
});
