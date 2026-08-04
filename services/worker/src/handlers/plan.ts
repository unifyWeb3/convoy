// Phase handler — plan.
//
// Build the DAG from the batch evidence (LLM Planner).
//
// Keyed `(runId, itemIdx, phase)` and safe to re-run. Behaviour lands in CVY-010;
// CVY-006 ships the wiring, the key, and the idempotent shape.

import { throwIfAborted, type HandlerContext, type HandlerResult } from './types.js';

export async function handlePlan(ctx: HandlerContext): Promise<HandlerResult> {
  throwIfAborted(ctx);
  ctx.log('plan: no behaviour yet — implemented in CVY-010');
  return await Promise.resolve({ outcome: 'done', detail: 'plan skeleton' });
}
