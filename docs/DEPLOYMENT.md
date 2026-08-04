# Deployment

**The deploy and first transaction are governed by
[`docs/RUNBOOK_FIRST_TRANSACTION.md`](RUNBOOK_FIRST_TRANSACTION.md), which is the single operational
authority for that sequence.** This document does not repeat its commands — gap G-19 exists because
two documents disagreed about a deploy target, and every previously-written copy of the deploy
command in this repository had a flag wrong.

This document is the wider reference: stages, environments, deployed addresses, and rollback for
everything _other_ than the first deploy. `.convoy/playbooks/release.md` is the operational sequence
for web and worker releases.

## Stages

| Stage                  | Action                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local dev              | `pnpm install`; local Postgres + Redis; `db:migrate`; `pnpm --filter @convoy/web dev` + `pnpm --filter @convoy/worker dev`.                                    |
| Env verification       | `pnpm tsx scripts/verify-env.ts` → PASS/FAIL matrix.                                                                                                           |
| Dependency validation  | `pnpm -r build`; `forge build`; `db:generate`.                                                                                                                 |
| Deploy (target chain)  | **See [RUNBOOK_FIRST_TRANSACTION.md](RUNBOOK_FIRST_TRANSACTION.md) §1.6–1.7.** Chain 84532 (DEC-001).                                                          |
| KeeperHub verification | `/mcp` OAuth or `kh_` Bearer; `get_wallet_integration` confirms the org wallet; one simulate + one write; confirm the `transactionLink`.                       |
| Smoke tests            | `demo.spec.ts` against the preview URL. First-tx is runbook §1.7.                                                                                              |
| Release candidate      | Tag; full CI + Playwright; freeze P1 if GATE 2 is unstable.                                                                                                    |
| Mainnet deploy (opt.)  | **Optional, CVY-019 only.** `--rpc-url base --broadcast --verify --chain base` (8453); needs `BASE_MAINNET_RPC_URL`, unset by default.                         |
| Web deploy             | **Vercel git integration only — never the CLI.** One project, Root Directory `apps/web`, environment set in the dashboard; push to `main` triggers production. |
| Worker deploy          | **Off Vercel.** Vercel cannot host long-lived processes; use a small always-on host (Railway/Fly) or run locally for the demo.                                 |
| Rollback               | See below.                                                                                                                                                     |
| Final demo deploy      | Deploy the morning of on 84532; run a real morning batch whose hashes land on Basescan (backup path a); then freeze the environment.                           |

## Basescan verification

Verification uses the **single Etherscan API V2 key** (`ETHERSCAN_API_KEY`). Legacy per-chain
Etherscan API V1 endpoints were deprecated on 2025-08-15 in favour of the unified multichain V2 API
and are no longer accepted. One key covers Base.

## Deployed addresses

**Recorded in [RUNBOOK_FIRST_TRANSACTION.md](RUNBOOK_FIRST_TRANSACTION.md) Part 2**, which is filled
in from real deployment output. Keeping one copy is the point: two address tables that can disagree
is the G-19 failure mode applied to something far more damaging than a chain name.

Each address is additionally recorded in `.env` (`CONVOY_REGISTRY_ADDR`, `MOCK_DISTRIBUTOR_ADDR`),
in the Vercel dashboard, and in the README artifact table.

### The deploy script

`packages/contracts/script/Deploy.s.sol` deploys both contracts in one broadcast, guarded by a chain
allowlist (8453 / 84532) and by `vm.envUint` reverting when the key is absent.

**Commands, flag separators, pre-flight checks and troubleshooting live in
[RUNBOOK_FIRST_TRANSACTION.md](RUNBOOK_FIRST_TRANSACTION.md).** They are deliberately not repeated
here.

`DEPLOYER_PRIVATE_KEY` is read there and nowhere else in the repository; the CI grep-guard enforces
that.

## Environment by surface

| Surface                            | Needs                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` (Vercel)                | `DATABASE_URL`, `REDIS_URL`, `KEEPERHUB_API_KEY`, `KEEPERHUB_BASE_URL`, `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK`, `CONVOY_REGISTRY_ADDR`, `MOCK_DISTRIBUTOR_ADDR`, `OPENAI_API_KEY`, `CONVOY_ETH_USD`, `CONVOY_LLM_TIMEOUT_MS`, `CONVOY_KH_MODE` |
| `services/worker` (off Vercel)     | `DATABASE_URL`, `REDIS_URL`, `KEEPERHUB_API_KEY`, `KEEPERHUB_BASE_URL`, `BASE_RPC_URL`, `CONVOY_ETH_USD`, `CONVOY_KH_MODE`, optionally `TELEGRAM_BOT_TOKEN`                                                                                     |
| `packages/contracts` (deploy only) | `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`, `BASE_SEPOLIA_RPC_URL`; `BASE_MAINNET_RPC_URL` only for the optional CVY-019 flip                                                                                                                  |

`DEPLOYER_PRIVATE_KEY` is used **only** by `forge script` under `packages/contracts/script`. It never
enters app or worker runtime — Convoy's runtime holds no private key, and a CI grep-guard enforces
this.

## Vercel configuration note

`vercel.json` lives at the repository root per the blueprint's tree, while the project's Root
Directory is set to `apps/web` in the dashboard. Vercel reads `vercel.json` from the configured Root
Directory, so **the dashboard settings are authoritative** (decision D-002). Deployment is git
integration only.

## Worker topology

The worker is a long-lived BullMQ consumer and **cannot run on Vercel**. This is a deployment
topology constraint, not an architecture change. It needs Redis and Postgres reachability, and it
must handle `SIGTERM` by calling `worker.close()` so in-flight jobs drain rather than being
abandoned mid-execution.

## Rollback

| Layer     | Rollback                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts | **Immutable.** Deploy a fresh instance and update `CONVOY_REGISTRY_ADDR`. Never migrate state.                                                                    |
| Web       | Vercel → "Promote previous deployment".                                                                                                                           |
| Worker    | Redeploy the previous commit. In-flight items are recovered by `reconcile.ts` — reconcile before acting, never re-broadcast without the original idempotency key. |
| Database  | Forward-only migrations. Write a new forward migration; never edit an applied one. Keep a pre-demo snapshot.                                                      |

## Pre-demo freeze

After the morning rehearsal run, freeze the environment: no configuration changes, no redeploys, no
key rotations. The rehearsal's transaction hashes are the demo's backup path a.
