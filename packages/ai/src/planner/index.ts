// Planner agent — evidence → validated execution DAG.
//
// Replaces the hardcoded plan from D-029. What the Planner supplies that a
// deterministic pass cannot is the DEPENDENCY EXTRACTION: a topological sort is
// trivial once the edges exist, but the edges live in prose — "hold the top-up
// until the new root is published", "this can't go before Tuesday's snapshot" —
// and no parser generalises across a Notion note, a CSV export and a forum
// thread. That is the whole reason this component is an LLM.
//
// Everything downstream of the extraction is deterministic and adversarial
// towards the model's output: whitelist, permutation check, cycle rejection,
// budget check. The plan is DATA, validated then consumed — never executed raw.

import {
  buildRepairMessage,
  buildUserMessage,
  newFenceToken,
  SYSTEM_INSTRUCTION,
  type PlannerInput,
} from './prompt.js';
import { parsePlan } from './repair.js';
import { PLAN_JSON_SCHEMA, type Plan } from './schema.js';
import type { LlmCaller } from './llm.js';

export type { PlannerInput, PlannerItem } from './prompt.js';
export type { Plan, Deferral } from './schema.js';
export { LlmUnavailableError, createLlmCaller, llmConfigFromEnv } from './llm.js';
export type { LlmCaller, LlmConfig } from './llm.js';
export { parsePlan, stripCodeFence } from './repair.js';
export { PLAN_JSON_SCHEMA, PlanSchema } from './schema.js';
export {
  SYSTEM_INSTRUCTION,
  buildUserMessage,
  buildRepairMessage,
  fenceEvidence,
} from './prompt.js';

/** How a stored plan came to exist. Persisted in `runs.plan.source`. */
export const PLAN_SOURCE = {
  planner: 'planner',
  /** Deterministic topological order — also the `--ablate-planner` control. */
  fallback: 'fallback-topological',
} as const;

export type PlanSource = (typeof PLAN_SOURCE)[keyof typeof PLAN_SOURCE];

export interface DependencyEdge {
  /** The item that waits. */
  readonly idx: number;
  /** The item it waits for. */
  readonly dependsOn: number;
}

export interface StoredPlan {
  readonly source: PlanSource;
  readonly order: readonly number[];
  readonly deferrals: readonly DependencyEdge[];
  readonly gasBudgetPerItem: readonly { idx: number; gasBudgetUsdc: string }[];
  readonly rationalePerItem: readonly { idx: number; rationale: string }[];
  /** Items excluded before planning because their target was not whitelisted. */
  readonly excludedIdx: readonly number[];
  /** Everything that had to be corrected or rejected. Never silently dropped. */
  readonly warnings: readonly string[];
  readonly attempts: number;
  readonly model?: string;
}

export class PlanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Deterministic validation. The model proposes; this disposes.
// ---------------------------------------------------------------------------

/**
 * Reject a plan whose deferrals contain a cycle.
 *
 * Returns the cycle when it finds one, so the rejection is explainable rather
 * than a bare boolean — a cycle is the one Planner failure that would deadlock
 * the deferral gate forever rather than failing loudly, so it is worth naming.
 */
export function findCycle(edges: readonly DependencyEdge[]): number[] | undefined {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    const list = adj.get(e.idx);
    if (list === undefined) adj.set(e.idx, [e.dependsOn]);
    else list.push(e.dependsOn);
  }

  const VISITING = 1;
  const DONE = 2;
  const mark = new Map<number, number>();
  const stack: number[] = [];

  function visit(node: number): number[] | undefined {
    const state = mark.get(node);
    if (state === DONE) return undefined;
    if (state === VISITING) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    mark.set(node, VISITING);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    mark.set(node, DONE);
    return undefined;
  }

  for (const node of [...adj.keys()]) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** Kahn's algorithm. Deterministic tie-break by index so runs are reproducible. */
export function topologicalOrder(
  indices: readonly number[],
  edges: readonly DependencyEdge[],
): number[] {
  const remaining = new Map<number, Set<number>>();
  for (const idx of indices) remaining.set(idx, new Set());
  for (const e of edges) {
    if (remaining.has(e.idx) && remaining.has(e.dependsOn)) remaining.get(e.idx)?.add(e.dependsOn);
  }

  const out: number[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([idx]) => idx)
      .sort((a, b) => a - b);
    if (ready.length === 0) {
      // Cycle. The caller rejects; emit the rest in index order rather than hang.
      out.push(...[...remaining.keys()].sort((a, b) => a - b));
      break;
    }
    for (const idx of ready) {
      out.push(idx);
      remaining.delete(idx);
    }
    for (const deps of remaining.values()) for (const idx of ready) deps.delete(idx);
  }
  return out;
}

/**
 * Turn a raw model plan into a stored plan, or reject it.
 *
 * Repairs that are safe and unambiguous are applied and WARNED about; anything
 * that would require guessing at intent is a rejection. The line is drawn at
 * whether the correction can be wrong: dropping a deferral that points at a
 * nonexistent item cannot be, whereas inventing the item it meant can.
 */
