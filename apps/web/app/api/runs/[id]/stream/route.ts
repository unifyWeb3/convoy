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
        const replay = await readEventsAfter(runId, cursor);
        for (const event of replay) push(event);
        const replayTerminal = replay.at(-1)?.type;
        if (
          isTerminalRun(initial.run.status) ||
          replayTerminal === 'RUN_SEALED' ||
          replayTerminal === 'RUN_SEALED_PARTIAL'
        ) {
          close();
          return;
        }

        let status = initial.run.status;
        while (!cancelled) {
          const events = await readEventsAfter(runId, cursor);
          for (const event of events) push(event);
          if (events.length > 0) {
            const latest = events.at(-1);
            if (latest?.type === 'RUN_SEALED' || latest?.type === 'RUN_SEALED_PARTIAL') {
              status = latest.type === 'RUN_SEALED' ? 'SEALED_OK' : 'SEALED_PARTIAL';
            }
          }
          if (isTerminalRun(status)) {
            close();
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          const currentStatus = await readRunStatus(runId);
          if (currentStatus === null) {
            close();
            return;
          }
          status = currentStatus;
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
