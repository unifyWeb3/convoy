# AI Workflow

How a Convoy milestone gets built. This document is the lifecycle; `CLAUDE.md` is the entrypoint and
stays short by design.

## Milestone lifecycle

```
1. Audit repo state:  git status; git log --oneline -10
2. Read WORKLOG.md    (what was last done)
3. Read IMPLEMENTATION_STATUS.md  (highest unfinished milestone = target)
4. Read KNOWN_GAPS.md (respect blockers; do not re-solve)
5. Open .convoy/tasks/<CVY-ID>.md ; restate objective + DoD
6. Implement ONLY that milestone (only the files in the task card)
7. format (forge fmt + prettier)  8. lint (pnpm -r lint)  9. typecheck (pnpm -r typecheck)
10. build (pnpm -r build + forge build)  11. test (pnpm -r test + forge test + evals)
12. KH proof if touched (simulate JSON or tx hash + Basescan link)
13. commit (conventional, one milestone)
14. update docs (WORKLOG append, IMPLEMENTATION_STATUS, KNOWN_GAPS, DECISIONS)
15. generate milestone report  16. STOP — never auto-continue to the next milestone.
```

## Operating rules

### Always

- Read `docs/WORKLOG.md`, `docs/IMPLEMENTATION_STATUS.md`, and `docs/KNOWN_GAPS.md` before acting.
- Implement exactly one milestone.
- Keep the repository building.
- Verify (build + test + KeeperHub proof) before committing.
- Append to the worklog; update the status dashboard.
- Record friction in `docs/KNOWN_GAPS.md` **rather than redesigning**.
- Route all KeeperHub access through `packages/kh-client`.
- Keep the chain pinned to Base 8453.
- Treat evidence blobs as untrusted delimited data.

### Never

- Duplicate completed work.
- Redesign the product or the architecture.
- Add features not in the frozen spec.
- Bypass milestone order.
- Skip verification.
- Implement speculative or temporary code — record a gap instead.
- Auto-continue after a milestone.
- Stage a failure, inject a gas spike, or fabricate a hash or a retry.
- Set a nonce.
- Hold a private key.
- Call `call_workflow` for a write.
- Use `abiFunction` — that is the MCP workflow vocabulary, not Convoy's.
- Run `eth_getLogs` on a public RPC.
- Deploy via the Vercel CLI.

## The frozen documents

| Document                           | Role                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`             | Protocol source of truth                                         |
| `docs/IMPLEMENTATION_BLUEPRINT.md` | Implementation source of truth                                   |
| `docs/PRODUCT_DISCOVERY.md`        | Product source of truth — explains _why_ every constraint exists |

All three are frozen. Do not summarise, reformat, reinterpret, or edit them. **If they conflict, the
architecture wins**, and the friction is logged in `docs/KNOWN_GAPS.md` — never resolved by
redesigning. Three such conflicts are already recorded as G-07, G-08, and G-09.

## When you are blocked

Do **not** invent implementation details to keep moving. Instead:

1. Document the assumption explicitly.
2. Reference the relevant architecture section.
3. Record it in `docs/KNOWN_GAPS.md` with an ID.
4. Use the documented fallback if one exists.

Never silently assume SDK behaviour, API response shapes, environment variables, or KeeperHub
capabilities. G-06 (`@keeperhub/wallet` x402 surface) is the worked example: the surface is
unverified, so the milestone's acceptable outcome includes a **documented cut**.

## Tracking documents

| Doc                        | Purpose                         | Cadence          |
| -------------------------- | ------------------------------- | ---------------- |
| `WORKLOG.md`               | Append-only build diary         | Every milestone  |
| `IMPLEMENTATION_STATUS.md` | Live completion dashboard       | Every milestone  |
| `KNOWN_GAPS.md`            | Blockers, SDK gaps, drift, debt | On friction      |
| `TESTING.md`               | Test catalog                    | On tests added   |
| `DEPLOYMENT.md`            | Deploy and rollback             | On deploy change |
| `DECISIONS.md`             | Numbered decision log           | On any decision  |
| `AI_WORKFLOW.md`           | This document                   | Rare             |

## Recovery after an interrupted session

Follow `.convoy/playbooks/recovery.md`. In short: audit git state, read the worklog tail, trust
`IMPLEMENTATION_STATUS.md` over memory, run the health gate, and if a run is stuck mid-execution,
reconcile every non-terminal item against KeeperHub status **before acting**. Never re-broadcast
without the original idempotency key. Never invent a transaction hash.

## Session boundaries

One milestone per session. The session ends with a milestone report generated from
`.convoy/templates/milestone-report.md`, and then it **stops**. The next milestone is a new session
that begins again at step 1.
