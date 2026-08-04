# Convoy — autonomous onchain release operator

Convoy takes a batch of interdependent onchain operations, plans an execution DAG with an LLM
Planner, has a separate LLM Critic veto steps that a real KeeperHub `simulate:true` dry-run shows
would revert or overspend, executes the survivors through KeeperHub's org Turnkey wallet, recovers
from genuine failures, and exports one replayable manifest.

Built for the KeeperHub **Agents Onchain** hackathon (DoraHacks). Chain: **Base Sepolia (84532)**
(decision DEC-001). Base mainnet (8453) is an optional final demo target, not the build target.

> **Status:** CVY-003 complete — both contracts are **deployed and Basescan-verified** on Base
> Sepolia, and the first real transaction has landed through KeeperHub's org Turnkey wallet:
> [`0x1ffb4aaf…b2bbcd`](https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd).
> Live status: [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) ·
> deploy runbook: [`docs/RUNBOOK_FIRST_TRANSACTION.md`](docs/RUNBOOK_FIRST_TRANSACTION.md).

---

## Honesty table

Every reliability claim below maps to an artifact a judge can verify. Rows are filled in as
milestones land — a row without an artifact link is not a claim Convoy makes.

| Claim                                                   | How it is real                                                                                                                                                                         | Artifact                                                                                                             | Milestone         | Status   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| Convoy executes real transactions on Base via KeeperHub | Every chain write is a KeeperHub direct-execution call through the org Turnkey wallet                                                                                                  | _Basescan tx link pending_                                                                                           | CVY-003           | PENDING  |
| The Critic's veto costs zero gas                        | Veto evidence is KeeperHub `simulate:true` (`estimateGas` + `provider.call`) — no signing, no broadcast, no audit row                                                                  | _simulate JSON pending_                                                                                              | CVY-011           | PENDING  |
| Convoy never sets a nonce                               | Nonce ordering is delegated to KeeperHub's single-sequential-nonce manager; CI grep-guard bans `nonce:` in client/worker payloads                                                      | `.github/workflows/ci.yml`                                                                                           | CVY-000           | ENFORCED |
| Convoy never holds a private key                        | Runtime holds only a revocable `kh_` key; `PRIVATE_KEY` is grep-guarded to `packages/contracts/script`                                                                                 | `.github/workflows/ci.yml`                                                                                           | CVY-000           | ENFORCED |
| No failure is ever staged                               | CI grep-guard bans staged-failure patterns in non-test code; invalid items point at a contract that genuinely reverts                                                                  | `.github/workflows/ci.yml` · `packages/contracts/src/MockRewardDistributor.sol` (`test_preconditionChain_isGenuine`) | CVY-000 / CVY-001 | ENFORCED |
| Ordering commitments are tamper-evident onchain         | `ConvoyRegistry` storage — `state`, `committedCount`, `payloadHash[runId][idx]` — is one-shot per index and operator-bound, proven by handler-based invariants at `runs=1000 depth=32` | `packages/contracts/test/ConvoyRegistry.invariant.t.sol`                                                             | CVY-001           | ENFORCED |
| The onchain payload commitment means what Convoy says   | `payloadHash` is byte-identical in Solidity and TypeScript, asserted against 13 fixtures dumped from real Solidity output — not hand-written                                           | `tests/fixtures/payloadHash.fixtures.json` · `packages/kh-client/test/payloadHash.parity.test.ts`                    | CVY-002           | ENFORCED |
| Retries are genuine                                     | Onchain retries come from KeeperHub's transient handling and are only observed and recorded                                                                                            | _retry chip / manifest line pending_                                                                                 | CVY-015           | PENDING  |
| The budget meter is not fabricated                      | Gas leg from real `gasUsedWei`; payment leg from real x402 settlements                                                                                                                 | _pending_                                                                                                            | CVY-007 / CVY-017 | PENDING  |
| The manifest reconciles independent sources             | KeeperHub status ↔ ConvoyRegistry events read from chain ↔ Convoy ledger                                                                                                               | _manifest export pending_                                                                                            | CVY-012           | PENDING  |
| The AI is load-bearing                                  | Ablation harness prints the degradation from removing the Planner / Critic                                                                                                             | _ablation output pending_                                                                                            | CVY-016           | PENDING  |

## Verified onchain artifacts

