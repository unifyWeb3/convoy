# Template — pull request

One milestone per PR. Title uses conventional-commit form:
`feat(scope): subject` — e.g. `feat(kh-client): add simulate, status polling and error classifier`.

---

## CVY-NNN — <title>

### What this does

<one paragraph: the objective from the task card and what now works that did not before>

### Scope

- Milestone: `CVY-NNN` (task card: `.convoy/tasks/CVY-NNN.md`)
- Dependencies (DONE in `docs/IMPLEMENTATION_STATUS.md`): <list>
- **This PR contains exactly one milestone and no other feature work.**

### Files changed

```
<list — must match the task card's "Files expected">
```

### Acceptance criteria

| Criterion            | Met | Evidence        |
| -------------------- | --- | --------------- |
| <from the task card> | ✅  | <output / link> |

### Verification

```
$ pnpm format:check
$ pnpm -r lint
$ pnpm -r typecheck
$ pnpm -r build
$ pnpm -r test
$ cd packages/contracts && forge fmt --check && forge build && forge test   # if contracts touched
```

<paste real output>

### KeeperHub proof

<simulate response body, or transaction hash + Basescan link — or "N/A, integration not touched">

### Invariant checklist

- [ ] No `app.keeperhub.com` access outside `packages/kh-client`.
- [ ] No nonce set anywhere.
- [ ] No private key referenced outside `packages/contracts/script`.
- [ ] No staged failure, injected fault, or fabricated hash.
- [ ] Every state transition transactional, emitting exactly one `events` row.
- [ ] Chain pinned to Base 8453; no `eth_getLogs` on a public RPC.
- [ ] Architecture unchanged; friction recorded in `docs/KNOWN_GAPS.md` rather than redesigned.
- [ ] No kill-list item resurrected.

### Documentation

- [ ] `docs/WORKLOG.md` appended
- [ ] `docs/IMPLEMENTATION_STATUS.md` updated
- [ ] `docs/KNOWN_GAPS.md` updated (if friction)
- [ ] `docs/DECISIONS.md` updated (if a decision was made)
- [ ] README honesty table updated (if a claim gained or lost an artifact)

### Rollback

<the rollback step from the task card>

### Risk

<what could break, and what would surface it>
