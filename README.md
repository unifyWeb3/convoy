# Convoy

Convoy is an autonomous onchain release operator that plans, critically evaluates,
dependency-orders, executes, and proves multi-step release workflows.

## What it solves

Multi-step onchain releases need more than transaction submission. Each action can depend on state
created by an earlier action; an individually valid call can still be premature, unsupported by its
evidence, or outside the run budget. Operators also need to know what was attempted, what actually
landed, and whether the final record agrees with the execution rail and the chain.

Convoy turns a batch of actions and supporting evidence into a dependency-aware execution plan,
checks every eligible action, sends approved writes through one controlled rail, and reconciles the
result into a receipt-backed proof manifest.

## How it works

```text
Planner
  → dependency-aware plan
  → Critic
  → simulation / validation gate
  → KeeperHub execution
  → Base Sepolia
  → receipts + registry events + Convoy ledger
  → evidence-backed proof manifest
```

1. The **Planner** converts the requested actions and evidence into an ordered plan with explicit
   dependencies and deferrals.
2. Before execution, Convoy obtains real simulation facts and asks the separately prompted
   **Critic** whether each action is justified by its evidence. Deterministic whitelist, dependency,
   budget, and simulation checks remain authoritative.
3. Approved actions are committed and submitted through **KeeperHub**. Convoy observes execution
   status and KeeperHub-managed onchain retries; it does not implement a relayer.
4. The worker records attempts, events, transaction hashes, receipt-derived gas, and registry
   evidence in the PostgreSQL ledger.
5. The manifest reconciles KeeperHub status, Base Sepolia `ConvoyRegistry` events, and the Convoy
   ledger into one exportable proof.

### GenLayer's role

Planner and Critic inference run through a deployed stateless Intelligent Contract on **GenLayer
Bradbury**. Convoy's runtime creates an accountless client and calls only
`simulateWriteContract`. It does not use `writeContract`, hold a GenLayer private key, submit a GEN
transaction, or poll GenLayer finality. A deployment account was needed to deploy the Intelligent
Contract once; it is not part of runtime inference.

### KeeperHub's role

KeeperHub remains the only Base-chain write rail. Writes execute through KeeperHub's organization
wallet, while Convoy supplies no local signature and never sets or manages a nonce. KeeperHub
execution IDs, statuses, transaction hashes, retry observations, and receipt evidence are
reconciled back into Convoy's ledger and proof manifest.

`MockRewardDistributor` is a demo-only release target. The accepted runs use real KeeperHub calls,
Base Sepolia transactions, receipts, and ledger records; Convoy does not stage failures or invent
transaction hashes.

## Run Board

The production Run Board is the operational surface for inspecting a release. It presents:

- run status, budget, and action tally;
- the append-only execution timeline;
- a dependency DAG with action states and deferrals;
- the reconciled proof manifest;
- an audit/evidence drawer with Planner rationale, Critic and simulation facts, attempts, hashes,
  and registry evidence; and
- real SSE updates with event replay, so live state survives refreshes.

