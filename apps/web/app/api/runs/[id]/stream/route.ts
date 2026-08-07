import { NextResponse } from 'next/server';

import {
  encodeSseEvent,
  isTerminalRun,
  loadTimeline,
  parseLastEventId,
  readEventsAfter,
  readRunStatus,
} from '../../../../../lib/events';

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  const runId = context.params.id;
  const initial = await loadTimeline(runId);
  if (initial === null) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });

  const lastHeader = request.headers.get('last-event-id') ?? request.headers.get('Last-Event-ID');
  let cursor = parseLastEventId(lastHeader);
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = (): void => {
        controller.enqueue(encoder.encode('event: convoy-end\ndata: {}\n\n'));
        controller.close();
      };
      const push = (event: Parameters<typeof encodeSseEvent>[0]): void => {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
        cursor = BigInt(event.id);
      };

      try {
        let status = await readRunStatus(runId);
        if (status === null) {
          close();
          return;
        }
        const replay = await readEventsAfter(runId, cursor);
        for (const event of replay) push(event);
        if (isTerminalRun(status)) {
          close();
          return;
        }

        while (!cancelled) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          status = await readRunStatus(runId);
          if (status === null) {
            close();
            return;
          }
          const events = await readEventsAfter(runId, cursor);
          for (const event of events) push(event);
          if (isTerminalRun(status)) {
            close();
            return;
          }
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
