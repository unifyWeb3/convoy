'use client';

import React from 'react';

export function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
}

export type StateRole =
  | 'neutral'
  | 'active'
  | 'deferred'
  | 'retrying'
  | 'vetoed'
  | 'success'
  | 'failed'
  | 'partial'
  | 'unavailable';

export function stateRole(state: string): StateRole {
  if (state === 'LANDED' || state === 'SEALED_OK') return 'success';
  if (state === 'VETOED') return 'vetoed';
  if (state === 'DEFERRED') return 'deferred';
  if (state === 'RETRYING') return 'retrying';
  if (state === 'FAILED' || state === 'FAILED_FATAL' || state === 'ABORTED') return 'failed';
  if (state === 'SKIPPED' || state === 'SEALED_PARTIAL') return 'partial';
  if (
    state === 'SIMULATED' ||
    state === 'COMMITTED' ||
    state === 'SUBMITTED' ||
    state === 'PLANNING' ||
    state === 'CRITIQUING' ||
    state === 'EXECUTING' ||
    state === 'SEALING'
  ) {
    return 'active';
  }
  return 'neutral';
}

interface StateGlyphProps {
  readonly state: string;
  readonly size?: number;
  readonly title?: string;
}

/**
 * A small, colour-independent state mark. The word beside it remains the
 * authoritative label; the mark gives operators a second channel when colour
 * is unavailable or the row is scanned quickly.
 */
export function StateGlyph({ state, size = 14, title }: StateGlyphProps) {
  const normalized = state.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.65,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
  };

  let mark: React.ReactNode;
  switch (state) {
    case 'PENDING':
      mark = <path d="M3 8h.01M7.995 8h.01M13 8h.01" {...common} strokeLinecap="round" />;
      break;
    case 'DEFERRED':
      mark = <path d="M2 3h12M4 3v10M12 3v10M4 10h8" {...common} />;
      break;
    case 'SIMULATED':
      mark = (
        <>
          <path d="M2.5 2.5h11v11h-11z" {...common} />
          <path d="M3.25 3.25h5.1v9.5h-5.1z" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case 'VETOED':
      mark = <path d="M3 13L13 3" {...common} strokeWidth={2} />;
      break;
    case 'COMMITTED':
      mark = (
        <>
          <path d="M2.5 2.5h11v11h-11z" {...common} />
          <path d="M5 5h6v6H5z" {...common} />
        </>
      );
      break;
    case 'SUBMITTED':
      mark = <path d="M2 8h10M8 4l4 4-4 4" {...common} />;
      break;
    case 'RETRYING':
      mark = <path d="M13 6a5 5 0 1 0 .2 4.4M13 2.8v3.5H9.5" {...common} />;
      break;
    case 'LANDED':
    case 'SEALED_OK':
      mark = <path d="M2.5 8.5l3.2 3.2L13.5 4" {...common} strokeWidth={2} />;
      break;
    case 'FAILED':
    case 'FAILED_FATAL':
    case 'ABORTED':
      mark = <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" {...common} strokeWidth={2} />;
      break;
    case 'SKIPPED':
      mark = <path d="M3 8h10" {...common} strokeWidth={2} />;
      break;
    case 'SEALED_PARTIAL':
      mark = (
        <>
          <path d="M2.5 2.5h11v11h-11z" {...common} />
          <path d="M3 6l3-3M3 11l8-8M7 13l6-6M11 13l2.5-2.5" {...common} />
        </>
      );
      break;
    case 'PLANNED':
    case 'RECEIVED':
    case 'OPENING':
    default:
      mark = <path d="M2.5 2.5h11v11h-11z" {...common} />;
      break;
  }

  return (
    <svg
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
      className={`convoy-state-glyph convoy-state-glyph-${normalized}`}
      data-state={state}
      height={size}
      role={title === undefined ? undefined : 'img'}
      viewBox="0 0 16 16"
      width={size}
    >
      {mark}
    </svg>
  );
}

export function StateChip({
  state,
  onDark = false,
  className = '',
}: {
  readonly state: string;
  readonly onDark?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={`convoy-state-chip convoy-state-role-${stateRole(state)}${onDark ? ' convoy-state-chip-on-dark' : ''}${className ? ` ${className}` : ''}`}
      data-state={state}
    >
      <StateGlyph state={state} size={13} />
      <span>{humanize(state)}</span>
    </span>
  );
}

export function recordedText(value: unknown, missing = 'not recorded'): string {
  if (value === null || value === undefined || value === '') return missing;
  return String(value);
}
