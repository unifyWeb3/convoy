// GET /api/runs/:id/manifest — sha256-stamped manifest export.
// Scaffold only. Implemented in CVY-012.
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
