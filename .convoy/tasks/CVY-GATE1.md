# CVY-GATE1 — GATE 1: end-to-end thin slice, a real transaction landed via Convoy

**Roadmap:** D5 · **Priority:** P0 · **Type:** Hard checkpoint (not a feature milestone)

## Objective

Prove that a real transaction lands end-to-end **through Convoy** — not through a script, not by
hand. This is the checkpoint that decides whether feature work may continue.

## Dependencies

CVY-003, CVY-004, CVY-005, CVY-006, CVY-007, CVY-008.

## Acceptance criteria

- A 3-item batch is submitted through the API (`POST /api/runs`), not by invoking the worker directly.
- `openRun` lands on Base with a real transaction hash.
- **At least one item reaches `LANDED`** on Base, with a working Basescan `transactionLink`.
- `sealRun` lands and the run reaches a terminal state.
- Every transition is persisted; the run's history survives a process restart.
- All hashes are real. Nothing is staged, mocked, or fabricated.

## Verification steps

```bash
curl -X POST localhost:3000/api/runs -d @tests/fixtures/batch-3item.json
# watch the worker log; then:
psql "$DATABASE_URL" -c "select idx, state from items order by idx;"
psql "$DATABASE_URL" -c "select type, at from events order by at;"
# open every transactionLink and confirm on Basescan
```

## Gate decision

**PASS** — a real transaction landed through Convoy → proceed to the parallel tracks:
CVY-009 (SSE UI), CVY-010→CVY-011 (agents), CVY-013, CVY-014.

**FAIL** — no real transaction landed → **stop all feature work.** Fix the executor first, and
immediately apply the locked cut order:

1. Cut the x402 payment leg → gas-only budget.
2. Cut the React Flow DAG view → ordered list with dependency badges.

Do not proceed to CVY-009 or the agents until this gate passes. Record the gate outcome in
`docs/IMPLEMENTATION_STATUS.md` and `docs/WORKLOG.md` either way.

## Rollback

Not applicable — a gate produces a decision, not an artifact.

## Effort

Checkpoint only (folded into D5).

## Deliverables

A recorded gate decision, the transaction hashes that justify it, and — on failure — the applied
cuts written into `docs/IMPLEMENTATION_STATUS.md`.
