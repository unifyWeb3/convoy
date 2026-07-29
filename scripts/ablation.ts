#!/usr/bin/env tsx
/**
 * Ablation harness — proves the Planner and the Critic earn their place.
 *
 *   --ablate-planner  submit in input order, no dependency extraction.
 *                     Expected: landed-item rate 100% -> ~55%, wasted gas > 0.
 *   --ablate-critic   execute every planned item without the simulate gate.
 *                     Expected: wasted-gas events 0 -> 2, one starved dependent.
 *
 * Metrics are measured from real executions and printed, then pasted into the
 * README honesty table. No staged failure, no injected gas spike, no fabricated
 * hash — the reverts are genuine because invalid items point at a contract that
 * legitimately rejects them.
 *
 * Scaffold only. Implemented in CVY-016.
 */
export {};
