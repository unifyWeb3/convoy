// GET /api/runs/:id — run state.
// Scaffold only. Implemented in CVY-008.
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
