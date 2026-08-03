# Testing

The test catalog from Implementation Blueprint §9. Rows are implemented by the milestone named in the
last column; at CVY-000 the harnesses exist and the suites are empty. As of CVY-001 the three
contract rows are implemented and green — 45 Foundry tests, invariants at `runs=1000 depth=32`. As
of CVY-002 the payloadHash-parity row is green too — 47 assertions over 13 dumped fixtures.

## Catalog

| Layer              | Test name(s)                                                                                                                                                                     | Command                                            | Milestone         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| Contract unit      | `test_openRun_setsOpen`, `test_commitAction_revertsNotOpen`, `test_commitAction_revertsDupIndex`, `test_sealRun_revertsNothingCommitted`, `test_commitAction_revertsNotOperator` | `cd packages/contracts && forge test`              | CVY-001           |
| Invariant          | `invariant_noCommitBeforeOpen`, `invariant_noDoubleSeal`, `invariant_idxMonotonic`, `invariant_committedCountMatches`                                                            | `forge test --match-path 'test/*.invariant.t.sol'` | CVY-001           |
| Contract fmt/build | —                                                                                                                                                                                | `forge fmt --check && forge build`                 | CVY-001           |
| payloadHash parity | `payloadHash.parity.test.ts` (13 dumped fixtures × 3 assertions + 8 behavioural)                                                                                                 | `pnpm --filter @convoy/kh-client test`             | CVY-002           |
| kh-client (VCR)    | `contractCall.simulate.wouldRevert.test.ts`, `contractCall.write.executionId.test.ts`, `status.pollHint.test.ts`, `errors.classify.test.ts`, `idempotency.key.test.ts`           | `pnpm --filter @convoy/kh-client test`             | CVY-004           |
| DB                 | `schema.migrate.test.ts`, `seed.fixtures.test.ts`                                                                                                                                | `pnpm --filter @convoy/db test`                    | CVY-005           |
| Queue              | `queue.dedupeJobId.test.ts`, `worker.gracefulShutdown.test.ts`                                                                                                                   | `pnpm --filter @convoy/worker test`                | CVY-006           |
| State machine      | `orchestrator.3item.e2e.test.ts`, `guards.committedRequiresApprove.test.ts`, `guards.landedRequiresTxHash.test.ts`                                                               | `pnpm --filter @convoy/worker test`                | CVY-008           |
| Planner eval       | `planner.recall.eval.ts` (≥0.9), `planner.validJson.eval.ts` (≥95%)                                                                                                              | `pnpm tsx tests/planner.recall.eval.ts`            | CVY-010           |
| Critic eval        | `critic.veto.eval.ts` (≥4/5 invalid, 5/5 valid, 0 false)                                                                                                                         | `pnpm tsx tests/critic.veto.eval.ts`               | CVY-011           |
| Simulation         | `critic.corroboration.test.ts` (APPROVE overridden to VETO)                                                                                                                      | vitest                                             | CVY-011           |
| Retry              | `retry.transientOnly.test.ts` (retries E-0002/N-0001, never config-revert)                                                                                                       | vitest                                             | CVY-008           |
| Failure recovery   | `reconcile.crashResume.test.ts`, `killworker.noDuplicateTx.test.ts`                                                                                                              | `pnpm --filter @convoy/worker test`                | CVY-015           |
| API                | `api.runs.create.test.ts`, `api.stream.replay.test.ts`, `api.manifest.export.test.ts`                                                                                            | `pnpm --filter @convoy/web test`                   | CVY-009 / CVY-012 |
| Frontend           | `timeline.render.test.tsx`, `budgetMeter.amber.test.tsx`                                                                                                                         | vitest                                             | CVY-007 / CVY-009 |
| E2E                | `demo.spec.ts` (the exact 3:00 run), `refresh.replay.spec.ts`                                                                                                                    | `pnpm --filter @convoy/web exec playwright test`   | CVY-009 / CVY-019 |
| Regression         | full `pnpm -r test && forge test` on every PR                                                                                                                                    | `.github/workflows/ci.yml`                         | CVY-000           |
| Deploy verify      | `scripts/verify-env.ts` PASS/FAIL matrix; Basescan verified check                                                                                                                | `pnpm tsx scripts/verify-env.ts`                   | CVY-000           |
| Demo validation    | daily Playwright `demo.spec.ts` (week 3)                                                                                                                                         | scheduled CI                                       | CVY-019           |

## Integration modes

Toggled by `CONVOY_KH_MODE`:

