# Demo playbook (3:00)

The script is frozen in `docs/ARCHITECTURE.md` §15. This playbook is the operational version:
what is on screen, what is said, what must be true beforehand, and what to do when something breaks.

## Pre-flight (morning of)

- [ ] Deploy web; freeze the environment afterwards.
- [ ] Worker running on its always-on host (or locally) — confirm it is consuming jobs.
- [ ] `pnpm tsx scripts/verify-env.ts` — every row PASS.
- [ ] Org wallet funded with a few dollars of Base ETH. **Gas sponsorship is never load-bearing.**
- [ ] Run one **real morning batch**; its hashes are now on Basescan (this is backup path a).
- [ ] Open tabs: Convoy `/`, Basescan, the history tab showing a prior run that genuinely retried.
- [ ] Rehearsal Planner/Critic outputs cached; the cache toggle is visible.

## Beat sheet

| Time      | Screen                                                                                                                                                                          | Narration                                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:30 | `/runs/new` — a realistic epoch batch (publish root, fund distributor, enable 3 markets, rotate allowance, poke oracle) with evidence blobs and a USDC budget. Click **Start**. | "This is one epoch's release for a small protocol — twelve interdependent onchain actions, some with ordering rules buried in these notes, a real budget, a deadline. Today an engineer babysits this for an hour. Watch Convoy do it."                                                                                             |
| ~0:25     | `openRun` executes through KeeperHub — **the first real Base transaction hash lands.**                                                                                          | The submission requirement is satisfied in the first 30 seconds.                                                                                                                                                                                                                                                                    |
| 0:30–1:00 | The DAG builds; Planner reasons appear; two items flip **VETOED** with a decoded `revertReason` and a "0 gas" badge.                                                            | "Planner read the evidence and built an execution graph — this fund step is deferred until the root is published. Now a _separate_ Critic checks every action against a real KeeperHub simulation. Those two would have reverted onchain. Convoy caught them before spending a cent — and the simulation is KeeperHub's, not ours." |
| 1:00–2:00 | Items land in DAG order; the budget meter drains; hashes stream to Basescan. A genuine transient surfaces a retry chip if one occurs.                                           | "Everything executes through KeeperHub's org wallet — one wallet, one sequential nonce. Convoy submits the ready items concurrently; KeeperHub serializes them on the nonce and reprices the one that came back underpriced. We didn't script that retry — it's real."                                                              |
| 2:00–3:00 | The deferred item releases and executes; `sealRun` lands; the 3-way reconciliation table goes all-green; **Export manifest**. Then toggle `--ablate-critic` on a prior run.     | "One sealed run, one replayable manifest reconciling KeeperHub's audit, the onchain registry, and our ledger — the artifact the DAO actually wants. Remove the Critic and those two burn gas and starve a downstream item. That's why the AI is load-bearing, and why this only works on KeeperHub."                                |

## The two anchors that always work

The reliability moment must **not** depend on a live failure:

1. **Two real simulate-vetoes** — deterministic, happens every run.
2. **Nonce serialization of concurrent submits** — deterministic, happens every run.

A genuine transient retry is a bonus. If one does not occur, narrate the serialization and point to
a prior run in the history tab that **did** retry, with real hashes.

## Backup paths (all four rehearsed at CVY-019)

| #   | Failure                   | Response                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | KeeperHub API degradation | Switch the kh-client to the **CLI path** live: `kh ex cc --chain --contract --method --args --wait`. If KeeperHub is fully down, play the **pre-recorded morning run** and open Basescan live to prove the hashes are real. **Never fake a hash.** Note: the CLI has no `--simulate` and no `--value` (gap G-05) — simulate is REST-only. |
| b   | Base RPC issues           | Reads use the dedicated pinned RPC (84532 unconditionally, DEC-001). Hot-swap `BASE_RPC_URL_FALLBACK`. Manifest reconciliation is cached from the run, so it renders without a live RPC.                                                                                                                                                  |
| c   | LLM latency or timeout    | If a live call exceeds `CONVOY_LLM_TIMEOUT_MS` (8s), replay the cached rehearsal output for this batch — same result, and honest, because the eval fixtures prove the agents produce it. Show the cache toggle on screen.                                                                                                                 |
| d   | No genuine retry on cue   | Do nothing. Narrate the deterministic anchors and point at the prior retried run. **Never inject a fault.**                                                                                                                                                                                                                               |

## Never, during a demo

- Never fabricate a transaction hash, a retry, or a gas spike.
- Never stage a failure to create drama. The vetoes are real; that is the drama.
- Never claim a specific repricing number beyond "at least 10%".
- Never claim gas sponsorship — the org wallet is self-funded by design.
