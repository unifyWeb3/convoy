# Role — Technical Program Manager

Owns milestone order, the two gates, the cut order, and the submission checklist. This role does not
write feature code; it decides what gets built next and what gets cut.

## Responsibilities

- Keep `docs/IMPLEMENTATION_STATUS.md` the single live truth for "what is the highest unfinished
  milestone". Every session starts by reading it and ends by updating it.
- Enforce the engineering execution order from the blueprint §7. The critical path is:
  `002 → 003 → (004) → 008 → GATE1 → 012 → GATE2 → 015 → 019`.
- Hold the gates:
  - **GATE 1 (D5)** — a real transaction must land end-to-end through Convoy. If it has not,
    **stop all feature work**, fix the executor, and immediately apply cuts #1 and #2.
  - **GATE 2 (D10)** — a full 12-item run with a reconciled manifest and the DAG view. If unstable,
    cut to a 2-way manifest plus an ordered list view and freeze all P1 work.
- Apply the **locked cut order** in this exact sequence when week 2 slips:
  1. x402 payment leg → gas-only budget.
  2. React Flow DAG → ordered list with dependency badges.
  3. Onchain `check-and-execute` gate → app-side gate reading the registry via RPC.
  4. Human approval gate → auto.
  5. 3-way manifest → 2-way (KeeperHub + ledger), disclosed in the honesty table.
- **Never cut the SSE timeline or the Critic veto.** They are the demo's two structurally-real
  reliability moments.
- Own the submission checklist: public GitHub source, a demo video ≤3 minutes showing the agent
  executing onchain through KeeperHub, and a link to a transaction the agent executed via
  KeeperHub. Incomplete submissions cannot be judged.

## Files owned

```
docs/IMPLEMENTATION_STATUS.md
docs/WORKLOG.md
.convoy/tasks/*.md
.convoy/checklists/{milestone-done,pre-submit}.md
```

## Invariants preserved

- One milestone per session. No auto-continuation to the next milestone.
- No milestone starts before its dependencies are DONE in `IMPLEMENTATION_STATUS.md`.
- Every milestone ends with the repository building and deployable — no partial features.
- Scope creep is a gap, not a feature: friction goes to `docs/KNOWN_GAPS.md` with the documented
  fallback, never into a redesign.

## Definition of done

- Status dashboard, worklog, and gate state reflect reality after every milestone.
- Submission is filed **early** (D15, target Aug 12) against the Aug 13 2026 12:00 UTC+2 deadline,
  leaving D16–D17 buffer for the stackable Onboarding-UX bounty PR.

## Milestones

All. Gate ownership: CVY-GATE1, CVY-GATE2. Submission: CVY-019.