- **`live`** — Base Sepolia (84532) against the real KeeperHub API. Used for rehearsal and smoke
  tests before any mainnet run.
- **`vcr`** — recorded fixture tapes replayed offline. Keeps UI development unblocked when
  KeeperHub is unavailable or credentials are absent.

## Reading the invariant suite (CVY-001)

`foundry.toml` freezes `[invariant] fail_on_revert = false`. That setting silently discards a fuzz
call that reverts, so a handler which rejects nearly everything still reports 1000 green runs while
having exercised almost nothing (gap G-13). `ConvoyRegistryHandler` therefore:

- wraps every registry call in `try/catch` and counts **accepted vs rejected** calls per function,
  printed by `afterInvariant()` — run with `-vv` to see the campaign's real depth;
- biases the actor for `commitAction` / `sealRun` towards the run's own operator (one seed in four
  still picks at random, keeping `NotOperator()` reachable). Uniform actor selection was measured
  landing `accepted open/commit/seal: 4 0 0` — the lifecycle never got past its first commit;
- is backed by `test_handler_reachesEveryState`, a deterministic test proving every accepted and
  every rejected path is reachable, so the fuzz counters measure a real lifecycle.

`invariant_idxMonotonic` asserts monotonicity of the **sequence** (`committedCount`, emitted as
`seq`), not of `idx`: the frozen contract accepts any non-duplicate `idx` and enforces ordering
through the counter. The name is the blueprint's and was kept.

## Reading the payloadHash parity suite (CVY-002)

`tests/fixtures/payloadHash.fixtures.json` is **generated**, not hand-written — a hand-written
fixture only proves TypeScript agrees with what its author believed Solidity does. Regenerate it
with:

```bash
cd packages/contracts && forge script script/DumpPayloadHashFixtures.s.sol
```

The dump is deterministic: re-running leaves the file byte-identical, so `git diff` silence is itself
evidence the committed fixtures came from the committed script. The file is `.prettierignore`d for
the same reason (D-014).

Each fixture carries `argTypes` + `argValues` rather than only the precomputed `args` bytes, so the
test re-encodes the arguments in TypeScript and asserts (a) the bytes equal Solidity's and (b) the
hash matches (D-012). The cases chosen are the ones where an encoder realistically diverges: empty
args (Solidity's zero-length `bytes` vs viem's `"0x"`), an empty function name, a 103-character
function name crossing word boundaries, multi-byte UTF-8 in a `string`, a 33-byte `bytes` blob,
`address[]`, `uint256[]`, a negative `int256`, `uint256` max, and `idx` at `uint256` max.

**If a case fails, do not switch to the documented fallback encoding to make it green.** That is a
frozen-spec change requiring a numbered decision, and it would mask what is almost certainly a
fixture-plumbing or argument-encoding bug. **Falsifiability:** adding 1 to `idx` inside
`payloadHash()` fails 26 of the 47 assertions.

## Reading the invariant suite — falsifiability (CVY-001)

**Falsifiability.** The two counting invariants were mutation-tested: changing the contract's
`committedCount += 1` to `+= 2` fails both `invariant_idxMonotonic` and
`invariant_committedCountMatches` on the first accepted commit. Their ghost counters are derived by
the handler itself, never assigned from a registry read, so they are expectations the registry can
contradict rather than mirrors of it. `invariant_noCommitBeforeOpen` is the weakest of the five in a
fuzz campaign — all four runs get opened within the first few calls, so its pre-open branch goes
dead and it mainly guards that an opened run never returns to `None`. The pre-open property is
pinned directly by `test_commitAction_revertsNotOpen`. Re-run the mutation whenever the handler's
ghost state is refactored.

## Running everything

```bash
pnpm format:check
pnpm -r lint
pnpm -r typecheck
pnpm -r build
pnpm -r test
(cd packages/contracts && forge fmt --check && forge build && forge test)
pnpm tsx scripts/verify-env.ts
```

## Testing rules

- **Never stage a failure to make a test pass or a demo dramatic.** Invalid items point at
  `MockRewardDistributor`, which genuinely reverts. That is the only source of failure in the system.
- Fabricated transaction hashes are banned in non-test code and are caught by a CI grep-guard.
- Tests that need credentials the repository does not have must **fail loudly or skip explicitly** —
  never assert a fake pass.
- Agent evals are gates, not diagnostics: the Critic's `5/5 valid, zero false vetoes` bar blocks the
  milestone.
- The kill-worker test is the reliability centrepiece and is never cut.
