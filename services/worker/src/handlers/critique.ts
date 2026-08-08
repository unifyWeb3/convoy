// Phase handler — critique.
//
// Simulate every write and veto the ones that would revert or overspend.
//
// Keyed `(runId, itemIdx, phase)` and safe to re-run. CVY-006 ships the wiring,
// the key, and the idempotent shape.
//
// STILL A SKELETON AFTER CVY-011, and deliberately so. The critique behaviour
// exists and is live — `phaseCritique` in `orchestrator.ts`, driven by
// `runBatch` — but the BullMQ queue path is not the driver: all four handlers
// are skeletons, including `plan` and `execute` whose milestones also shipped.
// Filling in this one alone would give the queue a critique step in front of an
// execute step that does nothing, which is worse than an honest skeleton.
// Recorded as gap G-33; the queue path is CVY-015's to connect, alongside
// crash-resume.

import {
  runProductionLifecycle,
  throwIfAborted,
  type HandlerContext,
  type HandlerResult,
} from './types.js';

export async function handleCritique(ctx: HandlerContext): Promise<HandlerResult> {
  throwIfAborted(ctx);
  return await runProductionLifecycle(ctx);
}
