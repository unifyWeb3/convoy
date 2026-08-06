import { NextResponse } from 'next/server';

import {
  ManifestNotFoundError,
  ManifestRunNotTerminalError,
  exportManifest,
} from '../../../../../lib/manifest';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const manifest = await exportManifest(context.params.id);
    return NextResponse.json(manifest, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="convoy-manifest-${context.params.id}.json"`,
        ETag: `"${manifest.sha256}"`,
      },
    });
  } catch (error) {
    if (error instanceof ManifestNotFoundError) {
      return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
    }
    if (error instanceof ManifestRunNotTerminalError) {
      return NextResponse.json(
        { error: 'run_not_terminal', detail: error.message },
        { status: 409 },
      );
    }
    console.error('manifest export failed', error);
    return NextResponse.json({ error: 'manifest_export_failed' }, { status: 500 });
  }
}
