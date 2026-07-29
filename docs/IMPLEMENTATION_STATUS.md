# Convoy Implementation Status (updated 2026-07-29)

Overall: **5% (CVY-000 done)** Next milestone: **CVY-001 — ConvoyRegistry + MockRewardDistributor + Foundry tests**

| ID        | Milestone                                                   | Status      | %   | Notes                                                                       |
| --------- | ----------------------------------------------------------- | ----------- | --- | --------------------------------------------------------------------------- |
| CVY-000   | Repo bootstrap + toolchain                                  | DONE        | 100 | Monorepo builds empty; `.convoy/` populated; CI grep-guards live            |
| CVY-001   | Contracts + Foundry unit/invariant tests                    | TODO        | 0   | **next**                                                                    |
| CVY-002   | payloadHash parity (Sol↔TS) + deploy script                 | TODO        | 0   |                                                                             |
| CVY-003   | Deploy+verify on Base; **FIRST REAL BASE TX**               | TODO        | 0   | Hard Day-2 deadline; needs KH key, Base RPC, Etherscan V2 key, deployer key |
| CVY-004   | kh-client: write + simulate + status + errors + idempotency | TODO        | 0   | Highest external risk (G-01/G-02/G-03)                                      |
| CVY-005   | DB package: Prisma schema, migrations, seed                 | TODO        | 0   |                                                                             |
| CVY-006   | BullMQ queue + worker + idempotent handlers                 | TODO        | 0   |                                                                             |
| CVY-007   | Budget meter + gas→USDC accounting                          | TODO        | 0   |                                                                             |
| CVY-008   | Orchestrator + RUN/ITEM state machine                       | TODO        | 0   | Core; blocks all run behaviour                                              |
| CVY-GATE1 | **GATE 1** — thin slice, real tx landed via Convoy          | NOT REACHED | 0   | Fail → stop features, cut #1 and #2                                         |
| CVY-009   | SSE timeline UI + audit drawer + replay                     | TODO        | 0   | Never cut                                                                   |
| CVY-010   | Planner + zod schema + repair + eval                        | TODO        | 0   | Recall ≥0.9                                                                 |
| CVY-011   | Critic + simulate veto + corroboration                      | TODO        | 0   | Zero false vetoes; never cut                                                |
| CVY-012   | Manifest exporter: 3-way reconcile + sha256                 | TODO        | 0   |                                                                             |
| CVY-GATE2 | **GATE 2** — full 12-item run, manifest, DAG                | NOT REACHED | 0   | Fail → freeze P1, cut #2 and #5                                             |
| CVY-013   | DAG view + deferral + onchain check-and-execute gate        | TODO        | 0   | P1                                                                          |
| CVY-014   | Human approval gate                                         | TODO        | 0   | P1                                                                          |
| CVY-015   | Idempotency + crash-resume + kill-worker test               | TODO        | 0   | Never cut                                                                   |
| CVY-016   | Ablation harness + README honesty table                     | TODO        | 0   |                                                                             |
| CVY-017   | x402 payment leg                                            | TODO        | 0   | P1; gated on G-06, cuttable                                                 |
| CVY-018   | Telegram notifications                                      | TODO        | 0   | P2; omit if time is short                                                   |
| CVY-019   | Demo E2E + backup paths + video + SUBMIT                    | TODO        | 0   | Deadline Aug 13 2026 12:00 UTC+2                                            |

**Gates:** GATE1 not reached · GATE2 not reached

## Critical path

`002 → 003 → (004) → 008 → GATE1 → 012 → GATE2 → 015 → 019`

The first real Base transaction (CVY-003) is front-loaded to Day 2 so the hackathon submission
requirement is provisionally met before any feature work.

## Cut order (apply in this exact sequence if week 2 slips)

1. x402 payment leg → gas-only budget.
2. React Flow DAG → ordered list with dependency badges.
3. Onchain `check-and-execute` gate → app-side gate reading the registry via RPC.
4. Human approval gate → auto.
5. 3-way manifest → 2-way (KeeperHub + ledger), disclosed.

**Never cut:** the SSE timeline, the Critic veto, or crash-resume.

## Blocked on operator input

CVY-003 cannot land until these exist: `KEEPERHUB_API_KEY` (org key with the Turnkey wallet
configured), `BASE_RPC_URL` (dedicated, pinned to 8453), `ETHERSCAN_API_KEY` (V2), and
`DEPLOYER_PRIVATE_KEY` (Foundry deploy only, funded with Base ETH). CVY-010/011 additionally need
`OPENAI_API_KEY`.
