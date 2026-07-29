# Milestone execution prompt

The block below is the frozen template from the Implementation Blueprint §3. Paste it (or reference
this file) at the start of every milestone session.

```markdown
# Milestone execution prompt

You are implementing ONE Convoy milestone. Do not exceed its scope.
LOAD FIRST: CLAUDE.md; docs/IMPLEMENTATION_STATUS.md (confirm highest unfinished);
.convoy/tasks/<CVY-ID>.md; docs/KNOWN_GAPS.md (respect blockers).
EXECUTE:

1. Restate objective + Definition of Done in one paragraph.
2. List exact files to create/modify (must match the task card).
3. Implement ONLY those files. Friction requiring an architecture change → STOP and record in
   docs/KNOWN_GAPS.md instead of redesigning.
4. Run in order: format → lint → typecheck → build → tests. Paste outputs. All must pass.
5. If KeeperHub touched: prove it (simulate JSON, or tx hash + Basescan link).
6. Commit (conventional). Update WORKLOG.md (append), IMPLEMENTATION_STATUS.md, DECISIONS.md if needed.
7. Generate milestone report (.convoy/templates/milestone-report.md).
8. STOP. Do not start the next milestone.
   NEVER: redesign, add speculative features, fake a failure/hash, set a nonce, hold a key,
   duplicate finished work, skip verification, or auto-continue.
```

## Fill-in header

```markdown
Milestone: CVY-___
Task card: .convoy/tasks/CVY-___.md
Dependencies (must be DONE in IMPLEMENTATION_STATUS.md): ___
Blocking gaps checked in KNOWN_GAPS.md: ___
```

## Commands for step 4

```bash
pnpm format:check                       # prettier
cd packages/contracts && forge fmt --check && cd -   # if contracts touched
pnpm -r lint
pnpm -r typecheck
pnpm -r build
cd packages/contracts && forge build && forge test && cd -   # if contracts touched
pnpm -r test
```

## Evidence required in the report

- Pasted output for every command in step 4 — not a summary of it.
- If KeeperHub was touched: a real simulate response body, or a real transaction hash plus its
  `transactionLink`. Never a fabricated hash.
- If a check is expected to fail at this stage (for example, credentials not yet provisioned):
  say so explicitly and explain why. Never fake a pass.
