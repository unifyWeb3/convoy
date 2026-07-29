# Milestone-done checklist

Run this before declaring any CVY-XXX complete. Every box must be YES, or the milestone is not done.

## Scope

- [ ] Exactly one milestone was implemented. The next milestone was **not** started.
- [ ] Every file created or modified appears in the milestone's task card `Files expected` list.
- [ ] Nothing speculative was added. No feature outside the frozen spec.
- [ ] No completed work was duplicated or overwritten.

## Acceptance

- [ ] Every acceptance criterion on the task card is met, individually and explicitly.
- [ ] Every verification step on the task card was executed, with output pasted.
- [ ] The rollback path on the task card is accurate and would actually work.

## Verification (all pasted, not summarised)

- [ ] `pnpm format:check` clean.
- [ ] `pnpm -r lint` clean.
- [ ] `pnpm -r typecheck` clean.
- [ ] `pnpm -r build` succeeds.
- [ ] `pnpm -r test` passes.
- [ ] `forge fmt --check && forge build && forge test` pass — if contracts were touched.
- [ ] Expected failures (missing credentials, undeployed contracts) are **named and explained**,
      never faked into passing.

## Invariants

- [ ] Repository builds; the milestone ends deployable.
- [ ] No partial feature — the feature is complete or its cut is documented.
- [ ] No `app.keeperhub.com` access outside `packages/kh-client`.
- [ ] No nonce set anywhere.
- [ ] No private key held anywhere outside `packages/contracts/script`.
- [ ] No staged failure, injected gas spike, fabricated hash, or fabricated retry.
- [ ] Every state transition is transactional and emits exactly one `events` row.
- [ ] The chain stays pinned to Base 8453; no `eth_getLogs` on a public RPC.

## KeeperHub proof (if the integration was touched)

- [ ] A real `simulate:true` response body, **or** a real transaction hash with its
      `transactionLink`, is attached.
- [ ] The proof was produced by this milestone's code, not copied from an earlier run.

## Documentation

- [ ] `docs/WORKLOG.md` appended with a dated entry (summary, files, commit, verification, notes).
- [ ] `docs/IMPLEMENTATION_STATUS.md` updated: this milestone DONE, next milestone named, overall
      percentage and gate state refreshed.
- [ ] `docs/KNOWN_GAPS.md` updated if there was any friction.
- [ ] `docs/DECISIONS.md` updated if any decision was made (`D-NNN <date>: decision, rationale`).
- [ ] `docs/TESTING.md` updated if tests were added.
- [ ] `docs/DEPLOYMENT.md` updated if deployment or rollback changed.
- [ ] README honesty table updated if a claim gained or lost an artifact.

## Close-out

- [ ] Conventional commit created, scoped to this milestone only.
- [ ] Milestone report generated from `.convoy/templates/milestone-report.md`.
- [ ] **Session STOPS.** No auto-continuation.
