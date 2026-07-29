# Template — milestone report

Generated at the end of every milestone session, immediately before stopping.

---

# CVY-NNN — <title> · Milestone Report

**Date:** YYYY-MM-DD · **Roadmap day:** D<n> · **Priority:** P<n> · **Effort:** <estimate> → <actual>

## 1. Objective and Definition of Done

**Objective:** <one paragraph, restated from the task card>

**Definition of Done:**

| DoD criterion                  | Met?          | Evidence                     |
| ------------------------------ | ------------- | ---------------------------- |
| <criterion from the task card> | ✅ / ❌ / N/A | <command output, file, link> |

## 2. Toolchain

| Tool                 | Required    | Installed | Status |
| -------------------- | ----------- | --------- | ------ |
| Node                 | 22.x        | <version> | ✅     |
| pnpm                 | ≥9          | <version> | ✅     |
| forge / cast / anvil | any current | <version> | ✅     |
| psql                 | ≥14         | <version> | ✅     |
| redis-server         | ≥6          | <version> | ✅     |
| git                  | ≥2.30       | <version> | ✅     |

## 3. Files and directories created or modified

```
<tree or list — must match the task card's "Files expected">
```

## 4. Command outputs

Paste real output. Do not summarise.

```
$ pnpm install
<output>

$ pnpm -r build
<output>

$ pnpm -r typecheck
<output>

$ pnpm -r lint
<output>

$ pnpm -r test
<output>

$ cd packages/contracts && forge fmt --check && forge build && forge test    # if contracts touched
<output>

$ pnpm tsx scripts/verify-env.ts
<output>
```

## 5. PASS/FAIL matrix

| Check   | Result      | Note                                                            |
| ------- | ----------- | --------------------------------------------------------------- |
| <check> | PASS / FAIL | <for every FAIL: why, and whether it is expected at this stage> |

**Expected failures at this stage:** <list them explicitly with the reason. Never fake a pass.>

## 6. KeeperHub proof (if the integration was touched)

- Simulate response body, **or**
- Transaction hash + `transactionLink` (Basescan), produced by this milestone's code.

<paste, or "N/A — KeeperHub not touched in this milestone.">

## 7. Gaps recorded

| ID   | Description | Impact | Fallback | Status |
| ---- | ----------- | ------ | -------- | ------ |
| G-NN |             |        |          |        |

<or "No new gaps.">

## 8. Decisions recorded

`D-NNN <date>: <decision>, <rationale>` — or "No decisions required."

## 9. Architecture invariants

- [ ] Repository builds; milestone ends deployable.
- [ ] No `app.keeperhub.com` access outside `packages/kh-client`.
- [ ] No nonce set anywhere; no key held anywhere; no staged failure anywhere.
- [ ] State transitions transactional, one `events` row each.
- [ ] Kill-list items not resurrected.

## 10. Commit

`<hash>` — `<conventional commit message>`

## 11. Next milestone

**CVY-NNN — <title>.** Dependencies: <list, with status>. Blocking inputs still needed from the
operator: <secrets, credentials, approvals — or "none">.

**STOP.** This session does not continue into the next milestone.