Production: [https://convoy-five.vercel.app](https://convoy-five.vercel.app)

Known real Run Board:
[https://convoy-five.vercel.app/runs/0d4bd5aa-1780-4ff0-ad35-fc8cdc236e4f](https://convoy-five.vercel.app/runs/0d4bd5aa-1780-4ff0-ad35-fc8cdc236e4f)

The direct Run Board URL is the operational demo surface. It renders the accepted baseline run from
the shared ledger; the root URL is intentionally only a minimal entry surface.

## CVY-016 evidence

CVY-016 measured the same 11-action fixture in three fresh Base Sepolia runs. Each run used a fresh
`MockRewardDistributor`, the same production worker lifecycle, and KeeperHub for every Base write.

### Provenance

| Mode             | Ledger run ID                          | Plan                                                                      | Critic and gate                             |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| Baseline         | `0d4bd5aa-1780-4ff0-ad35-fc8cdc236e4f` | `source=planner`                                                          | `criticConsulted=true`; normal gate         |
| Planner ablation | `72e9b3d9-5e8e-49b1-b9a4-49684cfd15a3` | `source=ablation-planner`; input order with dependency extraction removed | Genuine Critic remained active; normal gate |
| Critic ablation  | `f7243450-9aaa-49cf-97c3-fa0431dc7144` | `source=planner`; inherited accepted baseline plan                        | `criticConsulted=false`; `gate=bypassed`    |

### Measured results

| Mode             | Landed | Submitted | Failed/reverted¹ | Invalid submissions | Wasted-gas events | Wasted gas |          Budget | Delta vs baseline | Starved dependents |
| ---------------- | -----: | --------: | ---------------: | ------------------: | ----------------: | ---------: | --------------: | ----------------: | -----------------: |
| Baseline         |      8 |         8 |                0 |                   0 |                 0 |   `0 USDC` | `0.030967 USDC` |                 — |                  1 |
| Planner ablation |      1 |         1 |                0 |                   0 |                 0 |   `0 USDC` | `0.006555 USDC` |  `-0.024412 USDC` |                  0 |
| Critic ablation  |      8 |        10 |                2 |                   2 |                 0 |   `0 USDC` | `0.035589 USDC` |  `+0.004622 USDC` |                  1 |

¹ The harness's `failed/reverted` metric counts failed target execution attempts. In the
Critic-ablation run, KeeperHub rejected both invalid target actions during pre-broadcast
processing. Neither action produced a target transaction hash or receipt, so the measured result is
**zero target-level onchain reverts and zero wasted-gas events**. This is the observed behavior of
the execution rail, not a claim that target gas was spent.

The Planner-ablation run landed every action it submitted, but only one of the 11 fixture actions
reached submission because the normal simulation/Critic gate remained active after dependency
extraction was removed. Its 1/1 submitted-item rate is therefore not equivalent to the baseline's
8/8 result.

### Immutable artifacts

- [Accepted baseline plan](docs/milestones/CVY-016-live-plan.json)
- [Baseline run](docs/milestones/CVY-016-live-baseline.json)
- [Planner-ablation run](docs/milestones/CVY-016-live-planner.json)
- [Critic-ablation run](docs/milestones/CVY-016-live-critic.json)

The [CVY-016 report](docs/milestones/CVY-016.md) records the run identities, fresh target
contracts, boundary transactions, and acceptance decision. The JSON files are immutable,
byte-for-byte evidence recordings.

## Why GenLayer

GenLayer provides the inference boundary for Planner/Critic through an Intelligent Contract and
accountless `simulateWriteContract` calls, while Convoy preserves its existing validation and
execution pipeline.

That boundary keeps inference separate from Base execution: GenLayer supplies structured Planner
and Critic responses, while Convoy continues to own schema validation, repair, deterministic
corroboration, dependency handling, fallback disclosure, ledger persistence, and KeeperHub
execution. The integration does not depend on a runtime signer or change Convoy's rule that every
Base write goes through KeeperHub.

## Architecture

```text
apps/web  Next.js Run Board + API/SSE (Vercel)
    │ create/read runs, stream append-only events
    ├───────────────────────┐
    ▼                       ▼
Redis / BullMQ        packages/db (Prisma) ── PostgreSQL ledger
    │                       ▲                         │
    ▼                       │ attempts/events        │ snapshots/manifests
services/worker             │                         ▼
    ├─ packages/ai ─────────┼─ accountless call ── GenLayer Bradbury
    │  Planner + Critic     │
    └─ packages/kh-client ──┼─ KeeperHub ── Base Sepolia
                            │                 ├─ ConvoyRegistry
                            └─ status/receipts└─ MockRewardDistributor (demo)
```

| Path                 | Responsibility                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `apps/web`           | Next.js 14 App Router, Run Board, API routes, SSE stream, manifest export      |
| `services/worker`    | Always-on BullMQ worker and release state machine                              |
| `packages/ai`        | Planner, Critic, schemas, provider boundary, and GenLayer Intelligent Contract |
| `packages/kh-client` | The only runtime package that communicates with KeeperHub                      |
| `packages/db`        | Prisma client, migrations, and the append-only PostgreSQL ledger               |
| `packages/contracts` | Foundry project for `ConvoyRegistry` and the demo target                       |

The frozen architecture is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Production deployment

| Surface              | Production role                                                           |
| -------------------- | ------------------------------------------------------------------------- |
| Vercel               | Next.js frontend, server-rendered Run Board, API routes, and SSE endpoint |
| Shared PostgreSQL    | Ledger for runs, items, attempts, events, and manifests                   |
| Shared Redis         | BullMQ queue and coordination state                                       |
| Always-on worker     | Long-lived orchestration process hosted outside Vercel                    |
| GenLayer Bradbury    | Accountless Planner/Critic inference                                      |
| KeeperHub            | Organization-wallet simulation and the only Base write rail               |
| Base Sepolia (84532) | Primary execution chain and receipt/registry evidence source              |

The checked-in [deployment guide](docs/DEPLOYMENT.md) confirms that PostgreSQL and Redis are shared
with an always-on worker outside Vercel. It lists Railway or Fly as supported worker hosts but does
not identify the production datastore vendor, so this README makes no vendor-specific hosting
claim. Runtime configuration is supplied through environment variables; no credentials or secret
values belong in the repository.

## Verification

The completed implementation has the following recorded verification:

| Area                 | Verified result                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Web tests            | 108 passing                                                                                                                                 |
| AI tests             | 24 passing                                                                                                                                  |
| Worker tests         | 137 passing with PostgreSQL and Redis available                                                                                             |
| Static checks        | Workspace and script typechecks, lint, and production build passed                                                                          |
| Browser checks       | Run Board Playwright coverage, including DAG/timeline rendering and refresh/replay                                                          |
| Safety checks        | Contract invariants plus prohibited-value guards for direct KeeperHub access, nonce assignment, private-key references, and staged failures |
| Production smoke     | Public root and real Run Board returned HTTP 200; real ledger data rendered without Prisma, Server Component, or browser-console errors     |
| Production live path | The real run's SSE endpoint returned HTTP 200 and delivered the ledger-backed stream rather than a 500 response                             |

See [docs/TESTING.md](docs/TESTING.md) for the test catalog and commands.

Repository-wide Prettier intentionally excludes the four
`docs/milestones/CVY-016-live-*.json` recordings. They are preserved byte-for-byte instead of being
normalized, so `pnpm format:check` cannot attest Prettier conformance for those immutable files; it
checks the repository's non-ignored files. README formatting is validated independently with
`pnpm exec prettier --check README.md`.

## Running locally

Convoy requires Node 22, pnpm, PostgreSQL, and Redis. The repository's supported setup sequence is:

```bash
nvm use
corepack enable
cp .env.example .env
pnpm install
pnpm --filter @convoy/db db:generate
pnpm --filter @convoy/db db:migrate
pnpm --filter @convoy/db db:seed
pnpm tsx scripts/verify-env.ts
```

Fill the local `.env` before running verification. Never commit it. The complete automated setup is
also available as `./scripts/bootstrap.sh`.

### Web development

```bash
pnpm --filter @convoy/web dev
pnpm --filter @convoy/web test
pnpm --filter @convoy/web exec playwright test
```

The Playwright suite needs its documented run/database environment; unit tests do not require a
browser-facing production deployment.

### AI and preflight

```bash
pnpm --filter @convoy/ai test
pnpm --filter @convoy/ai preflight:genlayer
pnpm run eval:planner:replay
pnpm run eval:critic:replay
```

The GenLayer preflight uses the configured deployed contract but performs no database, KeeperHub,
Base-chain, or GenLayer write.

### Worker and backend

```bash
pnpm --filter @convoy/worker dev
pnpm --filter @convoy/worker test
pnpm --filter @convoy/db test
```

Worker and database tests require reachable PostgreSQL and Redis services. The development worker
uses the same queue lifecycle as production.

### CVY-016 evidence

Do not rerun the live experiment after the project freeze. The harness can recompute the published
metrics offline from the immutable artifacts without `--execute`:

```bash
pnpm tsx scripts/ablation.ts \
  --plan-input docs/milestones/CVY-016-live-plan.json \
  --snapshot docs/milestones/CVY-016-live-baseline.json

pnpm tsx scripts/ablation.ts --ablate-planner \
  --snapshot docs/milestones/CVY-016-live-planner.json \
  --baseline-snapshot docs/milestones/CVY-016-live-baseline.json

pnpm tsx scripts/ablation.ts --ablate-critic \
  --plan-input docs/milestones/CVY-016-live-plan.json \
  --snapshot docs/milestones/CVY-016-live-critic.json \
  --baseline-snapshot docs/milestones/CVY-016-live-baseline.json
```

These commands are read-only evidence replays. Live execution additionally requires an explicit
guard and is outside the frozen project scope.

## Project status

- The core Planner → Critic → KeeperHub → Base Sepolia → proof implementation is complete.
- CVY-016 live evidence is complete with the documented Critic-ablation pre-broadcast limitation.
- The production Run Board and its SSE-backed real-run view are operational.
- This README was finalized after the hackathon deadline. It makes no claim about award or
  submission outcome and does not mark unverified milestones complete.
- The repository is frozen at the completed scope. Any future work is outside this release rather
  than required to operate the current architecture.

## What we deliberately did not build

- `ScreenHome`, `ScreenRuns`, and `ScreenNewRun` design concepts were not integrated into the
  production application.
- A full marketing homepage, run-history screen, and plain-language new-run creation UI were
  excluded. The current `POST /api/runs` path validates and enqueues an existing ledger run; it is
  not a general creation surface.
- Optional milestone work such as a human approval gate, the x402 payment leg, Telegram
  notifications, and a Base-mainnet flip remains outside the frozen core.
- Unrelated optional deadline, submission, and presentation work is not represented as completed
  product functionality.

These surfaces were intentionally excluded from the final scope; they are not hidden dependencies
of the Run Board or execution pipeline.

## Known limitations

- Root `/` is a minimal entry surface rather than a full marketing homepage.
- The direct `/runs/<real-run-id>` route is the strongest operational demo surface.
- There is no browser new-run creation workflow; the queue entrypoint operates on an existing
  ledger run ([G-43](docs/KNOWN_GAPS.md)).
- Execution is on Base Sepolia. Receipt gas units are real, while the displayed gas budget in USDC
  is notional at the run's frozen ETH/USD price; no x402 payment leg is included.
- KeeperHub serializes writes through a sequential nonce path. Production defaults to execution
  fanout 1 after wider fanout produced real nonce failures; increasing local concurrency is not a
  throughput guarantee.
- In the Critic ablation, KeeperHub's pre-broadcast rejection behavior prevented target-level
  revert and wasted-gas measurements, exactly as documented in the evidence section.

The maintained gap register is [docs/KNOWN_GAPS.md](docs/KNOWN_GAPS.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Testing](docs/TESTING.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Decision log](docs/DECISIONS.md)
- [Worklog](docs/WORKLOG.md)
- [Project workflow](docs/AI_WORKFLOW.md)

## License and contribution

The repository's existing license declaration is **MIT**. No standalone `LICENSE` or formal
`CONTRIBUTING` file is present. The project workflow is documented in
[docs/AI_WORKFLOW.md](docs/AI_WORKFLOW.md); changes beyond the frozen release belong to explicitly
scoped future work.
