// The corroboration override table.
//
// THIS IS THE NON-NEGOTIABLE CLAUSE of CVY-011, so it lives in one pure
// function with no I/O, no model call and no clock. It is unit-tested directly
// rather than only through a live LLM path: a rule that can only be exercised by
// calling a provider is a rule that stops being checked the first time the
// provider is down.
//
// THE RULE, in one line: THE SIMULATOR ALWAYS WINS.
//
//   - A `VETO(would_revert)` stands only if `simulate.wouldRevert === true`.
//   - A model APPROVE on an action the simulator says reverts becomes a VETO.
//   - Revert and overspend are decided by the simulator and by arithmetic; the
//     model's opinion on either is discarded in both directions.
//   - What is left for the model is the judgement neither can make: whether the
//     action is the one the evidence asked for.
//
// Every override is RECORDED, never silent. `overrides` is what the audit drawer
// and the CVY-016 honesty table read to say how often the model and the
// simulator disagreed, and in which direction.

import { NO_REASON, type CriticVerdict, type VetoReason } from './schema.js';

/** What was established deterministically, before the model was consulted. */
export interface DeterministicFacts {
  /** KeeperHub `simulate:true`. The authority on reverts. */
  readonly wouldRevert: boolean;
  readonly revertReason?: string;
  /**
   * Projected cost against the item's allocation — arithmetic, not judgement.
   * `unknown` when the projection could not be computed (no allocation, or no
   * gas price). Unknown is NOT over budget, and never a veto on its own.
   */
  readonly budget: 'affordable' | 'over_budget' | 'unknown';
  readonly budgetDetail?: string;
  /** Did the target resolve to a run-whitelisted contract? */
  readonly targetWhitelisted: boolean;
}

export type VerdictSource = 'whitelist' | 'simulator' | 'arithmetic' | 'critic' | 'default';

export interface FinalVerdict {
  readonly approved: boolean;
  /** Present only on a veto. Always one of the four frozen reasons. */
  readonly reason?: VetoReason;
  readonly decidedBy: VerdictSource;
  readonly detail: string;
  /** Every point at which the model was overruled. Never dropped. */
  readonly overrides: readonly string[];
  /** False when no model verdict was available — the advisory-Critic fallback. */
  readonly criticConsulted: boolean;
  /** What the model said on its own, before corroboration. For the ablation table. */
  readonly modelVerdict?: CriticVerdict;
}

/** Reasons the model may decide by itself. The other two belong to the machine. */
const MODEL_OWNED: ReadonlySet<string> = new Set<VetoReason>([
  'unmet_dependency',
  'evidence_mismatch',
]);

/**
 * Reconcile a model verdict with the deterministic facts.
 *
 * `model` is `undefined` when the Critic could not be reached. That degrades to
 * the simulator-only gate — the documented CVY-011 fallback — and is reported as
 * `criticConsulted:false` rather than as an approval the Critic granted.
 */
