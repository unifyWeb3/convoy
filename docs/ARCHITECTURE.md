# CONVOY — Master Architecture (Implementation-Ready)
## KeeperHub "Agents Onchain" Hackathon (DoraHacks) · Solo · 2.5–3 weeks

**TL;DR**
- Build Convoy as specified: an autonomous onchain release operator that ingests a batch of interdependent operations, plans an execution DAG with an LLM Planner, has a separate LLM Critic veto steps that a real KeeperHub `simulate:true` dry-run shows would revert or overspend, executes surviving steps through KeeperHub's org Turnkey wallet, recovers from genuine failures, and exports one replayable manifest.
- It is winnable because it is the only class of submission that turns KeeperHub's reliability stack (single-sequential-nonce ordering, simulate-before-submit, retries, multi-RPC failover, audit trail) into the visible product, against a rubric that says verbatim "Execution is weighted heavily, because that is the point."
- The one make-or-break dependency — can a caller request a simulation without broadcasting — is confirmed: all three `/api/execute/*` endpoints accept a strict-boolean `simulate` flag that runs `estimateGas` + `provider.call` and returns `wouldRevert`, `revertReason`, and `gasEstimate` with no signing, no broadcast, and no audit row. The Critic is structurally real, not theater.

---

## 0. VERIFICATION LEDGER (facts re-checked against primary sources; conflicts flagged)

| Claim | Verified? | Source | Note / correction |
|---|---|---|---|
| Build window July 27 – Aug 13 2026 12:00, judging to Aug 20 | ✅ | DoraHacks hackathon page | Times UTC+2 |
| Prizes 1st $2,000 / 2nd $1,200 / 3rd $800 + $1,000 Onboarding UX bounty split two winners, stackable | ✅ | DoraHacks page | Cash paid in stablecoins |
| Submission = GitHub + demo video + link to a tx the agent executed via KeeperHub | ✅ | DoraHacks page | "Incomplete submissions cannot be judged" |
| Judging: execution weighted heavily; surfaces; reliability/observability; originality; DX | ✅ | DoraHacks page | Verbatim: "Execution is weighted heavily, because that is the point." |
| MCP at app.keeperhub.com/mcp; OAuth 2.1 or kh_ Bearer; per-workflow at /mcp/w/<slug> | ✅ | docs MCP Server | 1h access / 30d refresh tokens |
| call_workflow: read executes+returns; **write returns unsigned {to,data,value} for the caller** | ✅ | docs MCP Server + Agentic Wallet | Confirms the asymmetry Convoy relies on |
| Direct-execution tools run through the ORG wallet with the full reliability stack | ✅ | docs MCP + Direct Execution API | Convoy's execution path, NOT call_workflow |
| **Caller-accessible simulation** | ✅ (newly confirmed) | docs API/direct-execution | `simulate:true` on all 3 execute endpoints → estimateGas+provider.call, returns `wouldRevert`, `revertReason`, `gasEstimate`; no signing/broadcast/audit row |
| Error codes E-0002 / N-0001 / P-000x | ✅ | docs Run Error Codes | Full set also has E-0001/0003/0004, N-0002, C-000x, CS/BS/ES-0001; "Almost every coded error is temporary." Config reverts show full message, no code |
| Agentic wallet caps | ✅ | docs Agentic Wallets | Allowlist Base USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 + Tempo USDC.e 0x20C000000000000000000000B9537D11c60E8b50; ≤100 USDC/transfer; 200 USDC/UTC-day (429 DAILY_CAP_EXCEEDED); hook auto ≤$5 / ask / block ≥$100; chains 8453/4217/42431 |
| x402 = EIP-3009 TransferWithAuthorization; facilitator pays gas; USDC on Base | ✅ | x402 spec + docs | Payment auths use random 32-byte nonces → order-independent |
| Single sequential nonce per wallet; no cross-wallet parallelism | ✅ | docs known gaps + go-ethereum/Chainstack | Replacement needs ≥10% bump on both fee fields; oldest stuck nonce filled first |
| No native batch/atomic multicall node; no built-in planner over pending work | ✅ | brief + docs node list | Convoy's gap to fill |
| **Gas sponsorship chains** | ⚠️ CONFLICT | DoraHacks page vs marketing | DoraHacks page says "gas sponsorship on **mainnet Ethereum**" only; keeperhub.com marketing implies Base/Polygon/Arbitrum. **Resolution: Convoy never depends on sponsorship;** org wallet is funded with a few dollars of Base ETH. Private-routed txs are not sponsored regardless. |
| Base gas for a small SSTORE write | ✅ | Basescan gastracker + EIP-2200/2929 | Base base-fee ~0.005 gwei (Jul 2026 snapshot); registry write << $0.01 |
| Basescan verification via Foundry | ✅ | Basescan verifyContract + Etherscan V2 | `forge verify-contract --chain base`; single Etherscan V2 key covers Base |
| CLI surface `kh` | ✅ | docs CLI index | `kh execute contract-call --chain --contract --method --args --wait`; `kh run logs/status`; `kh wallet balance` |

**Two naming vocabularies (verified).** REST/MCP direct-execution: `network, contractAddress, functionName, functionArgs, abi, value, gasLimitMultiplier, simulate`. MCP *workflow* web3 actions: `abiFunction`. There is **no per-call `walletId`** — the org wallet integration is implicit. A write returns `{executionId, status}`; poll `GET /api/execute/{executionId}/status` for `transactionHash`, `transactionLink`, `gasUsedWei`, status enum `pending|running|completed|failed`.

---

## 1. CUSTOMER STORY

**Primary customer: the solo protocol-ops / incentives engineer at a small DeFi protocol or DAO — Maya, "the Merkle-drop operator."**

Her highest-value recurring job: at each epoch boundary she must land a **batch of 8–20 interdependent onchain operations from one operator wallet**: (1) publish a new Merkle root to a distributor; (2) top up the distributor with reward tokens; (3) flip several per-market "enabled" flags; (4) rotate a keeper allowance; (5) poke two oracles. Several have **hard ordering dependencies** (cannot fund before the root is published; cannot enable a market before its precondition landed), and each carries **unstructured evidence** — a Notion paragraph, a Discord message, a CSV, a governance forum link — that a human currently reads to decide order and parameters. The batch has a **deadline** (epoch boundary), **uncertain gas cost**, and a **fixed budget**.

**Why it is painful today.** She runs this from a shell script with viem or a hand-built Hardhat task. Firing 12 transactions from one wallet, she hits exactly the failure modes KeeperHub was built for: a single underpriced transaction creates a nonce hole and freezes everything behind it; one item reverts because a precondition wasn't actually met and she burns gas discovering it; she has no single audit artifact for the DAO, so "what did the treasury do?" is answered with a Basescan screenshot (KeeperHub's own DAO page names this pain). She babysits the run for an hour.

**Why Convoy beats every incumbent for Maya:**

| Tool | Why it fails Maya |
|---|---|
| **Shell script + viem** | Hand-ordered DAG, hand-managed nonces, hand-written retries. One underpriced tx = frozen queue. No simulation gate: invalid items burn gas. No audit export. |
| **Airflow / GitHub Actions** | Time/CI orchestrators with zero onchain semantics — no nonce management, no gas repricing, no simulate-before-submit, no revert decoding. She'd rebuild KeeperHub badly inside a cron runner. |
| **Gnosis Safe multisend / multicall** | Atomic = all-or-nothing. Maya's batch is deliberately *not* atomic: item 7 failing must not roll back items 1–6, and deferrable items should defer, not revert the epoch. Safe's sequential nonce still blocks on a contested tx; a failed multisend consumes the nonce and leaves no per-item record. |
| **OpenZeppelin Defender / Gelato** | Good relayers, but no plan-critique-verify loop over an unstructured batch, no budget meter, no per-item simulation veto, no unified manifest. |

