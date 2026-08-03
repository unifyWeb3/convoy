# Convoy Implementation Status (updated 2026-08-03)

Overall: **20% (CVY-000, CVY-001, CVY-002, CVY-004 done; DEC-001 applied)** Next milestone: **CVY-003 — Deploy+verify on Base Sepolia; FIRST REAL BASE TX**

**CVY-003 is now unblocked.** Its dependency — a write path from CVY-004 — exists and has executed a
real write on Base Sepolia. Nothing is deployed yet: `ConvoyRegistry` and `MockRewardDistributor` have
no addresses, and no `openRun` transaction is claimed.

**Execution chain: Base Sepolia (84532)** per DEC-001. Base mainnet (8453) is an optional final demo
target at CVY-019, not the development target.

| ID        | Milestone                                                   | Status      | %   | Notes                                                                    |
| --------- | ----------------------------------------------------------- | ----------- | --- | ------------------------------------------------------------------------ |
| CVY-000   | Repo bootstrap + toolchain                                  | DONE        | 100 | Monorepo builds empty; `.convoy/` populated; CI grep-guards live         |
| CVY-001   | Contracts + Foundry unit/invariant tests                    | DONE        | 100 | 45 tests green; invariants at runs=1000 depth=32; gap G-10 recorded      |
| CVY-002   | payloadHash parity (Sol↔TS) + deploy script                 | DONE        | 100 | 13 dumped fixtures, 47 parity assertions; deploy script written, not run |
| DEC-001   | _Amendment_ — execution chain → Base Sepolia 84532          | DONE        | 100 | Not a milestone; a scoped spec amendment. See docs/DECISIONS.md          |
| CVY-004   | kh-client: write + simulate + status + errors + idempotency | DONE        | 100 | 114 tests; live smoke on 84532; drift G-20…G-23 recorded                 |
| CVY-003   | Deploy+verify on Base Sepolia; **FIRST REAL BASE TX**       | TODO        | 0   | **next** — unblocked: credentials present, write path proven             |
| CVY-005   | DB package: Prisma schema, migrations, seed                 | TODO        | 0   |                                                                          |
| CVY-006   | BullMQ queue + worker + idempotent handlers                 | TODO        | 0   |                                                                          |
| CVY-007   | Budget meter + gas→USDC accounting                          | TODO        | 0   |                                                                          |
| CVY-008   | Orchestrator + RUN/ITEM state machine                       | TODO        | 0   | Core; blocks all run behaviour                                           |
| CVY-GATE1 | **GATE 1** — thin slice, real tx landed via Convoy          | NOT REACHED | 0   | Fail → stop features, cut #1 and #2                                      |
| CVY-009   | SSE timeline UI + audit drawer + replay                     | TODO        | 0   | Never cut                                                                |
| CVY-010   | Planner + zod schema + repair + eval                        | TODO        | 0   | Recall ≥0.9                                                              |
| CVY-011   | Critic + simulate veto + corroboration                      | TODO        | 0   | Zero false vetoes; never cut                                             |
| CVY-012   | Manifest exporter: 3-way reconcile + sha256                 | TODO        | 0   |                                                                          |
| CVY-GATE2 | **GATE 2** — full 12-item run, manifest, DAG                | NOT REACHED | 0   | Fail → freeze P1, cut #2 and #5                                          |
| CVY-013   | DAG view + deferral + onchain check-and-execute gate        | TODO        | 0   | P1                                                                       |
| CVY-014   | Human approval gate                                         | TODO        | 0   | P1                                                                       |
| CVY-015   | Idempotency + crash-resume + kill-worker test               | TODO        | 0   | Never cut                                                                |
| CVY-016   | Ablation harness + README honesty table                     | TODO        | 0   |                                                                          |
| CVY-017   | x402 payment leg                                            | TODO        | 0   | P1; gated on G-06, cuttable                                              |
| CVY-018   | Telegram notifications                                      | TODO        | 0   | P2; omit if time is short                                                |
| CVY-019   | Demo E2E + backup paths + video + SUBMIT                    | TODO        | 0   | Deadline Aug 13 2026 12:00 UTC+2; optional 8453 flip is a stretch step   |

**Gates:** GATE1 not reached · GATE2 not reached

## Critical path

`002 → 004 → 003 → 008 → GATE1 → 012 → GATE2 → 015 → 019`

