// Phase handler — execute.
//
// Dispatch ready items through the org Turnkey wallet.
//
// Keyed `(runId, itemIdx, phase)` and safe to re-run. Behaviour lands in CVY-008;
// CVY-006 ships the wiring, the key, and the idempotent shape.

import { throwIfAborted, type HandlerContext, type HandlerResult } from './types.js';

export async function handleExecute(ctx: HandlerContext): Promise<HandlerResult> {
  throwIfAborted(ctx);
  ctx.log('execute: no behaviour yet — implemented in CVY-008');
  return await Promise.resolve({ outcome: 'done', detail: 'execute skeleton' });
}
