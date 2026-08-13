// Parse + validate a Planner response, with exactly one repair pass.
//
// "Exactly one" is the frozen acceptance criterion and it is a real constraint,
// not a stylistic one: an unbounded repair loop turns a demo beat with an 8s
// budget into an open-ended stall, and a model that failed twice on the same
// input is not converging. A second failure falls through to the deterministic
// plan, which is the `--ablate-planner` control — so the run never blocks on the
// Planner, it only gets worse without it.

import { PlanSchema, type Plan } from './schema.js';

export interface ParseOutcome {
  readonly ok: boolean;
  readonly plan?: Plan;
  readonly error?: string;
  /** The raw model output, kept for the audit drawer and for the repair message. */
  readonly raw: string;
}

/**
 * Strip a markdown code fence if the model wrapped its JSON in one.
 *
 * Not leniency for its own sake — a fenced but otherwise perfect object is a
 * formatting slip, and counting it as a schema failure would misattribute the
 * error. It is unwrapped BEFORE the first-pass verdict is recorded, so the
 * ≥95% figure measures JSON validity rather than markdown habits. That choice
 * is disclosed in the eval output.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

export function parsePlan(raw: string): ParseOutcome {
  const text = stripCodeFence(raw);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      raw,
      error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, raw, error: `schema violation: ${detail}` };
  }

  return { ok: true, raw, plan: parsed.data };
}
