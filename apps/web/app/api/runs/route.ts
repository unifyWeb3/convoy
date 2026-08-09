// POST /api/runs — enqueue an already persisted run for the worker.
//
// Run creation and planning remain the existing ledger responsibilities. This
// route is intentionally narrow: it is only the queue-backed start/resume
// entrypoint required by CVY-015, not a new capability or alternate
// orchestrator.
import { db } from '@convoy/db';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const bodySchema = z.object({ runId: z.string().uuid() });
const QUEUE_NAME = 'convoy';

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'runId must be a UUID' }, { status: 400 });
  }
  const run = await db.run.findUnique({ where: { id: parsed.data.runId }, select: { id: true } });
  if (run === null) return NextResponse.json({ error: 'run not found' }, { status: 404 });

  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl === undefined || redisUrl === '') {
    return NextResponse.json({ error: 'queue is not configured' }, { status: 503 });
  }
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, {
    connection,
    // Keep API-enqueued jobs on the same retry policy as the worker-created
    // queue. A route-local Queue does not inherit the worker's defaults.
    defaultJobOptions: {
      attempts: positiveEnvInt('CONVOY_JOB_ATTEMPTS', 3),
      backoff: { type: 'exponential', delay: positiveEnvInt('CONVOY_JOB_BACKOFF_MS', 1_000) },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  const jobId = `${parsed.data.runId}:plan:-`;
  try {
    await queue.add(
      'plan',
      { runId: parsed.data.runId, itemIdx: null, phase: 'plan', attempt: 0 },
      { jobId },
    );
    return NextResponse.json(
      { runId: parsed.data.runId, jobId, status: 'queued' },
      { status: 202 },
    );
  } finally {
    await queue.close();
    await connection.quit();
  }
}
