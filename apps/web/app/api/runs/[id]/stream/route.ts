// GET /api/runs/:id/stream — SSE event stream.
//
// Implemented in CVY-009. Uses a ReadableStream with force-dynamic and the
// X-Accel-Buffering: no header (reverse proxies buffer responses by default).
// The SSE event id IS events.id (bigserial): on connect the route replays
// `events WHERE id > :lastEventId ORDER BY id`, then tails live, so a mid-run
// refresh loses nothing.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
