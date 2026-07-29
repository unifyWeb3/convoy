# Recovery playbook

The block below is the frozen recovery playbook from the Implementation Blueprint §3.

```markdown
# Recovery after an interrupted AI session

1. git status; git log --oneline -15. Uncommitted work? Finish or `git stash`.
2. Read docs/WORKLOG.md tail (last completed milestone + notes).
3. Read docs/IMPLEMENTATION_STATUS.md — the live truth. Trust it over memory.
4. Health gate: pnpm install && pnpm --filter @convoy/db db:generate && pnpm -r build && pnpm -r test
   && (cd packages/contracts && forge test)
   - Green → clean milestone boundary; proceed to highest unfinished milestone.
   - Red → last milestone broke "repo always builds". Fix ONLY the break; no new scope.
     If it's a KH/SDK gap, record in KNOWN_GAPS and use the documented fallback.
5. Run stuck mid-execution (worker crash): run services/worker reconcile. For each item in SUBMITTED,
   GET /status by execution_id from `attempts`: completed+txHash → LANDED; failed → RETRYING/FAILED per
   rules; unknown & no execution_id → re-issue with the SAME Idempotency-Key runId:idx:attempt (dedupe protects).
6. Never re-broadcast without the original Idempotency-Key. Never invent a tx hash.
7. Update WORKLOG.md with what you recovered and how.
```

## Health gate, verbatim

```bash
pnpm install \
  && pnpm --filter @convoy/db db:generate \
  && pnpm -r build \
  && pnpm -r test \
  && (cd packages/contracts && forge test)
```

## Item reconciliation rules (step 5, expanded)

For every item **not** in a terminal state (`LANDED`, `VETOED`, `FAILED`, `SKIPPED`):

| Observed                                                                                         | Action                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `attempts` row has `execution_id`, status `completed` + non-null `transactionHash`               | → `LANDED`. Record hash, `transactionLink`, `gasUsedWei`.                                                                            |
| `execution_id` present, status `failed`, coded transient (`E-000x`/`N-000x`/`P-000x`/`C-0001-2`) | → `RETRYING` if the attempt cap is not reached, else `FAILED`.                                                                       |
| `execution_id` present, status `failed`, **config-revert** (full message, no code)               | → `FAILED`. **Never retry.**                                                                                                         |
| `execution_id` present, status `pending`/`running`                                               | Keep polling; honour `X-Poll-Interval-Hint`.                                                                                         |
| No `execution_id` recorded                                                                       | Re-issue the write with the **same** `Idempotency-Key: runId:idx:attempt`. Per-org dedupe (24h) protects against a double broadcast. |
| 409 `idempotency_in_progress`                                                                    | Back off and retry the same key.                                                                                                     |
| 409 `idempotency_conflict`                                                                       | This is a bug in Convoy. Fail the item and record it in `docs/KNOWN_GAPS.md`.                                                        |

## Hard rules

- Never re-broadcast without the original idempotency key.
- Never invent a transaction hash. If you cannot find one, the item is not `LANDED`.
- Never set a nonce while recovering. Nonce ordering belongs to KeeperHub.
- Convoy retries only its own faults. Onchain retries are KeeperHub's and are only observed.
- The onchain `committed[runId][idx]` one-shot plus `DupIndex()` is the last line of defence: even a
  double submit cannot double-commit.

## After recovery

Append to `docs/WORKLOG.md`: what was interrupted, what state was found, what was reconciled, which
execution ids and hashes were involved, and whether any gap was recorded.
