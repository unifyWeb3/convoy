'use client';

import React, { useState } from 'react';

import type { TimelineSnapshot } from '@/lib/events';

import { Manifest } from './Manifest';
import { Timeline } from './Timeline';

export function RunDetail({ runId, snapshot }: { runId: string; snapshot: TimelineSnapshot }) {
  const [tab, setTab] = useState<'timeline' | 'manifest'>('timeline');
  return (
    <>
      <nav aria-label="Run views" className="mb-6 flex border-b border-zinc-200">
        <button
          type="button"
          onClick={() => setTab('timeline')}
          aria-current={tab === 'timeline' ? 'page' : undefined}
          className={`border-b-2 px-4 py-2 text-sm font-medium ${tab === 'timeline' ? 'border-zinc-950 text-zinc-950' : 'border-transparent text-zinc-500'}`}
        >
          Timeline
        </button>
        <button
          type="button"
          onClick={() => setTab('manifest')}
          aria-current={tab === 'manifest' ? 'page' : undefined}
          className={`border-b-2 px-4 py-2 text-sm font-medium ${tab === 'manifest' ? 'border-zinc-950 text-zinc-950' : 'border-transparent text-zinc-500'}`}
        >
          Manifest
        </button>
      </nav>
      {tab === 'timeline' ? (
        <Timeline runId={runId} initial={snapshot} />
      ) : (
        <Manifest runId={runId} />
      )}
    </>
  );
}
