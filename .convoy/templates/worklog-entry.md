# Template — WORKLOG entry

`docs/WORKLOG.md` is **append-only**. Never edit or delete an existing entry. Copy the block below,
fill it in, and append it to the end of the file.

```markdown
## YYYY-MM-DD — CVY-NNN <short title>

Summary: <one or two sentences: what was implemented and what now works>
Files: <comma-separated paths created or modified>
Commit: <short hash>
Verification: <pasted-command results in one line each, e.g. "forge test 18 passed; forge fmt --check clean; pnpm -r build 4 packages">
Notes: <friction, decisions, gaps recorded, expected failures — or "No gaps.">
```

## Worked example (from the blueprint)

```markdown
## 2026-07-29 — CVY-001 ConvoyRegistry + tests

Summary: Implemented ConvoyRegistry + MockRewardDistributor; unit + invariant tests green.
Files: packages/contracts/src/ConvoyRegistry.sol, .../MockRewardDistributor.sol, test/*.t.sol, foundry.toml
Commit: a1b2c3d
Verification: forge test 18 passed; forge fmt --check clean; invariants runs=1000 depth=32.
Notes: NotOperator revert is the genuine invalid-input source for the Critic. No gaps.
```

## Rules

- One entry per milestone. A recovery session gets its own entry describing what was reconciled.
- `Verification` records **actual** output, never an intention. If a check failed and the failure was
  expected (missing credentials, undeployed contract), name it and say why.
- If a gap was recorded, reference its ID (`G-NN`). If a decision was made, reference it (`D-NNN`).
- Never record a transaction hash that was not produced by a real execution.