export function corroborate(
  model: CriticVerdict | undefined,
  facts: DeterministicFacts,
): FinalVerdict {
  const overrides: string[] = [];
  const consulted = model !== undefined;
  const withModel = model === undefined ? {} : { modelVerdict: model };

  // 1. An unknown or non-whitelisted target is an automatic veto, and the model
  //    is not consulted about it. Convoy never executes a target it was not told
  //    about, whatever anyone's opinion of the evidence.
  if (!facts.targetWhitelisted) {
    if (model?.verdict === 'APPROVE') {
      overrides.push('critic APPROVE overridden: target is not in the run whitelist');
    }
    return {
      approved: false,
      reason: 'evidence_mismatch',
      decidedBy: 'whitelist',
      detail: 'target is not in the run whitelist',
      overrides,
      criticConsulted: consulted,
      ...withModel,
    };
  }

  // 2. The simulator found a revert. This overrides an APPROVE — the clause the
  //    card names explicitly — and it is decided before the model's reason is
  //    even read, because there is nothing the model could say that outranks a
  //    dry run against real chain state.
  if (facts.wouldRevert) {
    if (model?.verdict === 'APPROVE') {
      overrides.push(
        `critic APPROVE overridden by the simulator: ${facts.revertReason ?? 'would revert'}`,
      );
    }
    return {
      approved: false,
      reason: 'would_revert',
      decidedBy: 'simulator',
      detail: facts.revertReason ?? 'simulate reported wouldRevert',
      overrides,
      criticConsulted: consulted,
      ...withModel,
    };
  }

  // 3. Overspend is arithmetic. Same standing as the simulator, same direction.
  if (facts.budget === 'over_budget') {
    if (model?.verdict === 'APPROVE') {
      overrides.push('critic APPROVE overridden by the budget projection');
    }
    return {
      approved: false,
      reason: 'over_budget',
      decidedBy: 'arithmetic',
      detail: facts.budgetDetail ?? 'projected cost exceeds the item allocation',
      overrides,
      criticConsulted: consulted,
      ...withModel,
    };
  }

  // 4. No Critic. The deterministic gate has spoken and it approved; say so
  //    honestly rather than crediting a judgement nobody made.
  if (model === undefined) {
    return {
      approved: true,
      decidedBy: 'default',
      detail: 'simulator-only gate; the Critic was not consulted',
      overrides,
      criticConsulted: false,
    };
  }

  if (model.verdict === 'APPROVE') {
    return {
      approved: true,
      decidedBy: 'critic',
      detail: model.justification,
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  // 5. A model VETO on a claim the machine owns. The simulator said this call
  //    succeeds and the arithmetic said it fits; the model saying otherwise is a
  //    disagreement, and the card resolves every disagreement to the simulator.
  //    Discarded in this direction exactly as an APPROVE is discarded in the
  //    other — the asymmetry would otherwise be a licence to veto for free.
  if (model.reason === 'would_revert') {
    overrides.push(
      'critic VETO(would_revert) discarded: uncorroborated — the simulator says the call succeeds',
    );
    return {
      approved: true,
      decidedBy: 'simulator',
      detail: 'uncorroborated revert claim; the simulate is authoritative',
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  if (model.reason === 'over_budget') {
    overrides.push(
      `critic VETO(over_budget) discarded: the projection says ${facts.budget}, and the arithmetic decides`,
    );
    return {
      approved: true,
      decidedBy: 'arithmetic',
      detail: 'uncorroborated overspend claim; the projection is authoritative',
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  // 6. A veto with no reason is not a finding. `none` is the APPROVE sentinel,
  //    so a VETO carrying it is schema-valid and semantically empty — there is
  //    no closed-enum value to record against the item, and inventing one would
  //    be worse than discarding it.
  if (model.reason === NO_REASON) {
    overrides.push('critic VETO discarded: no reason given');
    return {
      approved: true,
      decidedBy: 'default',
      detail: 'veto carried no reason from the closed enum',
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  // 7. A veto must CITE. The prompt requires the contradicted line quoted
  //    verbatim, and this is that requirement made real rather than hoped for.
  //    Deliberate, and it cuts one way: an uncited veto is discarded, because
  //    the hard bar is zero false vetoes and "this looks wrong" is not evidence.
  //    The quote is checked for existence only — not matched against the
  //    evidence text, because a model that paraphrases a real contradiction has
  //    still found one, and substring matching would discard it for style.
  if (model.evidenceQuote.trim() === '') {
    overrides.push(`critic VETO(${model.reason}) discarded: no evidence quoted`);
    return {
      approved: true,
      decidedBy: 'default',
      detail: 'veto cited no evidence',
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  // 8. What is left is the judgement only the model can make.
  if (MODEL_OWNED.has(model.reason)) {
    return {
      approved: false,
      reason: model.reason,
      decidedBy: 'critic',
      detail: model.justification,
      overrides,
      criticConsulted: true,
      ...withModel,
    };
  }

  /* c8 ignore next 9 -- unreachable: the enum has four members and all are handled above */
  overrides.push(`critic VETO(${String(model.reason)}) discarded: unrecognised reason`);
  return {
    approved: true,
    decidedBy: 'default',
    detail: 'veto carried a reason outside the closed enum',
    overrides,
    criticConsulted: true,
    ...withModel,
  };
}
