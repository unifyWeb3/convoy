// Phase handler — seal.
//
// Seal the run onchain and finalise the ledger.
//
// Keyed `(runId, itemIdx, phase)` and safe to re-run. Behaviour lands in CVY-008;
// CVY-006 ships the wiring, the key, and the idempotent shape.

import {
  runProductionLifecycle,
  throwIfAborted,
  type HandlerContext,
  type HandlerResult,
} from './types.js';

export async function handleSeal(ctx: HandlerContext): Promise<HandlerResult> {
  throwIfAborted(ctx);
  return await runProductionLifecycle(ctx);
}
