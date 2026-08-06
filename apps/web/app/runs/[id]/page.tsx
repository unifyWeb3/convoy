import { notFound } from 'next/navigation';

import { loadTimeline } from '@/lib/events';

import { RunDetail } from './_components/RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: { id: string } }) {
  const snapshot = await loadTimeline(params.id);
  if (snapshot === null) notFound();
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <RunDetail runId={params.id} snapshot={snapshot} />
    </main>
  );
}
