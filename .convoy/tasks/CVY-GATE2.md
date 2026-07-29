# CVY-GATE2 — GATE 2: full 12-item run, manifest reconcile, DAG view

**Roadmap:** D10 · **Priority:** P0/P1 · **Type:** Hard checkpoint (not a feature milestone)

## Objective

Prove the complete demo path works at full size: a 12-item interdependent batch runs end to end,
the manifest reconciles, and the dependency graph renders live.

## Dependencies

CVY-009, CVY-010, CVY-011, CVY-012, CVY-013.

## Acceptance criteria

- A **full 12-item run** completes: plan → critique → execute → seal.
- At least two items are genuinely `VETOED` by the simulate gate, with decoded revert reasons and a
  zero-gas badge.
- At least one item is `DEFERRED` and releases only after its dependency reaches `LANDED`.
- The manifest reconciles **three ways** and shows all-green (or honest amber, explained).
- The DAG view renders live, coloured by state, with dashed edges for deferrals.
- The timeline survives a mid-run refresh.
- Every hash is real and click-through verifiable on Basescan.

## Verification steps

```bash
curl -X POST localhost:3000/api/runs -d @tests/fixtures/batch-12item.json
# watch the timeline; refresh mid-run; export the manifest at the end
pnpm --filter @convoy/web exec playwright test demo.spec.ts
```

## Gate decision

**PASS** — the 12-item run is stable → proceed to CVY-015 (crash-resume) and CVY-016 (ablation).

**FAIL / unstable by end of D10** → **freeze all P1 work** and apply the cut order:

- Cut #2: React Flow DAG → ordered list with dependency badges.
- Cut #5: 3-way manifest → 2-way (KeeperHub + ledger), disclosed in the honesty table.

**Never cut the timeline or the Critic veto** — they are the demo's two structurally-real
reliability moments. Record the gate outcome and any applied cuts in
`docs/IMPLEMENTATION_STATUS.md` and `docs/WORKLOG.md`.

## Rollback

Not applicable — a gate produces a decision, not an artifact.

## Effort

Checkpoint only (folded into D10).

## Deliverables

A recorded gate decision backed by a full 12-item run, its manifest export, and — on failure — the
applied cuts and the P1 freeze.