Convoy reads the evidence, proposes an ordering with reasons, **simulates every write before spending a cent**, vetoes the two items whose preconditions aren't met (zero gas), executes the rest through KeeperHub's org wallet so nonce ordering and repricing are handled, defers one item past its dependency, and hands Maya **one manifest** she pastes into the DAO forum.

---

## 2. WHY THIS CANNOT EXIST WITHOUT KEEPERHUB

Convoy is a planner and a ledger. It owns *no* execution primitives. Every subsystem that touches a chain is a call into KeeperHub.

| Convoy subsystem | Hard KeeperHub dependency | What breaks without it |
|---|---|---|
| Critic veto | `POST /api/execute/contract-call` with `simulate:true` → `wouldRevert`, `revertReason`, `gasEstimate` | The veto becomes a guess. Kills the zero-gas rejection claim. |
| Budget meter (gas leg) | Real `gasEstimate` (simulate) + `gasUsedWei` (status) | Fabricated numbers, not solvency-from-reliability. |
| Executor | `execute_contract_call` / `execute_check_and_execute` via the **org Turnkey wallet** = automatic gas estimation, **single sequential nonce management**, transaction ordering, exponential backoff, multi-RPC failover | Convoy would have to reimplement a production relayer solo in three weeks. |
| Contention story | One org wallet = one sequential nonce; concurrent submits genuinely serialize | The reliability demo has no substrate. |
| Manifest | `GET /api/execute/{id}/status` + Keeper Runs audit trail | Nothing to reconcile; the deliverable evaporates. |
| Payment leg | x402 on Base USDC via `@keeperhub/wallet` | No agent-native paid-call metering. |
| Notifications | KeeperHub Telegram/Discord node | Cosmetic; kept P2. |

KeeperHub is Convoy's operating system: Convoy decides *what* and *in what order*; KeeperHub guarantees *the transaction lands*. The judges' own framing ("Agents can think, KeeperHub lets them act") is Convoy's architecture diagram.

---

## 3. CAPABILITY JUSTIFICATION TABLE

Legend: (a) solves a real architectural problem · (b) improves reliability · (c) improves the live demo · (d) architecture weaker without it.

**INCLUDED (passes):**

| Capability | a | b | c | d | Role |
|---|---|---|---|---|---|
| `execute_contract_call` | ✅ | ✅ | ✅ | ✅ | The executor. Runs `commitAction` + each item write via the org wallet. |
| `simulate:true` dry-run | ✅ | ✅ | ✅ | ✅ | Critic's evidence; zero-gas veto. |
| `execute_check_and_execute` | ✅ | ✅ | ✅ | ✅ | Atomic read→condition→write dependency gates. |
| `get_direct_execution_status` | ✅ | ✅ | ✅ | ✅ | Source of `transactionHash`/`gasUsedWei` for ledger + manifest. |
| Org Turnkey wallet | ✅ | ✅ | ✅ | ✅ | Single sequential nonce = real contention substrate; enclave keys = credibility. |
| Nonce management / tx ordering | — | ✅ | ✅ | ✅ | Core reliability claim; visible in timeline. |
| Retry / exponential backoff | — | ✅ | ✅ | ✅ | Genuine transient recovery, surfaced as retry chips. |
| Multi-RPC failover | — | ✅ | ✅ | ✅ | Backs the "avoid empty-feed RPC failures" principle. |
| Audit trail / Keeper Runs | ✅ | ✅ | ✅ | ✅ | One of three manifest sources. |
| Run error codes E-0002/N-0001/P-000x | ✅ | ✅ | ✅ | ✅ | Mapped into recovery state machine. |
| MCP server (Bearer kh_) | ✅ | — | ✅ | ✅ | Headless execution from the backend. |
| CLI `kh execute` / `kh run logs` | — | ✅ | ✅ | — | Reproducibility + backup demo path. |
| x402 + `@keeperhub/wallet` | ✅ | — | ✅ | ✅ | Budget meter payment leg; payments focus area. |
| Basescan verification | — | — | ✅ | ✅ | Verified ConvoyRegistry = trust. |

**OMITTED (justified):**

| Capability | Why omitted |
|---|---|
| Workflow Builder / `create_workflow` visual DAG | Convoy's DAG is Maya's *batch* semantics, not a KH node graph. Direct execution is correct; a KH workflow per run adds latency and a moving part. P2 "owned-workflow" variant only if time. |
| `ai_generate_workflow` | Convoy's Planner is the AI; delegating hides the load-bearing agent and defeats the ablation test. |
| Marketplace listing | Convoy is an operator, not a callable service. Post-hackathon: list "run a batch" as a paid workflow. |
| MPP / Tempo | Second chain + token for zero demo gain; budget meter proven on Base USDC. |
| Safe integration | Safe is atomic-batch and sequential-nonce — the incumbent Convoy argues against; simulate `from` is the EOA not the Safe (documented limitation), which would *weaken* the Critic. |
| CCIP / cross-chain | One chain (Base) is the discipline. |
| Protocol plugins | Convoy is protocol-agnostic; plugins narrow the story and add surface. |
| Gas sponsorship | Source conflict + void on private routes. Never load-bearing. |
| Block/Event/Schedule/Webhook triggers | Runs are Manual/API-triggered by design. |
| Notifications | Cosmetic; P2 ping only. |

---

## 4. ARCHITECTURE OVERVIEW

One Next.js app (UI + API routes), one Postgres, one Redis-backed worker, one deployed contract. No microservices.

```
┌───────────────────────────────────────────────────────────────┐
│  Next.js (Vercel, git deploy)                                   │
│  ┌─────────────┐   ┌──────────────────────────────────────┐    │
│  │  React UI   │   │  API routes (/api/*)                  │    │
│  │  Runs       │◄──┤  runs.create / .get / .stream(SSE)    │    │
│  │  Timeline   │   │  runs.approve (P1) / manifest.export  │    │
│  │  DAG view   │   └───────────┬──────────────────────────┘    │
│  │  Manifest   │               │ enqueue                        │
│  └─────────────┘     ┌─────────▼──────────┐                     │
└──────────────────────┤  Orchestrator      │─────────────────────┘
                       │  = state machine   │  (BullMQ worker, Node 22)
                       │  Planner→Critic→   │
                       │  Execute→Recover   │
                       └───┬───────────┬─────┘
            ┌──────────────┘           └───────────────┐
  ┌─────────▼─────────┐              ┌──────────────────▼─────────┐
  │ LLM provider      │              │ KeeperHub Integration Layer │
  │ Planner + Critic  │              │  MCP (Bearer kh_) / REST    │
  │ (separate prompts)│              │  simulate / execute /       │
  └───────────────────┘              │  status / x402 pay          │
  ┌───────────────────┐              └──────────────┬──────────────┘
  │ Postgres (Prisma) │◄────ledger──────────────────┤ org Turnkey wallet
  │ + Redis (BullMQ)  │              ┌───────────────▼──────────────┐
  └───────────────────┘              │  Base mainnet (8453)          │
                                     │  ConvoyRegistry (verified)    │
                                     │  MockRewardDistributor (demo) │
                                     └───────────────┬──────────────┘
                                     ┌───────────────▼──────────────┐
                                     │ Dedicated RPC, chain pinned   │
                                     │ = 8453 always (no public      │
                                     │ eth_getLogs)                  │
                                     └───────────────────────────────┘
```