export function validatePlan(
  plan: Plan,
  input: PlannerInput,
  options: { source?: PlanSource; attempts?: number; model?: string } = {},
): StoredPlan {
  const known = new Set(input.items.map((i) => i.idx));
  const warnings: string[] = [];

  // 1. Deferrals must reference real items and must not be self-referential.
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const d of plan.deferrals) {
    if (!known.has(d.idx) || !known.has(d.untilItem)) {
      warnings.push(`dropped deferral ${d.idx}←${d.untilItem}: unknown item index`);
      continue;
    }
    if (d.idx === d.untilItem) {
      warnings.push(`dropped self-deferral on item ${d.idx}`);
      continue;
    }
    const key = `${d.idx}<-${d.untilItem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ idx: d.idx, dependsOn: d.untilItem });
  }

  // 2. Cycles are fatal. A cycle would deadlock the deferral gate silently,
  //    which is worse than any wrong-but-acyclic order.
  const cycle = findCycle(edges);
  if (cycle !== undefined) {
    throw new PlanRejectedError(`plan contains a dependency cycle: ${cycle.join(' → ')}`);
  }

  // 3. `order` must be a permutation of the known indices. Unknown entries are
  //    dropped and missing ones appended — both are unambiguous.
  const order: number[] = [];
  const placed = new Set<number>();
  for (const idx of plan.order) {
    if (!known.has(idx)) {
      warnings.push(`dropped unknown item index ${idx} from order`);
      continue;
    }
    if (placed.has(idx)) {
      warnings.push(`dropped duplicate item index ${idx} from order`);
      continue;
    }
    placed.add(idx);
    order.push(idx);
  }
  const missing = [...known].filter((i) => !placed.has(i)).sort((a, b) => a - b);
  if (missing.length > 0) {
    warnings.push(`order omitted item(s) ${missing.join(', ')}; appended`);
    order.push(...missing);
  }

  // 4. The order must respect the deferrals it declared. Where it does not, the
  //    DEFERRALS win — they are the extracted knowledge, and the order is a
  //    presentation of it. Re-derived by topological sort rather than patched.
  const position = new Map(order.map((idx, at) => [idx, at]));
  const violated = edges.filter(
    (e) => (position.get(e.idx) ?? 0) <= (position.get(e.dependsOn) ?? 0),
  );
  let finalOrder = order;
  if (violated.length > 0) {
    warnings.push(`order contradicted ${violated.length} deferral(s); re-derived topologically`);
    finalOrder = topologicalOrder(order, edges);
  }

  // 5. Budget allocations must be parseable and must not exceed the run budget.
  const budget = Number(input.budgetUsdc);
  const allocations = plan.gasBudgetPerItem.filter((g) => {
    if (known.has(g.idx)) return true;
    warnings.push(`dropped gas budget for unknown item ${g.idx}`);
    return false;
  });
  const allocated = allocations.reduce((sum, g) => sum + Number(g.gasBudgetUsdc), 0);
  if (Number.isFinite(budget) && allocated > budget) {
    // Not fatal: the meter enforces the real limit per item at CRITIQUING, and
    // an over-allocated plan produces VETO(over_budget), which is a correct
    // outcome rather than a broken one.
    warnings.push(
      `allocations total ${allocated.toFixed(6)} USDC against a ${input.budgetUsdc} USDC budget`,
    );
  }

  return {
    source: options.source ?? PLAN_SOURCE.planner,
    order: finalOrder,
    deferrals: edges,
    gasBudgetPerItem: allocations,
    rationalePerItem: plan.rationalePerItem.filter((r) => known.has(r.idx)),
    excludedIdx: [],
    warnings,
    attempts: options.attempts ?? 1,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

/**
 * The deterministic plan: declared edges, topologically sorted.
 *
 * This is the fallback when the Planner is unavailable or fails twice, AND it is
 * the `--ablate-planner` baseline for CVY-016. The two being the same code is
 * deliberate — the ablation measures the real degradation path, not a
 * hypothetical one.
 */
export function deterministicPlan(
  input: PlannerInput,
  declaredEdges: readonly DependencyEdge[] = [],
  reason = 'planner unavailable',
): StoredPlan {
  const indices = input.items.map((i) => i.idx);
  const share = (Number(input.budgetUsdc) / Math.max(indices.length, 1)).toFixed(6);
  return {
    source: PLAN_SOURCE.fallback,
    order: topologicalOrder(indices, declaredEdges),
    deferrals: declaredEdges,
    gasBudgetPerItem: indices.map((idx) => ({ idx, gasBudgetUsdc: share })),
    rationalePerItem: indices.map((idx) => ({
      idx,
      rationale: 'deterministic topological order from declared edges; no evidence was read',
    })),
    excludedIdx: [],
    warnings: [`deterministic fallback used: ${reason}`],
    attempts: 0,
  };
}

// ---------------------------------------------------------------------------
// The Planner itself
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /**
   * Target contracts this run is allowed to touch, as symbolic names matching
   * `PlannerItem.target`. An item pointing anywhere else is EXCLUDED before the
   * Planner sees it, and becomes an automatic VETO(evidence_mismatch) at the
   * Critic. Convoy never executes a target it was not told about.
   */
  readonly whitelist: readonly string[];
  /** Declared edges, used only by the fallback. */
  readonly declaredEdges?: readonly DependencyEdge[];
  /** Set false to skip the LLM entirely — the ablation control. */
  readonly useLlm?: boolean;
}

export interface PlanResult {
  readonly plan: StoredPlan;
  /** Did the FIRST response parse and validate? The ≥95% metric. */
  readonly firstPassValid: boolean;
  /** Raw model outputs in order, for the audit drawer. */
  readonly transcript: readonly { role: string; content: string }[];
}

/**
 * Plan a run.
 *
 * Never throws for a model failure: an unusable Planner degrades to the
 * deterministic order and the run proceeds. It DOES throw for a caller error —
 * an empty whitelist, no items — because those are bugs, not degradation.
 */
export async function planRun(
  input: PlannerInput,
  call: LlmCaller | undefined,
  options: PlanOptions,
): Promise<PlanResult> {
  if (options.whitelist.length === 0) {
    throw new Error('planRun requires a non-empty target whitelist');
  }

  const allowed = new Set(options.whitelist);
  const excludedIdx = input.items.filter((i) => !allowed.has(i.target)).map((i) => i.idx);
  const scoped: PlannerInput = {
    ...input,
    items: input.items.filter((i) => allowed.has(i.target)),
  };

  const withExclusions = (p: StoredPlan): StoredPlan => ({
    ...p,
    excludedIdx,
    warnings:
      excludedIdx.length === 0
        ? p.warnings
        : [
            ...p.warnings,
            `excluded item(s) ${excludedIdx.join(', ')}: target not in the run whitelist`,
          ],
  });

  const declared = options.declaredEdges ?? [];
  if (options.useLlm === false || call === undefined) {
    return {
      plan: withExclusions(deterministicPlan(scoped, declared, 'LLM disabled')),
      firstPassValid: false,
      transcript: [],
    };
  }

  const fenceToken = newFenceToken();
  const messages = [
    { role: 'system' as const, content: SYSTEM_INSTRUCTION },
    { role: 'user' as const, content: buildUserMessage(scoped, fenceToken) },
  ];
  const transcript: { role: string; content: string }[] = [];

  let first: Awaited<ReturnType<LlmCaller>>;
  try {
    first = await call({ messages, schemaName: 'convoy_plan', jsonSchema: PLAN_JSON_SCHEMA });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      plan: withExclusions(deterministicPlan(scoped, declared, reason)),
      firstPassValid: false,
      transcript,
    };
  }
  transcript.push({ role: 'assistant', content: first.content });

  const firstParse = parsePlan(first.content);
  if (firstParse.ok && firstParse.plan !== undefined) {
    try {
      return {
        plan: withExclusions(
          validatePlan(firstParse.plan, scoped, {
            attempts: 1,
            ...(first.model === undefined ? {} : { model: first.model }),
          }),
        ),
        firstPassValid: true,
        transcript,
      };
    } catch (e) {
      // A cycle. Valid JSON — the ≥95% metric counts it — but an unusable plan.
      return {
        plan: withExclusions(
          deterministicPlan(scoped, declared, e instanceof Error ? e.message : String(e)),
        ),
        firstPassValid: true,
        transcript,
      };
    }
  }

  // EXACTLY ONE repair pass.
  let repaired: Awaited<ReturnType<LlmCaller>>;
  try {
    repaired = await call({
      messages: [
        ...messages,
        { role: 'assistant' as const, content: first.content },
        {
          role: 'user' as const,
          content: buildRepairMessage(first.content, firstParse.error ?? 'unknown'),
        },
      ],
      schemaName: 'convoy_plan',
      jsonSchema: PLAN_JSON_SCHEMA,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      plan: withExclusions(deterministicPlan(scoped, declared, `repair failed: ${reason}`)),
      firstPassValid: false,
      transcript,
    };
  }
  transcript.push({ role: 'assistant', content: repaired.content });

  const second = parsePlan(repaired.content);
  if (second.ok && second.plan !== undefined) {
    try {
      return {
        plan: withExclusions(
          validatePlan(second.plan, scoped, {
            attempts: 2,
            ...(repaired.model === undefined ? {} : { model: repaired.model }),
          }),
        ),
        firstPassValid: false,
        transcript,
      };
    } catch (e) {
      return {
        plan: withExclusions(
          deterministicPlan(scoped, declared, e instanceof Error ? e.message : String(e)),
        ),
        firstPassValid: false,
        transcript,
      };
    }
  }

  // Two failures. Fall through — the run proceeds, degraded and labelled.
  return {
    plan: withExclusions(
      deterministicPlan(
        scoped,
        declared,
        `plan invalid after repair: ${second.error ?? 'unknown'}`,
      ),
    ),
    firstPassValid: false,
    transcript,
  };
}
