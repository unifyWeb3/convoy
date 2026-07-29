// POST /api/runs — validate and enqueue a plan job; GET — list runs.
// Scaffold only. Implemented in CVY-008.
import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
