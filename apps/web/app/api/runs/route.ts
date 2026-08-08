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
  const queue = new Queue('convoy', {
    connection,
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
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
