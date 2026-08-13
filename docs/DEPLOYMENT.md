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

## KeeperHub authentication — two paths, deliberately separate

| Surface                         | Auth                   | Used by                                       |
| ------------------------------- | ---------------------- | --------------------------------------------- |
| Interactive Claude Code session | Browser **OAuth 2.1**  | developers; the judged MCP evaluation surface |
| Headless runtime                | `kh_` **Bearer** token | `packages/kh-client`, `services/worker`, CI   |

Both reach the same endpoint, `https://app.keeperhub.com/mcp`; only the credential differs. Full
detail and the plugin inventory: [`.convoy/mcp/README.md`](../.convoy/mcp/README.md).

**The runtime never uses OAuth, and this is a constraint rather than a preference.** The worker and
the client run unattended — no browser, no human, no consent screen — so an OAuth flow would block
forever on a sign-in nobody is there to complete. CVY-004's execution path depends on Bearer auth.
The KeeperHub Claude Code plugin is a development convenience and an evaluation surface; it must
never become a runtime dependency. The test of that boundary: uninstalling the plugin must leave
Convoy's execution completely unaffected.

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

| Surface                            | Needs                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` (Vercel)                | `DATABASE_URL`, `REDIS_URL`, `KEEPERHUB_API_KEY`, `KEEPERHUB_BASE_URL`, `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK`, `CONVOY_REGISTRY_ADDR`, `MOCK_DISTRIBUTOR_ADDR`, `CONVOY_LLM_PROVIDER`, `CONVOY_GENLAYER_NETWORK`, `CONVOY_GENLAYER_CONTRACT`, `CONVOY_ETH_USD`, `CONVOY_LLM_TIMEOUT_MS`, `CONVOY_KH_MODE` |
| `services/worker` (off Vercel)     | `DATABASE_URL`, `REDIS_URL`, `KEEPERHUB_API_KEY`, `KEEPERHUB_BASE_URL`, `CONVOY_LLM_PROVIDER`, `CONVOY_GENLAYER_NETWORK`, `CONVOY_GENLAYER_CONTRACT`, `BASE_RPC_URL`, `CONVOY_ETH_USD`, `CONVOY_LLM_TIMEOUT_MS`, `CONVOY_KH_MODE`, optionally `TELEGRAM_BOT_TOKEN`                                          |
| `packages/contracts` (deploy only) | `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`, `BASE_SEPOLIA_RPC_URL`; `BASE_MAINNET_RPC_URL` only for the optional CVY-019 flip                                                                                                                                                                              |

`DEPLOYER_PRIVATE_KEY` is used **only** by `forge script` under `packages/contracts/script`. It never
enters app or worker runtime — Convoy's runtime holds no private key, and a CI grep-guard enforces
this.

## GenLayer inference contract (deployment-gated)

The source is [`packages/ai/genlayer/convoy_inference.py`](../packages/ai/genlayer/convoy_inference.py).
It is stateless and exposes only `infer(schema_name, messages_json, schema_json)`. Runtime calls use
`simulateWriteContract` on Testnet Bradbury (`chainId=4221`) and never use `writeContract`, an
account, a signer, or a finality poll. The contract must be deployed once before setting
`CONVOY_GENLAYER_CONTRACT`; until then the GenLayer provider intentionally reports unavailable and
the existing deterministic/simulator-only fallbacks remain honest.

Deployment is a separate operator action and is not part of Convoy runtime. Use a deployment-only
Bradbury account with faucet GEN. The credential is accepted only as `GENLAYER_DEPLOYMENT_KEY` from
the invoking shell or the gitignored `packages/ai/genlayer/.env.deploy.local` file. It is never read
from Convoy's root `.env`, Vercel, the worker, or the `LlmCaller` provider.

For the local-file path, copy the non-secret template and fill it locally without committing it:

```bash
cp packages/ai/genlayer/deploy.env.example packages/ai/genlayer/.env.deploy.local
chmod 600 packages/ai/genlayer/.env.deploy.local
```

The file contains exactly:

```env
GENLAYER_DEPLOYMENT_KEY=0x...
```

Alternatively, export the same variable in the deployment shell. In either case, run from the
repository root:

```bash
pnpm --filter @convoy/ai deploy:genlayer
```

The command prints `CONVOY_GENLAYER_CONTRACT=0x…` and the deployment transaction hash. It must be
run only after the deployment-readiness report is reviewed and approved. It never prints the
deployment credential.

After recording the address, verify both real Convoy roles without any database or chain write:

```bash
CONVOY_LLM_PROVIDER=genlayer \
CONVOY_GENLAYER_NETWORK=testnetBradbury \
CONVOY_GENLAYER_CONTRACT=0x... \
CONVOY_LLM_TIMEOUT_MS=30000 \
pnpm --filter @convoy/ai preflight:genlayer
```

The preflight must report `planner.source="planner"`, a GenLayer-backed Critic model, and
`writes=0`. Only after that evidence is accepted may CVY-016 resume.

## Vercel configuration note

`vercel.json` lives at the repository root per the blueprint's tree, while the project's Root
Directory is set to `apps/web` in the dashboard. Vercel reads `vercel.json` from the configured Root
Directory, so **the dashboard settings are authoritative** (decision D-002). Set the dashboard
Build Command to `pnpm --filter @convoy/web... build`: pnpm selects the web workspace and its
workspace dependencies, then builds them in topological order before Next.js. The repository-root
`vercel.json` mirrors that command for root-context verification. Deployment is git integration
only.

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
