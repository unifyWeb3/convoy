// POST /api/runs/:id/abort — cooperative abort.
// Scaffold only. Implemented in CVY-014.
import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