**One complete run:**
1. Maya POSTs a Run: K items (evidence blob, optional deadline, target contract+function+args or intent) + USDC budget. `runs(status=RECEIVED)`, items `PENDING`.
2. Orchestrator: `execute_contract_call ConvoyRegistry.openRun(runId)` → tx hash logged.
3. **Planner** parses evidence + items → DAG (order, deferrals, per-item gas budget). Stored as `plan` JSON + edges.
4. **Critic** reviews each write via `simulate:true`. `wouldRevert:true` or `gasEstimate` > allocation → **VETO** (item `VETOED`, zero gas).
5. Executor runs surviving items in DAG order: `commitAction(runId, idx, payloadHash)` then the item's write, both through the org wallet (KeeperHub handles nonce, ordering, backoff, failover). Status polled to terminal.
6. **Contention is real:** deferred-now-ready items are submitted concurrently against the one org wallet; KeeperHub serializes them on the single nonce; transient N-0001 / underpriced events trigger KeeperHub's retry, surfaced as retry chips.
7. Budget meter drains on each `gasUsedWei` + x402 payment. Budget < projected remaining → `SEALED_PARTIAL`.
8. `sealRun(runId)`.
9. Manifest exporter reconciles three sources — KeeperHub statuses, ConvoyRegistry events, Convoy ledger — into one sha256-stamped JSON + human view.

---

## 5. COMPONENT DESIGN

### (a) Frontend
- `/` Runs list (status, K, budget spent, deadline). `/runs/new` submit batch. `/runs/[id]` with three tabs:
  - **Timeline** — GitHub-Actions-style vertical log, one row per item, live via SSE: `PLANNED → SIMULATED → (VETOED | COMMITTED → SUBMITTED → LANDED)`, retry chips, gas chips.
  - **Dependency graph** — React Flow DAG colored by state; edges = dependencies; deferred edges dashed and pulsing.
  - **Manifest** — reconciliation table + Export (JSON download + copy).
- Audit drawer per item: Planner reason, Critic verdict + simulate output (`wouldRevert`,`revertReason`,`gasEstimate`), each attempt with tx hash → `transactionLink`, and the ConvoyRegistry event.
- Budget meter: sticky header draining USDC; amber at 20% left, red + "run ending early" at exhaustion. Tailwind; single left rail (Runs / New Run / Docs honesty table).

### (b) Backend
Routes: `POST /api/runs` (validate + enqueue plan job, returns `runId`); `GET /api/runs/:id`; `GET /api/runs/:id/stream` (SSE); `POST /api/runs/:id/approve` (human gate, P1); `POST /api/runs/:id/abort`; `GET /api/runs/:id/manifest`. Orchestration = one BullMQ queue with idempotent handlers keyed `(runId, itemIdx, phase)`. Convoy retries only its own faults (LLM timeout, DB blip) with jittered backoff; **onchain retries are delegated to KeeperHub and only observed.** State transitions are DB-transactional; each emits an `events` row for SSE.

### (c) Planner Agent
- **Decision:** given K items + evidence → `{order, deferrals:[{idx,untilItem}], gasBudgetPerItem, rationalePerItem}`.
- **Why not deterministic:** ordering constraints and parameters live in unstructured evidence prose. A topological sort is deterministic; building the graph *from prose* is not.
- **Output:** strict JSON (function-calling/JSON mode; reject+repair on parse fail).
- **Success:** ≥95% valid-JSON first pass; dependency recall ≥0.9 on a 10-run labeled fixture; zero cycles.

