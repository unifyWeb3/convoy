// Critic output schema.
//
// The veto vocabulary is CLOSED (ARCHITECTURE §5(d)): four reasons, no free
// text in the decision itself. Free text exists only in `justification` and
// `evidenceQuote`, which are evidence FOR a decision rather than the decision.
// A model that wants to veto for a fifth reason cannot express it, and that is
// the point — an open reason field turns the audit drawer into prose and makes
// the ablation table unmeasurable.
//
// The same structural property as the Planner's schema holds here: there is no
// address, no target and no calldata field anywhere in this shape. The Critic
// judges an action that already exists. It cannot name a different one.

import { z } from 'zod';

/** The four frozen veto reasons, plus the sentinel used when nothing is wrong. */
export const VETO_REASONS = [
  'would_revert',
  'over_budget',
  'unmet_dependency',
  'evidence_mismatch',
] as const;

export type VetoReason = (typeof VETO_REASONS)[number];

export const NO_REASON = 'none';

export const CriticVerdictSchema = z.object({
  verdict: z.enum(['APPROVE', 'VETO']),
  /** `none` on an APPROVE. Any other value is one of the four frozen reasons. */
  reason: z.enum([...VETO_REASONS, NO_REASON]),
  /**
   * The span of evidence that decided it, quoted verbatim.
   *
   * Load-bearing rather than decorative: the prompt requires a VETO to name the
   * contradicted line, which is what stops "this looks risky" from counting as a
   * finding. Empty is legitimate on an APPROVE.
   */
  evidenceQuote: z.string().max(600),
  justification: z.string().min(1).max(600),
});

export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

/**
 * The same shape as JSON Schema, for structured-output mode.
 *
 * Hand-written for the reason given in the Planner's schema.ts: strict mode
 * requires every property in `required` and `additionalProperties:false` at
 * every level, and rejects most validation keywords. `enum` is supported and is
 * doing real work here — it is what makes the closed vocabulary a constraint on
 * generation rather than only a post-hoc rejection.
 */
export const CRITIC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason', 'evidenceQuote', 'justification'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'VETO'] },
    reason: { type: 'string', enum: [...VETO_REASONS, NO_REASON] },
    evidenceQuote: { type: 'string' },
    justification: { type: 'string' },
  },
} as const;
