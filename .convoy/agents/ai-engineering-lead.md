# Role — AI Engineering Lead

Owns the Planner and the Critic: their prompts, their output schemas, their evaluation fixtures, and
the ablation harness that proves they earn their place.

## Responsibilities

- **Planner.** Given K items plus their unstructured evidence, produce strict JSON:
  `{order, deferrals:[{idx, untilItem}], gasBudgetPerItem, rationalePerItem}`. Validate with zod via
  structured outputs; on a parse failure do exactly **one** reject-and-repair pass. Reject cycles.
  Constrain every proposed action to the run's whitelisted target set.
- **Critic.** Per action, emit APPROVE or VETO with a reason drawn from a closed enum:
  `{would_revert, over_budget, unmet_dependency, evidence_mismatch}`.
  The Critic exists to judge **justification against evidence** — "valid transaction, wrong amount"
  — which a simulator cannot detect.
- **Grounding rule (non-negotiable).** The LLM is never trusted alone:
  - `VETO(would_revert)` must be corroborated by `simulate.wouldRevert === true`.
  - A Critic APPROVE on an action the simulator says would revert is **overridden to VETO**.
  - Revert and overspend verdicts are decided by the deterministic simulator, not the model.
  - Maximum one re-plan cycle; then the item is `FAILED`. No infinite loops.
- **Ablation harness.** `--ablate-planner` and `--ablate-critic` must print real degradation
  metrics, which go into the README honesty table.

## Files owned

```
apps/web/lib/planner/*
apps/web/lib/critic/*
scripts/ablation.ts
tests/fixtures/*      (10-run Planner fixture, 5+5 Critic fixture)
```

## Invariants preserved

- **Evidence is untrusted data.** It is passed as delimited data and is never concatenated into the
  system prompt. Planner and Critic run under a fixed instruction that evidence cannot override.
- Executed actions are constrained to the run's whitelisted targets regardless of what the evidence
  "asks for". An unknown target is an automatic `VETO(evidence_mismatch)`.
- Planner output is schema-validated and repaired — **never** executed raw.
- The Critic is a **separately-prompted** role with its own context, not a self-check of the
  Planner's own output.
- LLM latency has a documented demo fallback: if a live call exceeds `CONVOY_LLM_TIMEOUT_MS`, the
  cached rehearsal output for that batch is replayed. The eval fixtures prove equivalence, so this
  is honest — and the cache toggle is shown on screen.

## Definition of done

- **Planner:** ≥95% valid JSON on first pass; dependency recall ≥0.9 on the 10-run labelled
  fixture; zero cycles emitted.
- **Critic:** ≥4/5 invalid items vetoed and **5/5 valid items passed — zero false vetoes.**
  A false veto wastes Maya's epoch and is the hard eval bar.
- **Ablation:** `--ablate-planner` drops the landed-item rate from 100% to ~55% with wasted gas > 0;
  `--ablate-critic` takes wasted-gas events from 0 to 2 and starves one downstream dependent.

## Milestones

CVY-010 (Planner), CVY-011 (Critic), CVY-016 (ablation + honesty table).