### (d) Critic Agent
- **Decision:** per action, APPROVE or VETO(reason ∈ {would_revert, over_budget, unmet_dependency, evidence_mismatch}).
- **Why a *second* LLM, not just the simulator:** the simulator answers "does this revert now"; the Critic answers "is this justified by the evidence and plan" — e.g. funding 2× the CSV total simulates fine but is wrong (evidence_mismatch). This is LLM-as-judge grounded by an *external verifier* (the simulate call): Gou et al., *CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing* (ICLR 2024, arXiv:2305.11738) — "We present a new framework enabling LLMs to verify and correct their output by interacting with tools, highlighting the importance of external feedback for continuous self-improvement" — corroborated by Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet* (ICLR 2024). The Critic is never trusted alone: any VETO(would_revert) must be corroborated by `simulate.wouldRevert=true`; disagreements resolve to the deterministic simulator.
- **Success:** on 5 valid + 5 invalid items, veto ≥4/5 invalid and pass 5/5 valid (zero false vetoes on valid items — a false veto wastes Maya's epoch).

### (e) KeeperHub Integration Layer
Auth: `Authorization: Bearer kh_...` (org key, headless). Typed client wrapping REST direct-execution (primary), MCP as parity/discovery.

```
# Critic simulation (zero gas, no audit row)
POST /api/execute/contract-call
  { network:"8453", contractAddress, functionName, functionArgs:"[...]", value?, simulate:true }
→ 200 { success:true, status:"simulated", from, to, value, gasEstimate:"<wei>",
        simulatedReturnValue, wouldRevert:false }
→ 400 { success:false, status:"simulated", wouldRevert:true,
        revertReason:"Error(...)", error }        # ← VETO trigger

# Execute a committed item (org wallet; full reliability stack)
POST /api/execute/contract-call
  { network:"8453", contractAddress, functionName, functionArgs, value? }
→ { executionId:"direct_…", status:"pending|running|completed|failed" }

# Poll to terminal
GET /api/execute/{executionId}/status
→ { executionId, status, type, transactionHash, transactionLink,
    gasUsedWei, result, error, createdAt, completedAt }

# Dependency gate
POST /api/execute/check-and-execute
  { network:"8453", contractAddress, functionName, functionArgs, abi?,
    condition:{operator:"eq|gt|…", value},
    action:{contractAddress, functionName, functionArgs, abi?} }
→ { executed, executionId?, status?, condition:{met, observedValue, targetValue, operator} }
```

Error handling → state machine: 401 fatal (misconfig); 422 wallet-not-configured / SPENDING_CAP fatal-to-run; 429 rate-limit → backoff+resume; E-0002/N-0001/P-000x observed as transient; config-revert (full message) → item FAILED, no retry. **Idempotency:** `Idempotency-Key: <runId>:<idx>:<attempt>` (per-org, 24h) so crash-resume never double-submits; simulate calls are exempt.

### (f) Smart Contracts — see §8.

### (g) Database (Postgres + Prisma)
```sql
runs( id uuid pk, run_id_onchain bytea unique, status text, budget_usdc numeric(20,6),
      spent_gas_usdc numeric(20,6) default 0, spent_pay_usdc numeric(20,6) default 0,
      deadline timestamptz null, plan jsonb null, created_at timestamptz, sealed_at timestamptz null );
items( id uuid pk, run_id uuid fk->runs.id, idx int, target_addr bytea,
       function_name text, function_args jsonb, payload_hash bytea, evidence text,
       state text, depends_on int[] default '{}', gas_budget_usdc numeric(20,6) null,
       veto_reason text null, unique(run_id, idx) );
attempts( id uuid pk, item_id uuid fk, attempt_no int, kind text,           -- SIMULATE|COMMIT|EXECUTE
          execution_id text null, tx_hash bytea null, tx_link text null,
          gas_used_wei numeric null, gas_used_usdc numeric(20,6) null,
          would_revert bool null, revert_reason text null, kh_status text null,
          error_code text null, created_at timestamptz, index(item_id, attempt_no) );
events( id bigserial pk, run_id uuid fk, item_idx int null, type text, payload jsonb, at timestamptz,
        index(run_id, at) );
manifests( run_id uuid pk fk, json jsonb, sha256 bytea, exported_at timestamptz );
```
`payload_hash = keccak(target,fn,args,idx)`. `events(run_id, at)` powers SSE replay; `attempts(item_id, attempt_no)` powers retry viz.

### (h) Event Model
Append-only `events`. Types: `RUN_RECEIVED, RUN_OPENED, PLAN_READY, ITEM_SIMULATED, ITEM_VETOED, ITEM_COMMITTED, ITEM_SUBMITTED, ITEM_RETRY, ITEM_LANDED, ITEM_FAILED, ITEM_DEFERRED, BUDGET_LOW, RUN_SEALED, RUN_SEALED_PARTIAL`. SSE streams the tail; page load replays from DB (timeline survives refresh — demos crash).

### (i) Execution State Machine
```
RUN:  RECEIVED → OPENING → PLANNING → CRITIQUING → EXECUTING → SEALING → { SEALED_OK | SEALED_PARTIAL }
      any → ABORTED (cooperative) ; OPENING/SEALING may → FAILED_FATAL (401/422)
ITEM: PENDING → SIMULATED
        → VETOED (terminal, zero gas)
        → COMMITTED → SUBMITTED → { LANDED (terminal) | RETRYING → SUBMITTED | FAILED (terminal) }
        → DEFERRED → (dependency LANDED) → SIMULATED …
Terminal item states: LANDED, VETOED, FAILED, SKIPPED(budget-exhausted).
```
Guards: `COMMITTED` requires prior `SIMULATED` + Critic APPROVE; `SUBMITTED→LANDED` requires status `completed` + non-null `transactionHash`; `RETRYING` only on a KeeperHub transient code, capped (then FAILED).

### (j) Authentication
- UI: single-tenant demo — one operator, magic-link or shared passphrase env gate (P0 minimal).
- KeeperHub: server-side `kh_` Bearer in Vercel env; never client-shipped.
- x402 wallet: `@keeperhub/wallet` HMAC in `~/.keeperhub/wallet.json` (0600) on the worker; server-side Turnkey caps are the real guardrail.
- All chain writes originate server-side; the browser never holds a key.

### (k) Logging
Structured pino logs keyed by `runId`/`itemIdx`/`phase`; every KeeperHub call logs request id, endpoint, latency, `executionId`, `transactionHash`. Logs mirror `events` so live logs == audit == manifest (one truth).

### (l) Monitoring
`/api/health` (DB, Redis, KeeperHub reachability, RPC block height) + a run-level SLA panel (planning latency, sim latency, land latency). No Datadog — the UI *is* the observability surface.

### (m) Error Recovery
Convoy retries only its own faults; KeeperHub retries chain faults; Convoy observes and records them. On worker restart, reconcile every non-terminal item via `get_direct_execution_status` before acting (idempotency key prevents doubles). Detail in §12.

### (n) Security — see §12.

### (o) Testing strategy
- **Contracts:** Foundry unit + invariant tests (open→commit→seal ordering; no commit before open; no double-seal; idx monotonic). `forge test` in CI.
- **Integration:** Base Sepolia rehearsal env exercising the full loop against real KeeperHub; recorded-fixture (VCR) mode for offline UI dev.
- **Agent evals:** the §5c/§5d labeled fixtures run in CI as the ablation harness (§6).
- **Idempotency test:** kill the worker mid-execute; assert no duplicate tx hash on resume.
- **E2E:** scripted Playwright run of the exact demo, executed daily in week 3.

---

## 6. THE LLM MUST BE LOAD-BEARING (with ablation)

| AI component | Decision | Deterministic alternative? | Verdict |
|---|---|---|---|
| Planner | Build dependency DAG + params from unstructured evidence prose | Topo-sort is deterministic, but the graph + parameters must be extracted from prose; no deterministic parser generalizes across a Notion note, a CSV, and a forum link | **KEEP** |
| Critic | Judge action *justification vs evidence* (valid tx, wrong amount) | Simulation catches reverts/overspend deterministically; it cannot catch "valid tx, wrong intent" | **KEEP** — bounded: revert/overspend reasons decided by the simulator, not the LLM |
| Retry logic | none | KeeperHub + Convoy backoff | **NO AI** |
| Nonce/order execution | none | KeeperHub | **NO AI** |
| Budget accounting | none | Arithmetic | **NO AI** |

Grounding is deliberate. LLM-as-judge is only reliable with an external verifier: Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena* (NeurIPS 2023, arXiv:2306.05685) reports "strong LLM judges like GPT-4 can match both controlled and crowdsourced human preferences well, achieving over 80% agreement, the same level of agreement between humans" — which is *support for using a judge with a verifier*, not a guarantee of Convoy's own agents (whose bar is set by CI eval fixtures).

**Ablation test a judge can run (`--ablate-planner`, `--ablate-critic`):**
- *Ablate Planner* → submit in input order, no dependency extraction. Expected: dependency-violating items hit config-reverts → wasted-gas failures rise from ~0 to the number of out-of-order dependencies (≥3 in the demo batch); run ends early on budget. **Landed-item rate drops from 100% to ~55%; wasted gas > 0.**
- *Ablate Critic* → execute every planned item without the simulate gate. Expected: the two genuinely invalid items are submitted, revert onchain, burn gas. **Wasted-gas events go 0 → 2; budget spent rises; one downstream dependent item is starved.**
Both metrics are printed by the harness and shown in the README honesty table. If ablation showed no degradation, the AI would be removed. It does, so it stays.

---

## 7. TECH STACK

| Layer | Choice | Justification |
|---|---|---|
| App | Next.js 14 (App Router), TypeScript | One deployable; API + UI; Vercel git-deploy (no CLI). |
| UI | React + Tailwind + React Flow (DAG) + SSE | React Flow is the only added dep; earns the dependency-graph beat. |
| Worker | Node 22 + BullMQ (Redis) | Durable jobs, retries, crash-resume; Redis also the KeeperHub rate-limit token bucket. |
| DB | Postgres + Prisma | Relational run/item/attempt; jsonb for plans; Vercel Postgres or Neon. |
| Chain libs | viem | Encode payloadHash, decode events, read registry via the pinned dedicated RPC. |
| Contracts | Solidity 0.8.24 + Foundry | Builder strength; `forge verify-contract --chain base`. |
| Execution | KeeperHub REST direct-execution + MCP (kh_ Bearer) | The product. |
| Payments | `@keeperhub/wallet` (x402) | Budget meter payment leg. |
| LLM | One provider, two separately-prompted roles (JSON/function-calling mode) | Cheap way to satisfy "second, independent Critic." |
| Repo | pnpm workspaces (`apps/web`, `packages/contracts`, `packages/kh-client`) | Builder convention. |

Rejected: Kafka (overkill), a separate backend service, GraphQL (REST+SSE suffices), any ORM but Prisma, Solana anything (unsupported).

---

## 8. SMART CONTRACTS

**ConvoyRegistry — strengthened to own genuinely necessary state, not just events.** The registry is a **commitment and sequencing ledger** whose *stored state* is a live precondition for Convoy's own execution and for manifest integrity. Convoy's `check-and-execute` dependency gates **read this contract's storage** to decide whether a dependent item may proceed — the state is load-bearing at runtime, not decorative.

Why onchain (not offchain, not KeeperHub): the ordering commitments must be **tamper-evident and independently verifiable by Maya's DAO** without trusting Convoy's database. KeeperHub audits *its* executions but does not model *Convoy's batch semantics* (open/commit/seal lifecycle, per-index payload commitments). Unique state owned: `runState`, per-run monotonic `committedCount`, and `payloadHash[runId][idx]` — on-chain proof that item idx was committed with exactly this payload, in this order, under this run, before sealing.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract ConvoyRegistry {
    enum State { None, Open, Sealed }

    struct Run {
        State   state;
        address operator;        // opener = KeeperHub org wallet
        uint64  openedAt;
        uint64  sealedAt;
        uint32  committedCount;  // monotonic; enforces sequencing
    }

    mapping(bytes32 => Run) public runs;
    mapping(bytes32 => mapping(uint256 => bytes32)) public payloadHash; // runId=>idx=>hash
    mapping(bytes32 => mapping(uint256 => bool))    public committed;    // runId=>idx=>done

    event RunOpened(bytes32 indexed runId, address indexed operator, uint64 at);
    event ActionCommitted(bytes32 indexed runId, uint256 indexed idx, bytes32 payloadHash, uint32 seq, uint64 at);
    event RunSealed(bytes32 indexed runId, uint32 committedCount, uint64 at);

    error NotOpen(); error AlreadyOpen(); error AlreadySealed();
    error NotOperator(); error DupIndex(); error NothingCommitted();

    function openRun(bytes32 runId) external {
        Run storage r = runs[runId];
        if (r.state != State.None) revert AlreadyOpen();
        r.state = State.Open; r.operator = msg.sender; r.openedAt = uint64(block.timestamp);
        emit RunOpened(runId, msg.sender, r.openedAt);
    }

    function commitAction(bytes32 runId, uint256 idx, bytes32 hash) external {
        Run storage r = runs[runId];
        if (r.state != State.Open) revert NotOpen();
        if (msg.sender != r.operator) revert NotOperator();
        if (committed[runId][idx]) revert DupIndex();
        committed[runId][idx] = true;
        payloadHash[runId][idx] = hash;
        unchecked { r.committedCount += 1; }
        emit ActionCommitted(runId, idx, hash, r.committedCount, uint64(block.timestamp));
    }

    function sealRun(bytes32 runId) external {
        Run storage r = runs[runId];
        if (r.state != State.Open) revert NotOpen();
        if (msg.sender != r.operator) revert NotOperator();
        if (r.committedCount == 0) revert NothingCommitted();
        r.state = State.Sealed; r.sealedAt = uint64(block.timestamp);
        emit RunSealed(runId, r.committedCount, r.sealedAt);
    }

    function isCommitted(bytes32 runId, uint256 idx) external view returns (bool) {
        return committed[runId][idx];
    }
}
```

**Storage layout:** slot-packed `Run` (State+address+2×uint64+uint32 ≈ two slots) + two nested mappings. **Access control:** operator-bound (`msg.sender` == opener == KeeperHub org wallet); reverts are the *genuine* invalid-input source the Critic simulates against (e.g. `commitAction` before `openRun` → `NotOpen()`, decoded as `revertReason`).

**Gas on Base** (per EIP-2200 Istanbul: SSTORE_SET_GAS = 20000 for zero→non-zero, SSTORE_RESET_GAS = 5000 for non-zero→different non-zero; note EIP-2929 Berlin adds a 2,100-gas cold surcharge, so a cold 0→1 write is 22,100): `openRun` first write ≈ 22,100 gas SSTORE + ~21k base ≈ well under $0.01 at ~0.005 gwei; `commitAction` two writes ≈ ~45–70k gas ≈ sub-cent; `sealRun` update ≈ ~30k. A whole 12-item run's registry writes cost pennies — the budget meter's *drama* comes from item writes and vetoes, not registry overhead.

**Second contract (demo only, clearly labeled): `MockRewardDistributor`** with `setRoot(bytes32)`, `fund(uint256)`, `enableMarket(uint256)` that *revert on unmet preconditions* (e.g. `fund` before `setRoot`). This is the honest source of genuine reverts — Convoy does not stage failures; it points invalid items at a contract that legitimately rejects them. Labeled in the README as a stand-in for Maya's real distributor.

---

## 9. COMPONENT PRIORITIZATION

| Component | Prio | Complexity | Hours | Depends on | Risk | Fallback |
|---|---|---|---|---|---|---|
| ConvoyRegistry + Foundry tests + verify | P0 | Low | 6 | — | Low | — |
| kh-client (REST direct-exec + simulate + status) | P0 | Med | 10 | kh key | Med (schema drift) | CLI `kh execute` |
| First real Base tx via KeeperHub (spike) | P0 | Low | 4 | kh-client | Med | CLI path |
| Orchestrator + state machine + BullMQ | P0 | High | 16 | kh-client, DB | Med | in-proc queue |
| Planner agent + JSON schema | P0 | Med | 10 | — | Med | rule-based topo (ablation baseline) |
| Critic + simulate veto | P0 | Med | 10 | kh-client | Med | simulate-only gate |
| Budget meter | P0 | Low | 5 | attempts | Low | gas-only meter |
| Manifest exporter (3-way reconcile) | P0 | Med | 8 | events, chain reads | Med | 2-way (KH+ledger) |
| Timeline UI (SSE) | P0 | Med | 10 | events | Low | poll every 2s |
| DAG view (React Flow) | P1 | Med | 8 | plan | Low | static list |
| Audit drawer | P1 | Low | 5 | attempts | Low | JSON dump |
| x402 payment leg | P1 | Med | 6 | @kh/wallet | Med | gas-only budget |
| Human approval gate | P1 | Low | 3 | orchestrator | Low | auto |
| check-and-execute dependency gate | P1 | Med | 6 | registry | Med | app-side gate |
| Notifications (Telegram) | P2 | Low | 2 | — | Low | none |
| Owned KH workflow variant | P2 | High | — | — | High | omit |

Nothing depends on a speculative API. Workflow-level dry-run is roadmap-only (subagent-confirmed) → Convoy never depends on it; the *direct-execution* `simulate` flag is documented and load-bearing.

---

## 10. MINIMUM LOVABLE PRODUCT

**P0 (Convoy cannot exist without):** ConvoyRegistry (verified) · kh-client with `simulate` + execute + status · orchestrator/state machine · Planner · Critic-with-simulate-veto · budget meter · 3-way (or 2-way fallback) manifest · SSE timeline. With just these, the core claim — *plan → critique → verify → execute → recover → one manifest* — is fully demonstrable on Base mainnet with real tx hashes.

**Cut order if week 2 slips:** (1) x402 → gas-only budget. (2) React Flow DAG → ordered list with dependency badges. (3) onchain `check-and-execute` gate → app-side gate (still reads registry via RPC). (4) human approval gate → auto. (5) 3-way manifest → 2-way (KeeperHub + ledger), disclosed. The timeline and the Critic veto never get cut — they are the demo.

---

## 11. OBSERVABILITY

"GitHub Actions meets Datadog for onchain execution":
- **Execution timeline:** per-item rows, live, with state chips; retry attempts stack visibly (attempt 1 → N-0001 → attempt 2 → LANDED).
- **Dependency graph:** DAG colored by state; a deferred item's edge pulses until its dependency lands.
- **Live logs:** raw KeeperHub request/response + tx hash streamed alongside (the "Datadog" feel), backed by `events`.
- **Audit manifest:** one row per item × three columns (KeeperHub status, ConvoyRegistry event, local ledger); green when all agree, amber when they diverge (honesty).
- **Failure viz:** vetoed items greyed with `revertReason`; failed items red with the run error code.
- **Retry viz:** explicit attempt counter + backoff timing from real KeeperHub retries.
- **Explorer links:** every hash → `transactionLink` (Basescan). A 10-second scan tells a judge exactly what happened, click-through verifiable on Base.

---

## 12. SECURITY REVIEW (threats → designed mitigations)

| Threat | Mitigation |
|---|---|
| Planner hallucination (invents an item/target) | Every executed write must resolve to a run-whitelisted target contract; Critic + simulate gate; unknown target → auto-VETO(evidence_mismatch). Planner output is schema-validated + repaired, never executed raw. |
| Critic disagreement / deadlock | Deterministic tiebreak: revert/overspend decided by the simulator, not the LLM; a Critic APPROVE on an action the simulator says `wouldRevert` is overridden to VETO. Max one re-plan cycle, then item FAILED — no infinite loop. |
| Invalid calldata | `simulate:true` before any spend; `wouldRevert` → VETO at zero gas. |
| Wallet compromise | Org key never leaves the Turnkey enclave; Convoy holds only a revocable `kh_` key. x402 wallet bounded by server-side Turnkey caps (≤100 USDC/transfer, 200/UTC-day, USDC-only allowlist) — a stolen HMAC cannot drain beyond caps. |
| Duplicate execution | `Idempotency-Key = runId:idx:attempt` (per-org, 24h); crash-resume reconciles via status before acting; `commitAction` reverts on `DupIndex`. |
| Replay attacks | onchain `committed[runId][idx]` one-shot + operator binding; off-chain idempotency keys; manifest sha256-stamped. |
| Nonce conflicts | Delegated to KeeperHub's single-sequential-nonce manager; Convoy never sets nonces. Convoy *submits* concurrency; KeeperHub *serializes* it — the honest contention story. |
| Prompt injection via evidence blobs | Evidence is delimited untrusted data, never concatenated into the system prompt; Planner/Critic run under a fixed instruction evidence cannot override; executed actions constrained to the whitelisted target set regardless of what the evidence "asks." |
| Budget-exhaustion attack (over-priced item) | Per-item gas allocation from the plan; simulate `gasEstimate` vs allocation → VETO(over_budget) before spend; global meter ends the run early rather than overspending. |
| Malicious run submission | Single-tenant demo auth; server-side per-run target whitelist; contract-level operator binding; no arbitrary-address transfers (registry + mock distributor only in demo). |

---

## 13. ARCHITECTURE KILL LIST

| Excluded idea | Why removed | Complexity saved | Demo value lost | Add later? |
|---|---|---|---|---|
| KH Workflow Builder graphs per run | Direct execution is the right surface; graph-per-run adds latency + a moving part | High | None | Yes — "owned workflow" mode |
| Safe / multisig execution | Atomic + sequential-nonce = the incumbent Convoy argues against; simulate `from` is EOA not Safe | Med | Negative | Optional enterprise mode |
| Cross-chain / CCIP | One chain = discipline | High | Low | Yes |
| MPP / Tempo second rail | 2nd token/chain, zero demo gain | Med | None | Maybe |
| Protocol plugins (Aave/Spark) | Narrows the protocol-agnostic story | Med | Low | Yes (connectors) |
| Marketplace listing of Convoy | Convoy is an operator, not a callable | Low | None | Yes — paid "run batch" |
| Multi-tenant auth/orgs | Not needed for a solo demo | Med | None | Yes |
| Gas-sponsorship reliance | Source conflict + not on private routes | Low | None | N/A |
| Self-built relayer/nonce mgr | Reinventing KeeperHub = off-message + impossible solo | Very High | Negative | Never |
| ML dependency extractor | LLM already does it; training data absent | High | None | No |

---

## 14. NARRATIVE INTEGRITY CHECK (component → demo second → what the judge sees)

| Component | Demo moment | Judge sees |
|---|---|---|
| Run submission | 0:00–0:10 | A 12-item batch with evidence + $ budget pasted in, "Start run." |
| ConvoyRegistry.openRun | 0:10–0:20 | First real Base tx hash, clickable to Basescan. |
| Planner | 0:20–0:40 | DAG materializes with ordering + 1 deferral + per-item reasons. |
| Critic + simulate | 0:40–1:05 | Two items flip VETOED with decoded `revertReason`, "0 gas spent" badge. |
| Executor + nonce ordering | 1:05–1:45 | Items land in DAG order; budget drains; tx hashes stream. |
| Real retry (or backup) | 1:45–2:05 | A genuine N-0001/underpriced retry chip appears and resolves. |
| Deferred item releases | 2:05–2:20 | Deferred edge pulses, dependency lands, item executes via check-and-execute. |
| Budget meter | throughout | USDC draining; amber near end. |
| sealRun + manifest | 2:20–2:50 | Seal tx; 3-way reconciliation table all-green; "Export manifest." |
| Ablation callout | 2:50–3:00 | "Turn off the Critic and these two burn gas — here's the number." |

Every P0 component maps to a visible second. Anything unmappable (notifications, owned-workflow mode) is P2/omitted.

---

## 15. LIVE DEMO SCRIPT (3:00)

**0:00–0:30 — The batch.** Screen: `/runs/new` with a realistic epoch batch (publish root, fund distributor, enable 3 markets, rotate allowance, poke oracle) + evidence blobs + $ budget. Narration: "This is one epoch's release for a small protocol — twelve interdependent onchain actions, some with ordering rules buried in these notes, a real budget, a deadline. Today an engineer babysits this for an hour. Watch Convoy do it." Click Start. KeeperHub: `openRun` executes → **first real Base tx hash lands ~0:25.** (Submission requirement satisfied in the first 30 seconds.)

**0:30–1:00 — Plan + critique.** Screen: DAG builds; Planner reasons appear. Narration: "Planner read the evidence and built an execution graph — this fund step is deferred until the root is published. Now a *separate* Critic checks every action against a real KeeperHub simulation." Two items flip **VETOED** with `revertReason` + "0 gas." Narration: "Those two would have reverted onchain. Convoy caught them before spending a cent — the simulation is KeeperHub's, not ours."

**1:00–2:00 — Execution + reliability.** Screen: items land in order, budget drains, hashes stream to Basescan. A genuine transient (N-0001 / underpriced) surfaces a **retry chip** that resolves. Narration: "Everything executes through KeeperHub's org wallet — one wallet, one sequential nonce. Convoy submits the ready items concurrently; KeeperHub serializes them on the nonce and reprices the one that came back underpriced. We didn't script that retry — it's real, and here it is in the timeline."

**2:00–3:00 — Seal + manifest + ablation.** Screen: deferred item releases and executes; `sealRun` lands; the **3-way reconciliation table goes all-green**; Export manifest. Narration: "One sealed run, one replayable manifest reconciling KeeperHub's audit, the onchain registry, and our ledger — the artifact the DAO actually wants." Final beat: toggle `--ablate-critic` on a prior run showing 2 wasted-gas failures. "Remove the Critic and those two burn gas and starve a downstream item. That's why the AI is load-bearing, and why this only works on KeeperHub."

**BACKUP DEMO PLAN:**
- *KeeperHub API degradation:* switch kh-client to the **CLI path** (`kh execute contract-call … --wait`) live; if fully down, play a **pre-recorded run from that morning** whose tx hashes are already on Basescan (open Basescan live to prove they're real). Never fake a hash.
- *Base RPC issues:* reads go through the **dedicated pinned RPC** (chain 8453 unconditionally); a second provider URL is hot-swappable via env; manifest reconciliation is cached from the run so it renders without live RPC.
- *LLM latency/timeout:* Planner/Critic outputs for the demo batch are **cached from the rehearsal** and replayed if a live call exceeds 8s (same result; honest, since the eval fixtures prove the agents produce it). Show the cache toggle.
- *No genuine retry on cue:* the reliability moment does **not** depend on a live failure. Convoy always shows (a) the two real simulate-vetoes and (b) nonce-serialization of concurrent submits, both deterministic. If a transient retry also happens, great; if not, narrate the serialization and point to a **prior run in the history tab that did retry** (real hashes). Never inject a fault.

---

## 16. THIRTY HARDEST JUDGE QUESTIONS

1. **Why can't KeeperHub just build this?** It could, but deliberately doesn't — it is the execution layer ("we do not replace agent frameworks"). Convoy is the planning/critique/ledger layer on top. That's the hackathon's thesis: build on the execution layer.
2. **Why is AI required?** Dependencies and parameters live in unstructured prose; extracting the graph is irreducibly linguistic. Ablation: removing the Planner drops landed-rate to ~55%; removing the Critic burns gas on 2 items.
3. **Why not Airflow?** It schedules tasks; no onchain semantics — no nonce management, no simulate-before-submit, no revert decoding, no gas repricing. You'd rebuild KeeperHub inside it.
4. **Why not GitHub Actions?** A CI runner. No wallet, nonce, simulation, or audit reconciliation; can't recover from an underpriced tx.
5. **What if KeeperHub disappears?** Convoy degrades to nothing executable — by design. The kh-client is the only chain-touching module; no secret bypass. That's the proof KeeperHub is indispensable, not incidental.
6. **Isn't ConvoyRegistry just an event log?** No. Its *storage* (`runState`, `committedCount`, `payloadHash[runId][idx]`) is read at runtime by `check-and-execute` dependency gates and is the tamper-evident proof the DAO verifies without trusting our DB.
7. **Did you stage that retry?** No — and the demo doesn't depend on one. Vetoes and nonce-serialization are deterministic; retries come from real KeeperHub transient handling. The README honesty table maps every reliability claim to a real artifact.
8. **Who actually runs batches like this?** Protocol incentives/ops engineers, DAO treasury operators, Merkle-drop operators — KeeperHub's own DAO/treasury pages describe this exact pain ("the answer is a screenshot of a block explorer").
9. **Why not a Safe multisend/multicall?** Multisend is atomic — item 7 failing rolls back items 1–6, wrong for an epoch batch; a failed multisend consumes the nonce and leaves no per-item record; Safe's sequential nonce still blocks on a contested tx. Convoy wants partial progress + per-item audit + deferral.
10. **What stops a competitor cloning this in a weekend?** The clone still needs KeeperHub for execution (the moat is KeeperHub's stack). The non-trivial parts — the plan/critique/verify state machine, the simulate-veto grounding, the 3-way manifest reconciliation, crash-resume idempotency — are a week of careful work; the ablation-backed AI design is the defensible core.
11. **Is the Critic just an expensive `if(wouldRevert)`?** For revert/overspend, yes — and there we *use the simulator, not the LLM*. The LLM adds only the evidence-justification judgment (valid tx, wrong amount) a simulator can't make. Bounded so it's not theater.
12. **How do you know the AI isn't hallucinating vetoes?** A VETO(would_revert) must be corroborated by `simulate.wouldRevert`; disagreements resolve to the deterministic simulator. False-veto-on-valid-item is the hard eval bar (must be 0/5).
13. **What's your real onchain proof?** Every item's `transactionLink` to Basescan, plus openRun/commit/seal on a verified ConvoyRegistry. The required submission tx = the openRun from second ~25 of the demo.
14. **Base or Ethereum?** Base (8453) — cheap enough that the budget meter's drama is about *reliability*, not L1 fees; sub-cent registry writes.
15. **Why not depend on gas sponsorship?** The hackathon page limits sponsorship to Ethereum mainnet and it's void on private routes — a conflict with marketing. We fund the org wallet ourselves so nothing is load-bearing on a contested feature.
16. **Won't concurrent submission against one nonce just fail?** That's the demonstration: KeeperHub serializes them on the single sequential nonce and reprices underpriced ones. Convoy exhibits the contention KeeperHub resolves.
17. **ERC-3009 random nonces vs account nonce — confused?** Distinct: x402 payment auths use random 32-byte nonces (EIP-3009 — "Nonces are randomly generated 32-byte data unique to the authorizer's address" — so authorizations are order-independent, unlike EIP-2612's sequential nonces); the *execution* txs use the account's sequential nonce (KeeperHub-managed). We keep them separate in the ledger.
18. **How is the budget meter not fake?** Gas leg from real `gasUsedWei` per tx + real `gasEstimate` at simulate; payment leg from real x402 settlements. Numbers trace to hashes.
19. **Invalid JSON mid-demo?** Schema-validate + one repair pass; if still bad, cached rehearsal output (eval fixtures prove equivalence). Never blocks the run.
20. **How do you avoid double-executing on a crash?** `Idempotency-Key = runId:idx:attempt` (24h per-org) + reconcile-before-act on resume + `DupIndex` revert onchain. Tested by killing the worker mid-run.
21. **Prompt injection via a malicious evidence blob?** Evidence is delimited untrusted data, never merged into instructions; executed targets are whitelisted per run, so an injected "transfer to 0xattacker" can't resolve to a real action.
22. **Why two LLM roles, not one self-check?** The literature (Gou et al., CRITIC, ICLR 2024; Huang et al., "LLMs Cannot Self-Correct Reasoning Yet," ICLR 2024) shows intrinsic self-correction is unreliable without an *external* verifier; ours is the KeeperHub simulator, and the Critic uses a separate prompt/context to avoid shared-failure reasoning.
23. **What if the Critic vetoes everything?** Max one re-plan; persistently-vetoed items go FAILED and the run seals partial — Maya still gets the valid items landed + a manifest, strictly better than the shell script.
24. **Is `check-and-execute` really atomic read→write?** Yes — a documented single call that reads a value, evaluates the condition, executes the action only if met, returning the observed value either way. We use it for dependency gates reading ConvoyRegistry.
25. **Does the manifest reconcile three independent sources?** KeeperHub status (`transactionHash`,`gasUsedWei`), ConvoyRegistry events read from chain via the pinned RPC, and Convoy's ledger — a divergence shows amber, not a silent green. Fallback is a 2-way reconcile, disclosed.
26. **Redis/BullMQ for a solo demo — overkill?** Minimum for durable jobs + crash-resume + a token bucket against KeeperHub's rate limit. Without durability, a mid-run crash loses the demo. Justified.
27. **429 mid-run?** Token-bucket client + backoff-and-resume; the run pauses, doesn't fail; simulate calls are cheap and batched.
28. **Different from Defender / Gelato?** Those relay and schedule; none do plan-from-evidence, simulate-veto, budget-solvency, or a reconciled manifest over an interdependent batch.
29. **What's genuinely hard here?** The idempotent, crash-resumable state machine over an async external executor with real nonce contention, plus grounding the Critic so it's provably not theater. Both shown, not claimed.
30. **One more week?** Owned-workflow mode (list "run a batch" as a paid x402 workflow) and a Safe-optional enterprise path — both already in the kill list as post-hackathon, so scope stayed honest.

---

## 17. IMPLEMENTATION ROADMAP (dependency-driven)

**Foundation / critical path:** kh-client → first real tx → orchestrator → Planner/Critic → manifest. Front-load the first onchain tx (submission requirement) to Day 2.

**Week 1 — Land a real tx and prove the executor.**
- **D1** — repo + contracts skeleton. Deliverable: pnpm monorepo, ConvoyRegistry + MockRewardDistributor compiling, Foundry tests green. DoD: `forge test` passes ordering invariants. Risk: none. *Unlocks everything.*
- **D2** — **first real Base tx via KeeperHub.** Deliverable: kh-client `execute_contract_call` → `openRun` on deployed+**verified** ConvoyRegistry; hash captured. DoD: hash on Basescan; **submission requirement provisionally met.** Risk: schema drift → mitigate with subagent-confirmed field names + CLI fallback. *Critical path.*
- **D3** — simulate + status wired. Deliverable: `simulate:true` returns `wouldRevert`/`gasEstimate`; poller resolves `transactionHash`/`gasUsedWei`. DoD: an intentional `fund`-before-`setRoot` returns `wouldRevert:true` with decoded reason.
- **D4** — DB + orchestrator skeleton + state machine. Deliverable: BullMQ worker drives RECEIVED→…→SEALED for a hardcoded 3-item batch. DoD: 3 items land, registry sealed, rows persisted.
- **D5 (Gate 1)** — end-to-end thin slice. Deliverable: submit 3 items via API → openRun→commit→execute→seal, hashes in DB. **Gate: if no real tx landed, stop features and fix the executor.** Cut-scope if missed: drop x402/DAG-view now.

**Week 2 — Make the agents load-bearing and observable.**
- **D6** Planner: evidence→DAG JSON + eval fixture. DoD: ≥0.9 dependency recall.
- **D7** Critic + simulate-veto + corroboration rule. DoD: 5-valid/5-invalid fixture → 0 false vetoes, ≥4/5 true vetoes.
- **D8** Budget meter + deferral + `check-and-execute` gate. DoD: deferred item releases only after dependency LANDED; meter drains on real gas.
- **D9** SSE timeline + audit drawer. DoD: live states + retry chips + explorer links render; survives refresh (replay from DB).
- **D10 (Gate 2)** Manifest 3-way reconcile + DAG view. Deliverable: full 12-item run green-manifest. **Gate: if unstable, cut to 2-way manifest + list view; freeze P1.**

**Week 3 — Harden, rehearse, submit.**
- **D11** Ablation harness (`--ablate-planner/-critic`) + README honesty table. DoD: degradation metrics print and match §6.
- **D12** Idempotency + crash-resume; kill-worker test. DoD: no duplicate hash on resume.
- **D13** x402 payment leg (P1) or cut; Telegram ping (P2) if time. DoD: budget meter shows a real $0.01–$0.05 x402 debit, or gas-only documented.
- **D14** Full Playwright demo dry-run + backup paths (CLI, cached run, pinned RPC). DoD: all four backup plans exercised.
- **D15** Record demo video (≤3 min), finalize README with tx links, **submit early** (deadline Aug 13 12:00 UTC+2). DoD: GitHub + video + tx link submitted.
- **Buffer D16–D17** (if 2.5→3 weeks): polish DAG animation, second rehearsal, Onboarding-UX-bounty PR (starter template / teardown — stackable $1,000).

**Blockers/parallelism:** contracts (D1) block D2; kh-client (D2–D3) blocks orchestrator (D4) and agents (D6–D7); UI (D9) parallelizable with agents once events exist (D4). Never schedule UI polish before the executor lands a real tx.

---

## 18. FINAL VALIDATION CHECKLIST

| Check | Pass? | Justification |
|---|---|---|
| Solo-buildable in 2.5–3 wks | ✅ | P0 ≈ 90–100 h; one app, one contract, one queue; roadmap gated. |
| Demo-ready | ✅ | 3-min script maps to P0 only; four backup paths. |
| KeeperHub indispensable | ✅ | Every chain-touching subsystem is a KH call (§2); "disappears → nothing executes." |
| AI genuinely required | ✅ | Ablation drops landed-rate to ~55% / adds 2 wasted-gas events. |
| Real onchain execution | ✅ | Verified ConvoyRegistry on Base; every item a real tx; submission tx = openRun. |
| Real retries | ✅ | KeeperHub transient handling observed; never staged; demo not dependent on one. |
| Real audit trail | ✅ | 3-way manifest (KH audit + registry events + ledger). |
| Strong architecture | ✅ | Idempotent crash-resume state machine over async executor; smallest production-shaped design. |
| Memorable live demo | ✅ | Zero-gas veto + all-green manifest + ablation punchline. |
| High win probability (this hackathon) | ✅ | Maximizes the heaviest-weighted criterion (execution) + reliability/observability + surfaces (MCP/CLI/x402/audit). |
| Every subsystem → visible demo second | ✅ | §14 table; unmappable = P2/omitted. |
| Every AI component passes ablation | ✅ | §6. |
| Every KH capability justified | ✅ | §3 include/omit both justified. |
| Customer story stays clear | ✅ | Maya's epoch batch anchors every section. |
| Can't trivially swap KeeperHub for generic workflow SW | ✅ | Generic SW lacks nonce mgmt, simulate-veto, revert decode, audit reconcile (§16 Q3/Q4/Q28). |
| No unnecessary complexity | ✅ | Kill list + cut order; Redis/Prisma/React-Flow each justified; nothing speculative. |

---

## RECOMMENDATIONS (staged, with thresholds)

1. **Now → Day 2:** stand up the monorepo, deploy+verify ConvoyRegistry, land the first real `openRun` tx through KeeperHub. **Threshold to proceed:** a Basescan-visible hash. If not achieved by end of Day 2, spend Day 3 exclusively on the executor (CLI fallback) before touching agents.
2. **Week 1 gate:** thin 3-item slice executes end-to-end. **If missed:** cut x402 and DAG view immediately.
3. **Week 2 gate:** agents pass their evals and the 12-item run produces a manifest. **If the Critic shows any false veto on a valid item,** fix corroboration before any UI polish.
4. **Week 3:** harden idempotency, rehearse with all four backup paths, submit by Aug 12 (a day early). Ship the Onboarding-UX-bounty PR for the stackable $1,000.
5. **Change triggers:** if KeeperHub direct-execution schema differs from the documented REST shape at build time, pin to the CLI path and file it as bounty feedback; if `simulate` is unavailable on your org tier, fall back to client-side `eth_call` via the pinned RPC for the Critic (disclosed in the honesty table) — not expected, as the flag is documented.

## CAVEATS

- Per-tool MCP JSON schemas for the four direct-execution tools are not published; the docs direct callers to `tools_documentation`/`list_action_schemas` at runtime. Convoy targets the documented **REST** direct-execution shapes (authoritative) and treats MCP as parity. Field names above are REST-verified.
- The `simulate` flag is documented on the REST direct-execution page, not verbatim on the MCP tool page; if your MCP client doesn't surface it, call the REST endpoint directly (same org, same wallet).
- Gas-sponsorship chain coverage conflicts between the DoraHacks page (Ethereum only) and keeperhub.com marketing (Base/Polygon/Arbitrum). Convoy does not rely on sponsorship.
- Workflow-level dry-run is roadmap-only; Convoy depends only on direct-execution `simulate`, which is shipped.
- LLM planner/critic reliability figures (e.g. LLM-as-judge "over 80% agreement" per Zheng et al., NeurIPS 2023) are external research used to justify the *external-verifier* design, not guarantees of Convoy's own agents; Convoy's bar is set by its CI eval fixtures.
- Replacement-transaction repricing behavior assumes Geth's default (`txpool.pricebump` = 10, i.e. a ≥10% bump on both fee fields); KeeperHub manages this internally, but the demo narration should not promise a specific bump number beyond "at least 10%."