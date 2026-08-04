// Shared handler contract.
//
// Every handler is keyed `(runId, itemIdx, phase)` and must be safe to re-run:
// BullMQ re-picks a stalled job after ~30s (gap G-26), so "runs exactly once" is
// not available. "Re-running changes nothing" is, and that is what these
// skeletons are shaped to deliver.

import type { ConvoyJobData } from '../queue.js';

export interface HandlerContext {
  readonly data: ConvoyJobData;
  /** Cooperative abort — set when the run is aborted or the worker is shutting down. */
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
}

export interface HandlerResult {
  /** `skipped` means the work was already done — the idempotent re-run path. */
  readonly outcome: 'done' | 'skipped';
  readonly detail: string;
}

export type PhaseHandler = (ctx: HandlerContext) => Promise<HandlerResult>;

/** Throw from a handler when the run was aborted mid-flight. */
export class AbortedError extends Error {
  constructor(phase: string) {
    super(`run aborted during ${phase}`);
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(ctx: HandlerContext): void {
  if (ctx.signal.aborted) throw new AbortedError(ctx.data.phase);
}
