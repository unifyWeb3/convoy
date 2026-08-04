// Phase handler — critique.
//
// Simulate every write and veto the ones that would revert or overspend.
//
// Keyed `(runId, itemIdx, phase)` and safe to re-run. Behaviour lands in CVY-011;
// CVY-006 ships the wiring, the key, and the idempotent shape.

import { throwIfAborted, type HandlerContext, type HandlerResult } from './types.js';

export async function handleCritique(ctx: HandlerContext): Promise<HandlerResult> {
  throwIfAborted(ctx);
  ctx.log('critique: no behaviour yet — implemented in CVY-011');
  return await Promise.resolve({ outcome: 'done', detail: 'critique skeleton' });
}
