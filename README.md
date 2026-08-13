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

| Claim                                                   | How it is real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Artifact                                                                                                                                                                                                                                                                      | Milestone         | Status   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| Convoy executes real transactions on Base via KeeperHub | Every chain write is a KeeperHub direct-execution call through the org Turnkey wallet                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [first openRun transaction](https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd)                                                                                                                                               | CVY-003           | ENFORCED |
| The Critic's veto costs zero gas                        | Veto evidence is KeeperHub `simulate:true` (`estimateGas` + `provider.call`) — no signing, no broadcast, no audit row                                                                                                                                                                                                                                                                                                                                                                                                                                         | [`critic.veto.eval.ts`](tests/critic.veto.eval.ts) and [`CVY-011 report`](docs/milestones/CVY-011.md)                                                                                                                                                                         | CVY-011           | ENFORCED |
| Convoy never sets a nonce                               | Convoy submits concurrently; **KeeperHub serializes onto a single sequential nonce** — strictly increasing, one transaction per block, never batched — measured identical at dispatch width 4 and 12. CI grep-guard bans `nonce:` in client/worker payloads                                                                                                                                                                                                                                                                                                   | [dispatch-width comparison](#dispatch-width-does-not-change-throughput) · `.github/workflows/ci.yml`                                                                                                                                                                          | CVY-000 / CVY-008 | ENFORCED |
| Convoy never holds a private key                        | Runtime holds only a revocable `kh_` key; `PRIVATE_KEY` is grep-guarded to `packages/contracts/script`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `.github/workflows/ci.yml`                                                                                                                                                                                                                                                    | CVY-000           | ENFORCED |
| No failure is ever staged                               | CI grep-guard bans staged-failure patterns in non-test code; invalid items point at a contract that genuinely reverts                                                                                                                                                                                                                                                                                                                                                                                                                                         | `.github/workflows/ci.yml` · `packages/contracts/src/MockRewardDistributor.sol` (`test_preconditionChain_isGenuine`)                                                                                                                                                          | CVY-000 / CVY-001 | ENFORCED |
| Ordering commitments are tamper-evident onchain         | `ConvoyRegistry` storage — `state`, `committedCount`, `payloadHash[runId][idx]` — is one-shot per index and operator-bound, proven by handler-based invariants at `runs=1000 depth=32`                                                                                                                                                                                                                                                                                                                                                                        | `packages/contracts/test/ConvoyRegistry.invariant.t.sol`                                                                                                                                                                                                                      | CVY-001           | ENFORCED |
| The onchain payload commitment means what Convoy says   | `payloadHash` is byte-identical in Solidity and TypeScript, asserted against 13 fixtures dumped from real Solidity output — not hand-written                                                                                                                                                                                                                                                                                                                                                                                                                  | `tests/fixtures/payloadHash.fixtures.json` · `packages/kh-client/test/payloadHash.parity.test.ts`                                                                                                                                                                             | CVY-002           | ENFORCED |
| Retries are genuine                                     | Onchain retries come from KeeperHub's transient handling and are only observed and recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [`CVY-015 live proof`](docs/milestones/CVY-015.md)                                                                                                                                                                                                                            | CVY-015           | ENFORCED |
| The budget meter is not fabricated                      | **Two figures, never conflated (DEC-010).** _Gas consumed_ = `gasUsed × effectiveGasPrice + l1Fee`, composed from the chain receipt — always recorded, and what drains the budget. _Wallet debited_ = the same figure only where the execution record says `sponsored:false`, and zero where the paymaster paid. KeeperHub's ERC-4337 paymaster covers ~$1/month on a free account and then stops, so the two numbers are both real and they differ. **USD is notional** at a frozen price on a testnet (G-04, G-18). Payment leg unused until CVY-017 (G-17) | `services/worker/src/budget.ts` · `services/worker/test/budget.payerSplit.test.ts` · `services/worker/scripts/gasfield.mjs`                                                                                                                                                   | CVY-007 / CVY-010 | ENFORCED |
| The manifest reconciles independent sources             | KeeperHub status ↔ ConvoyRegistry events read from chain ↔ Convoy ledger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [`CVY-012 report`](docs/milestones/CVY-012.md)                                                                                                                                                                                                                                | CVY-012           | ENFORCED |
| The AI is load-bearing                                  | Three fresh Base Sepolia runs are now measured. Removing Planner extraction reduced the batch to one submitted/landed item; removing the Critic admitted two invalid submissions, both rejected by KeeperHub before target broadcast, and produced an 8/10 landed result. No target-level revert or wasted-gas claim is made for those two calls. The Planner's separate eval remains **29/29 first-pass valid JSON**, dependency recall **53/56 = 0.946**, precision 0.981, **zero cycles**, 1/104 trap edges emitted                                        | [`CVY-016 report`](docs/milestones/CVY-016.md) · [`baseline`](docs/milestones/CVY-016-live-baseline.json) · [`planner ablation`](docs/milestones/CVY-016-live-planner.json) · [`critic ablation`](docs/milestones/CVY-016-live-critic.json) · [`Planner eval`](#planner-eval) | CVY-010 / CVY-016 | MEASURED |

## Verified onchain artifacts

| Artifact                           | Network            | Address / hash                                                       | Explorer                                                                                                   | Verified    |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| ConvoyRegistry                     | Base Sepolia 84532 | `0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA`                         | [view](https://sepolia.basescan.org/address/0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA#code)               | ✅ verified |
| MockRewardDistributor (demo only)  | Base Sepolia 84532 | `0xD45c61797d7283caf8A31D91A5Bd6465A45AD561`                         | [view](https://sepolia.basescan.org/address/0xD45c61797d7283caf8A31D91A5Bd6465A45AD561#code)               | ✅ verified |
| Submission transaction (`openRun`) | Base Sepolia 84532 | `0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd` | [view](https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd) | —           |

## Historical dispatch-width measurement

Convoy's current production default is `EXECUTE_FANOUT=1`. Wider fanout is an explicit
measurement/rehearsal override because G-40 recorded real `InvalidNonce()` failures at fanout 4.
The results below are historical throughput measurements, not current stability evidence.

The same 12-item batch was run twice on 2026-08-04 (DEC-007):

| Dispatch width | Elapsed    | Landed  |
| -------------- | ---------- | ------- |
| 4              | **75.5 s** | 12 / 12 |
| 12             | **77.8 s** | 12 / 12 |

Tripling the width changed nothing, and the wider run was marginally slower. Reading every receipt
(DEC-006): nonces strictly increasing — 2485–2488, 2493–2496, 2501–2503 — one transaction per
successive ~2 s block, never batched. **Throughput is bounded by the sequential nonce, not by
Convoy's dispatch.**

The sender is a KeeperHub relay EOA, not the org Turnkey wallet, and this repository does not claim
otherwise (DEC-009, gap G-30).

## Planner eval

Measured against `tests/fixtures/planner.10run.json` — 10 runs, 48 items, 20 labelled dependency
edges — using `openai/gpt-oss-20b:free`. **The fixture was committed before the Planner was ever run
against a model** (`5a09ccc`, ahead of the eval harness), so it cannot have been tuned to the answers.

| Metric                               | Result            | Acceptance |
| ------------------------------------ | ----------------- | ---------- |
| First-pass valid JSON                | **29/29 = 100%**  | ≥ 95%      |
| Dependency recall                    | **53/56 = 0.946** | ≥ 0.9      |
| Cycles emitted                       | **0**             | 0          |
| Precision                            | 0.981             | —          |
| Trap edges emitted                   | 1 / 104           | —          |
| Plans respecting every labelled edge | **29/29**         | —          |

**All three misses were the same kind of miss**, and it does not change what executes. Where the
evidence implies `2 after 1 after 0`, the model records those two edges and omits the redundant
`2 after 0` — one rationale says "and implicitly after price feed", so it read the constraint and
declined to write it twice. The transitive closure differs; the execution order does not, which is
why the last row is 29/29 and not 26/29.

Both numbers come from **one** set of 30 live completions (D-032), all committed under
`tests/fixtures/planner.transcripts/`. CI replays that recording; it does not re-measure, and says so
in its own output.

## Ablation results

Measured from the immutable live artifacts and the PostgreSQL ledger on Base Sepolia (84532). The
11-item fixture is the denominator for the batch description; `landed-item rate` is the harness
metric and uses submitted EXECUTE items as its denominator.

| Configuration      | Submitted → landed (rate) | Failed / invalid | KeeperHub pre-broadcast rejections | Target-level onchain reverts | Wasted-gas events | Budget spent (delta vs baseline) | Starved dependents | Evidence                                                          |
| ------------------ | ------------------------- | ---------------- | ---------------------------------- | ---------------------------- | ----------------- | -------------------------------- | ------------------ | ----------------------------------------------------------------- |
| Full system        | 8 → 8 (100%)              | 0 / 0            | 0                                  | 0                            | 0                 | `0.030967 USDC`                  | 1                  | [`baseline artifact`](docs/milestones/CVY-016-live-baseline.json) |
| `--ablate-planner` | 1 → 1 (100%)              | 0 / 0            | 0                                  | 0                            | 0                 | `0.006555 USDC` (`-0.024412`)    | 0                  | [`Planner artifact`](docs/milestones/CVY-016-live-planner.json)   |
| `--ablate-critic`  | 10 → 8 (80%)              | 2 / 2            | 2                                  | 0                            | 0                 | `0.035589 USDC` (`+0.004622`)    | 1                  | [`Critic artifact`](docs/milestones/CVY-016-live-critic.json)     |

The Planner-ablation rate is 100% only because one item reached EXECUTE; ten of the eleven fixture
items were stopped by the preserved simulation/Critic gate after dependency extraction was removed.
In Critic ablation, exactly ten items were submitted: eight landed and two invalid submissions were
rejected by KeeperHub before a target transaction was broadcast. Those two calls have no target
transaction hash or receipt gas, so they are not described as onchain reverts or wasted gas.

### Accepted live run identities

The JSON artifacts are canonical for every item-level commit/target hash. The ledger-backed open and
seal transactions are recorded here for quick verification:

| Mode             | Ledger run ID                          | Onchain run ID                                                       | Fresh distributor                            | Open transaction                                                                                                          | Seal transaction                                                                                                          |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Baseline         | `0d4bd5aa-1780-4ff0-ad35-fc8cdc236e4f` | `0x6b955b975daf601c80b3f73062ea71eecc337a29a525c7b8d63a16979cb8f32f` | `0xCD3c0F6E5Eb8945C0A95bd8afED1b868CD57f567` | [`0x21d13b1c…def52f`](https://sepolia.basescan.org/tx/0x21d13b1c491b1cb49dde650dd6aac51ea7a6a8bdc62635fd41e22a1c00def52f) | [`0xdb7ac7b7…36a58c`](https://sepolia.basescan.org/tx/0xdb7ac7b79d921c66cde96aa3fdf283d7139c814d4c9ed7c266eb74e13636a58c) |
| Planner ablation | `72e9b3d9-5e8e-49b1-b9a4-49684cfd15a3` | `0xbf5cc4be168c02a48235cb6fc4c4b00bf6a70b55a3b87257500f94e54f70b411` | `0x5c52283f4A56d17009741abbb85b1BB74D49E108` | [`0x953e475c…a66abc`](https://sepolia.basescan.org/tx/0x953e475c9a5b748700d0e3ea0b089a045cabea92d48ed3c8e7f22ace37a66abc) | [`0x6f08c50c…60372`](https://sepolia.basescan.org/tx/0x6f08c50cf93a6da8e64d5e52725c20a8dd8c6aa5079f3dad045b8f75d4d60372)  |
| Critic ablation  | `f7243450-9aaa-49cf-97c3-fa0431dc7144` | `0xe2be0560a5373d2b2f2e8092e8aab0f3cd1720e7c265676cc2c552dff042518e` | `0x350e9ac23E1f35f042EFa11AFfbC7fbCA005Af1B` | [`0x6ce258c2…713c74`](https://sepolia.basescan.org/tx/0x6ce258c2f15aea24c22b13d6bfedb6288eb2e47a8389ee637a9251cc72713c74) | [`0x701404d8…68b66`](https://sepolia.basescan.org/tx/0x701404d88daa13f438a6af396827774b2c7082dbd0de0e325a60ad8309868b66)  |

The baseline and Planner-ablation runs are `SEALED_OK`; the Critic-ablation run is `SEALED_PARTIAL`
because its two invalid target attempts failed without hashes. All three onchain registry records are
sealed, and every recorded transaction hash in the artifacts has a successful Base Sepolia receipt.

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
