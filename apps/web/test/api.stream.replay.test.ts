import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readEventsAfter: vi.fn(),
  loadTimeline: vi.fn(),
  readRunStatus: vi.fn(),
}));

vi.mock('../lib/events', () => ({
  encodeSseEvent: (event: {
    id: string;
    runId: string;
    itemIdx: number | null;
    type: string;
    payload: unknown;
    at: string;
  }) => `id: ${event.id}\nevent: convoy\ndata: ${JSON.stringify(event)}\n\n`,
  isTerminalRun: (status: string) =>
    ['SEALED_OK', 'SEALED_PARTIAL', 'ABORTED', 'FAILED_FATAL'].includes(status),
  loadTimeline: mocks.loadTimeline,
  parseLastEventId: (value: string | null) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n),
  readEventsAfter: mocks.readEventsAfter,
  readRunStatus: mocks.readRunStatus,
}));

import { GET } from '../app/api/runs/[id]/stream/route';

const event = (id: string, type = 'RUN_RECEIVED') => ({
  id,
  runId: 'run-1',
  itemIdx: null,
  type,
  payload: {},
  at: '2026-08-06T00:00:00.000Z',
});

describe('GET /api/runs/:id/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replays strictly after Last-Event-ID and closes after a terminal event', async () => {
    mocks.loadTimeline.mockResolvedValue({
      run: { id: 'run-1', status: 'EXECUTING' },
      items: [],
      events: [],
    });
    mocks.readEventsAfter.mockResolvedValueOnce([event('8'), event('9', 'RUN_SEALED')]);
    const response = await GET(
      new Request('http://convoy.test/api/runs/run-1/stream', {
        headers: { 'Last-Event-ID': '7' },
      }),
      { params: { id: 'run-1' } },
    );
    const text = await response.text();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(text).toContain('id: 8');
    expect(text).toContain('id: 9');
    expect(mocks.readEventsAfter).toHaveBeenCalledWith('run-1', 7n);
  });

  it('returns 404 for an unknown run', async () => {
    mocks.loadTimeline.mockResolvedValue(null);
    const response = await GET(new Request('http://convoy.test'), { params: { id: 'missing' } });
    expect(response.status).toBe(404);
  });
});