The first real Base transaction (CVY-003) is front-loaded so the hackathon submission requirement is
provisionally met before any feature work — but it cannot precede CVY-004, because the transaction is
landed _through the kh-client_. The blueprint wrote this path as `002 → 003 → (004)` with CVY-004
parenthesised as "minimal write path"; the ordering above states the dependency the two task cards
actually declare.

### Schedule slip (recorded 2026-08-03, updated 2026-08-03 at CVY-002 close, not re-baselined)

The roadmap's calendar days and the elapsed calendar have diverged. CVY-001 (**D1**) and CVY-002
(**D1–D2**) both closed on 2026-08-03; the "hard Day-2 deadline" for the first real Base transaction
(CVY-003) has passed unmet. Nothing has been re-baselined — the roadmap day labels are left as
frozen, and the submission deadline (Aug 13 2026 12:00 UTC+2, 10 days out) is unchanged.

**CVY-003 is still the only thing standing between the repository and a satisfied submission
requirement.** Every offline prerequisite is done: both contracts are implemented and tested, the
deploy script is written and its chain guard verified, and the payload commitment is proven
byte-identical across Solidity and TypeScript.

**Updated 2026-08-03: the credential block is cleared.** `KEEPERHUB_API_KEY`, `BASE_RPC_URL`,
`BASE_SEPOLIA_RPC_URL`, `BASE_RPC_URL_FALLBACK`, `ETHERSCAN_API_KEY` and `DEPLOYER_PRIVATE_KEY` are
all present. CVY-003 is now gated on **CVY-004's write path**, which is engineering work rather than
operator input. `OPENAI_API_KEY` is still a placeholder, so CVY-010/011 remain blocked.

### Buffer exhausted, cut order live (recorded 2026-08-03 at DEC-001)

Counted against the deadline — **Aug 13 2026 12:00 UTC+2, 10 calendar days from today** — the
roadmap no longer fits. It runs D1–D15 with a D16–D17 buffer; with D1 landing on 2026-08-03, D15
falls on **Aug 17, four days past the deadline**, and D16–D17 later still.

**The D16–D17 buffer is gone.** It was earmarked for the stackable $1,000 Onboarding-UX bounty PR;
that is now out of reach and should not be planned for. **The cut order below is live, not
contingent** — it applies from now, not "if week 2 slips". Cut #1 (x402 → gas-only budget) is
additionally forced on the primary chain by gap G-17, independent of schedule.

Nothing has been re-baselined. The roadmap day labels stay as frozen; this section records the
divergence rather than hiding it. DEC-001 removes funding risk and gas cost from the critical path,
which is the one schedule pressure it was able to relieve.

## Cut order (apply in this exact sequence if week 2 slips)

1. x402 payment leg → gas-only budget.
2. React Flow DAG → ordered list with dependency badges.
3. Onchain `check-and-execute` gate → app-side gate reading the registry via RPC.
4. Human approval gate → auto.
5. 3-way manifest → 2-way (KeeperHub + ledger), disclosed.

**Never cut:** the SSE timeline, the Critic veto, or crash-resume.

## Operator input

All values apply to **Base Sepolia (84532)** per DEC-001.

| Value                   | Chain         | Status      | Notes                                                 |
| ----------------------- | ------------- | ----------- | ----------------------------------------------------- |
| `KEEPERHUB_API_KEY`     | 84532         | PRESENT     | org `kh_` key with the Turnkey wallet configured      |
| `BASE_RPC_URL`          | 84532         | PRESENT     | dedicated Sepolia RPC — never a public one            |
| `BASE_SEPOLIA_RPC_URL`  | 84532         | PRESENT     | Foundry `--rpc-url base_sepolia`; may be the same URL |
| `BASE_RPC_URL_FALLBACK` | 84532         | PRESENT     | demo backup path b; must match the primary chain      |
| `ETHERSCAN_API_KEY`     | 84532 (+8453) | PRESENT     | single Etherscan **V2** key; covers both chains       |
| `DEPLOYER_PRIVATE_KEY`  | 84532         | PRESENT     | Foundry deploy only; fund from a Sepolia faucet       |
| `OPENAI_API_KEY`        | —             | PLACEHOLDER | **still blocking CVY-010 / CVY-011**                  |
| `BASE_MAINNET_RPC_URL`  | 8453          | UNSET       | **optional**, CVY-019 flip only — leave unset         |

Presence is not the same as sufficiency: the org Turnkey wallet must also be **configured for 84532**
and funded with Base Sepolia ETH. A `422 wallet-not-configured` from KeeperHub means that
provisioning is missing, and it is fatal-to-run rather than a client bug.
