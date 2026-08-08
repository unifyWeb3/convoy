import { notFound } from 'next/navigation';

import { loadTimeline } from '@/lib/events';

import { RunDetail } from './_components/RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: { id: string } }) {
  const snapshot = await loadTimeline(params.id);
  if (snapshot === null) notFound();
  return <RunDetail runId={params.id} snapshot={snapshot} />;
}