| Artifact                           | Network            | Address / hash                                                       | Explorer                                                                                                   | Verified    |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| ConvoyRegistry                     | Base Sepolia 84532 | `0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA`                         | [view](https://sepolia.basescan.org/address/0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA#code)               | ✅ verified |
| MockRewardDistributor (demo only)  | Base Sepolia 84532 | `0xD45c61797d7283caf8A31D91A5Bd6465A45AD561`                         | [view](https://sepolia.basescan.org/address/0xD45c61797d7283caf8A31D91A5Bd6465A45AD561#code)               | ✅ verified |
| Submission transaction (`openRun`) | Base Sepolia 84532 | `0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd` | [view](https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd) | —           |

## Ablation results

Populated by `pnpm tsx scripts/ablation.ts --ablate-planner|--ablate-critic` at CVY-016.

| Configuration      | Landed-item rate | Wasted-gas events | Budget spent | Starved dependents |
| ------------------ | ---------------- | ----------------- | ------------ | ------------------ |
| Full system        | _pending_        | _pending_         | _pending_    | _pending_          |
| `--ablate-planner` | _pending_        | _pending_         | _pending_    | _pending_          |
| `--ablate-critic`  | _pending_        | _pending_         | _pending_    | _pending_          |

## KeeperHub surfaces used

| Surface                                          | Auth              | Used for                                                                                                 |
| ------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------- |
| **REST direct execution** (`packages/kh-client`) | `kh_` Bearer      | **All execution.** Every simulate, write and status poll                                                 |
| **MCP** — KeeperHub Claude Code plugin v4.0.0    | Browser OAuth 2.1 | Installed and authenticated; used to inspect the org wallet integration and confirm the execution wallet |

Both reach `app.keeperhub.com/mcp`; only the credential differs. The plugin is a development and
evaluation surface — **not a runtime dependency**. The worker and client run unattended with no
browser to complete a sign-in, so they stay on Bearer auth. Uninstalling the plugin leaves Convoy's
execution path completely unaffected, which is the test of that boundary.
Detail: [`.convoy/mcp/README.md`](.convoy/mcp/README.md).

## What is a demo stand-in

`MockRewardDistributor` is a **demo-only** contract standing in for a real Merkle-drop distributor.
It is the honest source of genuine reverts: invalid batch items are pointed at a contract that
legitimately rejects them (e.g. `fund` before `setRoot`). Convoy does not stage failures.

## Architecture

One Next.js app (UI + API routes), one Postgres, one Redis-backed BullMQ worker, one deployed
contract. No microservices. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — frozen.

```
apps/web            Next.js 14 App Router — UI + API routes (SSE timeline, manifest export)
services/worker     Node 22 BullMQ worker — orchestrator + state machine (runs off Vercel)
packages/kh-client  @convoy/kh-client — the ONLY module that touches KeeperHub
packages/db         @convoy/db — Prisma schema, migrations, seed
packages/contracts  Foundry — ConvoyRegistry + MockRewardDistributor
```

## Quickstart

```bash
nvm use                 # Node 22
corepack enable
./scripts/bootstrap.sh  # installs, builds, tests, verifies the environment
pnpm tsx scripts/verify-env.ts   # PASS/FAIL matrix
```

Requires local Postgres and Redis. Copy `.env.example` to `.env` and fill it in — never commit it.

## Documentation

| Doc                                                                      | Purpose                                 |
| ------------------------------------------------------------------------ | --------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                           | Frozen protocol source of truth         |
| [`docs/IMPLEMENTATION_BLUEPRINT.md`](docs/IMPLEMENTATION_BLUEPRINT.md)   | Frozen implementation source of truth   |
| [`docs/PRODUCT_DISCOVERY.md`](docs/PRODUCT_DISCOVERY.md)                 | Frozen product source of truth          |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)         | Live milestone dashboard                |
| [`docs/WORKLOG.md`](docs/WORKLOG.md)                                     | Append-only build diary                 |
| [`docs/KNOWN_GAPS.md`](docs/KNOWN_GAPS.md)                               | Gaps, drift, and documented fallbacks   |
| [`docs/TESTING.md`](docs/TESTING.md)                                     | Test catalog and commands               |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                               | Deploy and rollback                     |
| [`docs/RUNBOOK_FIRST_TRANSACTION.md`](docs/RUNBOOK_FIRST_TRANSACTION.md) | **Authority** for deploy + first tx     |
| [`.convoy/mcp/README.md`](.convoy/mcp/README.md)                         | KeeperHub MCP surfaces and auth paths   |
| [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md)                             | Milestone lifecycle and operating rules |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)                                 | Numbered decision log                   |

## License

MIT
