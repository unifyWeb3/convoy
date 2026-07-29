# CONVOY — Implementation Blueprint (Engineering Execution Handbook)

**This handbook converts the frozen Convoy product + architecture into a milestone-by-milestone build plan an AI coding agent (Claude Code) can execute from bootstrap to demo, and its single most important instruction is: front-load the first real Base transaction (`openRun`) to Day 2 (CVY-003) so the hackathon submission requirement is provisionally met before any feature work, then build the reliability spine (state machine → gate 1 → crash-resume) that the judges weight most heavily.** Everything below is verified against live KeeperHub docs (July 2026), Foundry, Prisma, BullMQ v5, Next.js 14, and viem. Where live sources contradict the frozen spec, the drift is recorded in KNOWN_GAPS and mitigated in code — the architecture is **not** changed.

## TL;DR
- **Build the spine first, features second.** Order is CVY-000 bootstrap → contracts → kh-client → **first real Base tx (D2)** → DB/queue/budget → orchestrator state machine → **Gate 1** → SSE UI / Planner+Critic / manifest → **Gate 2** → crash-resume → ablation → demo+submit. One engineering objective per milestone; each ends deployable and building.
- **The frozen KeeperHub API shapes have drifted in three verified ways** — the request field is now `chainId` (with `network` deprecated), writes execute **synchronously** (HTTP 202 `status:"completed"`), and the daily cap returns **403** not 422. The kh-client mitigates all three (send both fields, short-circuit the poll, classify 403+422 as fatal-to-run) and the drift is logged in KNOWN_GAPS. The architecture is preserved.
- **Reliability must be structurally real and mechanically enforced.** Convoy never sets a nonce, never holds a key, never stages a failure — verified by CI grep-guards, a recovery playbook, and a kill-worker-no-duplicate-tx test. Ship the P0 "minimum lovable product" (timeline + Critic veto never cut), follow the locked cut order if week 2 slips, and submit early (D15) with a real Basescan tx link.

---

## Key Findings

- **The KeeperHub direct-execution path is the whole product and it is well-documented and stable.** `POST /api/execute/contract-call` with `simulate:true` is a zero-gas, zero-audit-row dry run returning `{wouldRevert, revertReason, gasEstimate}` — this is the genuine VETO source. Writes return an `executionId` and status; the status endpoint returns `transactionHash`/`transactionLink`. `check-and-execute` reads a contract value and conditionally writes. Idempotency keys are per-org, replayable for 24 hours. This is enough to build Convoy without inventing any capability.
- **Three field-level discrepancies between the frozen spec and live docs must be handled, not redesigned.** They are the single largest implementation risk and are all resolved in the kh-client package (the only place allowed to touch KeeperHub).
- **The dependency graph has a clear critical path** (`002→003→004→008→GATE1→012→GATE2→015→019`) with three parallelizable tracks after the orchestrator lands (UI, agents, P1 features). This matches the locked D1–D15 roadmap and the two gates.
- **Every reliability claim maps to a mechanical check** — CI build/test, invariant tests, an ablation harness, and grep-guards that ban nonces, held keys, and staged failures in non-test code.

---

## Details

### STEP A — Engineering Review (resolved without architecture change)

| # | Issue | Resolution | Lands in |
|---|-------|-----------|----------|
| A1 | Frozen spec sends `network:"8453"`; live docs say the field is now `chainId`, and `network` is deprecated (still accepts chain names). | kh-client sends **both** `chainId:"8453"` and `network:"8453"` on every write/simulate. Record the drift; do not change architecture. | KNOWN_GAPS G-01; CVY-004 |
| A2 | Frozen state machine assumes async polling (pending→running→completed). Live docs: contract-call **executes synchronously**, returns HTTP 202 `{executionId, status:"completed"\|"failed"}`. | EXECUTE phase treats the POST response as possibly-terminal: if `status` is already terminal, short-circuit the poll; else poll `/status`. State machine unchanged (SUBMITTED→LANDED still guarded by `completed`+txHash). | KNOWN_GAPS G-02; CVY-004, CVY-008 |
| A3 | Spending cap: frozen says `422 SPENDING_CAP`; live docs say `403 "Daily spending cap exceeded"`. | Treat **both** 403(cap) and 422(WALLET_NOT_CONFIGURED) as fatal-to-run. | KNOWN_GAPS G-03; CVY-008 |
| A4 | `payloadHash = keccak(target, fn, args, idx)` under-specified for Sol↔TS byte parity. | Pin exact encoding (below); identical helper in `ConvoyRegistry` and kh-client; parity test asserts Sol==TS. | CVY-002, CVY-004 |
| A5 | `gas_used_wei → gas_used_usdc` conversion undefined. | `gasUsedWei` is total fee in wei (ETH). `usdc = (gasUsedWei/1e18) * runEthUsd`, where `runEthUsd` is frozen at run open (env, never a load-bearing live oracle). | CVY-007; KNOWN_GAPS G-04 |
| A6 | SSE reconnect/replay semantics unspecified. | `events.id` (bigserial) is the SSE event id. Client sends `Last-Event-ID`; route replays `events WHERE id > :lastId ORDER BY id`, then tails live. | CVY-009 |
| A7 | DEFERRED ↔ check-and-execute interaction ambiguous. | DEFERRED items gated app-side: on each dependency LANDED, re-evaluate; when `untilItem` is LANDED, item → SIMULATED. The onchain `check-and-execute` gate (P1) reads `committed[runId][idx]` as the condition — it is an **addition**, not a replacement. Cut order #3 removes the onchain gate, keeps the app-side gate. | CVY-008, CVY-013 |
| A8 | Two KeeperHub vocabularies. | REST/direct-exec + MCP `execute_contract_call` use `contractAddress/functionName/functionArgs/abi`. MCP **workflow** web3 nodes use `abiFunction`. Convoy uses **only** direct-exec — `abiFunction` never appears in Convoy code. | CVY-004 |
| A9 | "Orchestrator + state machine + BullMQ (16h)" bundles too much. | SPLIT into CVY-005 (DB/Prisma), CVY-006 (BullMQ queue+worker), CVY-008 (state machine+orchestrator). | Roadmap |
| A10 | CLI fallback flags: live docs show **no** `--simulate`, **no** `--value`; ABI flag is `--abi-file` not `--abi`. | Backup playbook uses only verified flags: `kh ex cc --chain --contract --method --args --wait`. Simulate has no CLI form → simulate only via REST. | KNOWN_GAPS G-05; playbook |
| A11 | Idempotency + synchronous exec = double-execute risk on client timeout. | Every write carries `Idempotency-Key: <runId>:<idx>:<attempt>`. On 409 `idempotency_in_progress` retry after backoff; on 409 `idempotency_conflict` treat as a bug (FAIL item). | CVY-004, CVY-015 |
| A12 | Vercel monorepo deploy risk; worker is long-lived. | One Vercel project, Root Directory `apps/web`, git integration only. Worker runs **off** Vercel (Railway/Fly/local for demo). | CVY-011, DEPLOYMENT.md |

**Pinned `payloadHash` (byte-for-byte):**
```
Solidity:  keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))
TypeScript (viem):
  keccak256(encodeAbiParameters(
    [{type:'address'},{type:'string'},{type:'bytes'},{type:'uint256'}],
    [target, functionName, encodedArgs, BigInt(idx)]
  ))
where encodedArgs = ABI-encoded argument tuple bytes (encodeAbiParameters over the
function's input types), NOT the 4-byte-selector calldata.
Fallback if dynamic-type packing drifts: hash the pieces —
  keccak256(abi.encode(target, keccak256(bytes(fn)), keccak256(args), idx)) both sides.
```
**Pinned gas→USDC:** `gas_used_usdc = (Number(gasUsedWei)/1e18) * runEthUsd`, `runEthUsd` written to `runs` at open (env `CONVOY_ETH_USD`).

---

### 1. Repository Structure

```
convoy/
├── package.json                      # root workspaces + scripts (build/test/lint/format)
├── pnpm-workspace.yaml               # apps/*, packages/*, services/*
├── pnpm-lock.yaml
├── turbo.json                        # optional; build depends on db:generate
├── tsconfig.base.json                # shared TS config
├── .nvmrc                            # 22
├── .env.example                      # every env var (see §11)
├── .gitignore
├── README.md                         # honesty table, tx links, MockDistributor disclaimer
├── vercel.json                       # framework preset, ignore-build-step
├── CLAUDE.md                         # AI entrypoint (see §3)
├── AGENTS.md                         # mirror of CLAUDE.md for cross-tool compatibility
│
├── .github/workflows/
│   ├── ci.yml                        # lint, typecheck, vitest, forge test, ablation harness
│   ├── contracts.yml                 # forge build/test/fmt --check + invariants
│   └── e2e.yml                       # Playwright on deployment_status == success
│
├── .convoy/                          # AI operating system (see §3)
│   ├── agents/                       # 5 role definitions
│   ├── instructions/                 # coding standards, repo conventions
│   ├── prompts/                      # milestone prompt templates
│   ├── playbooks/                    # recovery, release, demo
│   ├── checklists/                   # review, milestone-done, pre-submit
│   ├── templates/                    # worklog entry, milestone report, PR
│   ├── tasks/                        # CVY-XXX task cards
│   └── mcp/mcp.json                  # keeperhub remote MCP config
│
├── docs/
│   ├── ARCHITECTURE.md   IMPLEMENTATION_BLUEPRINT.md   WORKLOG.md
│   ├── IMPLEMENTATION_STATUS.md   KNOWN_GAPS.md   TESTING.md
│   ├── DEPLOYMENT.md   AI_WORKFLOW.md   DECISIONS.md
│
├── packages/
│   ├── contracts/                    # Foundry (solc 0.8.24)
│   │   ├── foundry.toml              # optimizer, [invariant], [etherscan]
│   │   ├── remappings.txt
│   │   ├── src/{ConvoyRegistry.sol, MockRewardDistributor.sol}
│   │   ├── test/{ConvoyRegistry.t.sol, ConvoyRegistry.invariant.t.sol, MockRewardDistributor.t.sol}
│   │   └── script/Deploy.s.sol       # deploy + verify Base / Base Sepolia
│   │
│   ├── db/                           # Prisma standalone package (@convoy/db)
│   │   ├── prisma/{schema.prisma, migrations/, seed.ts}
│   │   ├── src/index.ts              # PrismaClient singleton + exported types
│   │   └── package.json              # db:generate/migrate/deploy/seed
│   │
│   └── kh-client/                    # @convoy/kh-client — ONLY place that touches KeeperHub
│       ├── src/{client,contractCall,status,checkAndExecute,errors,idempotency,payloadHash,types,index}.ts
│       └── test/                     # vitest + VCR fixtures
│
├── apps/web/                         # Next.js 14 App Router (UI + API), @convoy/web
│   ├── next.config.mjs  tailwind.config.ts  vitest.config.ts
│   ├── app/
│   │   ├── layout.tsx                # left rail (Runs / New Run / Docs)
│   │   ├── page.tsx                  # Runs list
│   │   ├── runs/new/page.tsx         # submit batch
│   │   ├── runs/[id]/page.tsx        # 3 tabs
│   │   ├── runs/[id]/_components/{Timeline,DagView,Manifest,AuditDrawer,BudgetMeter}.tsx
│   │   └── api/
│   │       ├── runs/route.ts               # POST create+enqueue, GET list
│   │       ├── runs/[id]/route.ts          # GET run
│   │       ├── runs/[id]/stream/route.ts   # SSE (force-dynamic)
│   │       ├── runs/[id]/approve/route.ts  # P1 human gate
│   │       ├── runs/[id]/abort/route.ts    # cooperative abort
│   │       └── runs/[id]/manifest/route.ts # export
│   ├── lib/{registry.ts, planner/, critic/, manifest.ts, events.ts, budget.ts}
│   └── e2e/                          # Playwright specs
│
├── services/worker/                  # Node 22 BullMQ worker (off-Vercel), @convoy/worker
│   └── src/{index,queue,orchestrator,reconcile}.ts + handlers/{plan,critique,execute,seal}.ts
│
├── scripts/{bootstrap.sh, verify-env.ts, first-tx.ts, ablation.ts}
└── tests/fixtures/                   # 10-run Planner fixture, 5+5 Critic fixture, VCR tapes
```

### 2. Engineering Documentation

| Doc | Purpose | Owner | Cadence | Required sections |
|-----|---------|-------|---------|-------------------|
| `ARCHITECTURE.md` | Frozen architecture reference | Lead | Frozen | Stack, contracts, DB, state machine, agents, security, kill list |
| `IMPLEMENTATION_BLUEPRINT.md` | This handbook | Lead | On roadmap change | All 19 deliverables |
| `WORKLOG.md` | Append-only build diary | Coding agent | Every milestone | Dated entries (§14) |
| `IMPLEMENTATION_STATUS.md` | Live completion dashboard | Coding agent | Every milestone | Milestone table, %, next milestone |
| `KNOWN_GAPS.md` | Blockers / SDK gaps / debt | Coding agent | On friction | Gap ID, description, impact, fallback, status |
| `TESTING.md` | Test catalog | Coding agent | On tests added | Per-layer test names + commands |
| `DEPLOYMENT.md` | Deploy + rollback | Coding agent | On deploy change | Local, testnet, prod, rollback, env |
| `AI_WORKFLOW.md` | Milestone lifecycle + rules | Lead | Rare | Lifecycle, operating rules, tracking |
| `DECISIONS.md` | Numbered decision log | Coding agent | On any decision | `D-NNN date: decision, rationale` |

### 3. AI Workspace (.convoy/ + CLAUDE.md)

Per Anthropic's Claude Code guidance — *"Keep it concise: Claude reads the entire file every session. Aim for under 200 lines. Link to detailed docs instead of duplicating them"* (frontier models reliably follow only ~150–200 instructions and Claude Code's system prompt already uses ~50) — `CLAUDE.md` stays short and points to detailed docs.

**`CLAUDE.md` (repository root — actual content):**
```markdown
# CONVOY — Claude Code entrypoint
Convoy is an autonomous onchain release operator: plan a batch of interdependent onchain ops
(LLM Planner), critique each against a real KeeperHub simulation (LLM Critic), execute survivors
through KeeperHub's org Turnkey wallet, export a replayable manifest. Execution is the product.
Hackathon: KeeperHub Agents Onchain (submit before Aug 13 2026 12:00 UTC+2).

## Golden rules (never break)
1. Product + Architecture reports are FROZEN. Do not redesign, add features, optimize the
   protocol, or add alternatives. Friction → docs/KNOWN_GAPS.md.
2. Convoy holds NO private keys and implements NO relayer. Every chain write is a KeeperHub call.
3. Convoy NEVER sets a nonce. Onchain retries are KeeperHub's; Convoy only OBSERVES them.
4. NEVER stage a failure, inject a gas spike, or fake a retry/hash. Only structurally-real
   sources (real simulate-vetoes, real nonce serialization, real transient codes).
5. One milestone per session. Implement ONLY the highest unfinished CVY-XXX, then STOP.

## Start-of-session ritual
1. Read docs/WORKLOG.md (tail), docs/IMPLEMENTATION_STATUS.md, docs/KNOWN_GAPS.md.
2. Determine the highest unfinished milestone from IMPLEMENTATION_STATUS.md.
3. Open .convoy/tasks/<CVY-ID>.md and follow it exactly. Do not duplicate completed work.

## Commands (pnpm, Node 22, Foundry, Prisma, Next 14)
Install: pnpm install | DB client: pnpm --filter @convoy/db db:generate
DB migrate: pnpm --filter @convoy/db db:migrate | Build: pnpm -r build
Unit: pnpm -r test | Contracts: (cd packages/contracts && forge test) | Fmt: forge fmt --check
Lint: pnpm -r lint | Typecheck: pnpm -r typecheck
Web dev: pnpm --filter @convoy/web dev | Worker: pnpm --filter @convoy/worker dev
E2E: pnpm --filter @convoy/web exec playwright test
Ablation: pnpm tsx scripts/ablation.ts --ablate-planner|--ablate-critic

## KeeperHub facts (verified — do not invent capabilities)
- POST https://app.keeperhub.com/api/execute/contract-call ; Authorization: Bearer kh_...
  Body: { chainId:"8453", network:"8453", contractAddress, functionName,
          functionArgs:"[...]"(JSON-array string), abi?, value?, gasLimitMultiplier?, simulate? }
- Writes execute SYNCHRONOUSLY → 202 { executionId:"direct_...", status:"completed"|"failed" }.
- simulate:true (strict boolean) → 200 {wouldRevert:false,gasEstimate,...} or 400 {wouldRevert:true,revertReason:"Error(...)"}.
- GET /api/execute/{id}/status → {status,transactionHash,transactionLink,gasUsedWei}; honor X-Poll-Interval-Hint (0=terminal).
- Idempotency-Key: <runId>:<idx>:<attempt> (per-org, 24h; simulate exempt).
- Errors: 401 fatal, 403 daily-cap fatal-to-run, 422 wallet-not-configured fatal-to-run, 429 backoff+Retry-After.
  Coded run errors E-000x/N-000x/P-000x/C-0001-2 transient (retry observed). config-revert (full msg, no code) = item FAILED, no retry.
- Base=8453, Base Sepolia=84532. USDC Base=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
- call_workflow returns UNSIGNED calldata for cross-org writes — Convoy does NOT use it. Direct-exec only.
- Convoy uses REST vocabulary (contractAddress/functionName/functionArgs/abi). NEVER abiFunction.

## Invariants (verify every commit)
Repo builds; every milestone ends deployable; no partial features; no duplicated KH functionality;
no staged failures; Convoy never sets a nonce; Convoy never holds a key.

## Detailed docs (progressive disclosure)
Lifecycle & rules: docs/AI_WORKFLOW.md | Task cards: .convoy/tasks/CVY-*.md
Recovery: .convoy/playbooks/recovery.md | Tests: docs/TESTING.md | Deploy: docs/DEPLOYMENT.md
```

**`.convoy/agents/` roles** (each file: responsibilities, files owned, invariants preserved, "done" definition):
`lead-protocol-engineer.md` (ConvoyRegistry, invariants, deploy/verify) · `staff-architect.md` (state machine, orchestrator, kh-client boundary) · `tpm.md` (milestone order, gates, cut order, submission checklist) · `principal-blockchain.md` (viem reads, payloadHash parity, gas accounting) · `ai-engineering-lead.md` (Planner/Critic, schemas, evals, ablation).

**`.convoy/instructions/coding-standards.md` (excerpt, actual content):**
```markdown
- TypeScript strict. No `any` in exported signatures. Zod-validate all external input (LLM, KH, HTTP body).
- All KeeperHub access goes through packages/kh-client. No raw fetch to app.keeperhub.com elsewhere.
- State transitions are transactional (prisma.$transaction) and emit exactly one events row.
- Idempotent handlers keyed (runId, itemIdx, phase): reconcile-before-act; safe to re-run.
- viem chain pinned to base (8453) via a dedicated RPC. Never eth_getLogs on a public RPC.
- Money: numeric(20,6) in DB; bigint/string for wei; never float wei.
- Solidity 0.8.24, custom errors (no require strings), operator-bound access control.
- Conventional commits: feat/fix/test/docs/chore(scope): subject. One milestone per PR.
```

**`.convoy/prompts/milestone.md` (milestone prompt template, actual content):**
```markdown
# Milestone execution prompt
You are implementing ONE Convoy milestone. Do not exceed its scope.
LOAD FIRST: CLAUDE.md; docs/IMPLEMENTATION_STATUS.md (confirm highest unfinished);
.convoy/tasks/<CVY-ID>.md; docs/KNOWN_GAPS.md (respect blockers).
EXECUTE:
1. Restate objective + Definition of Done in one paragraph.
2. List exact files to create/modify (must match the task card).
3. Implement ONLY those files. Friction requiring an architecture change → STOP and record in
   docs/KNOWN_GAPS.md instead of redesigning.
4. Run in order: format → lint → typecheck → build → tests. Paste outputs. All must pass.
5. If KeeperHub touched: prove it (simulate JSON, or tx hash + Basescan link).
6. Commit (conventional). Update WORKLOG.md (append), IMPLEMENTATION_STATUS.md, DECISIONS.md if needed.
7. Generate milestone report (.convoy/templates/milestone-report.md).
8. STOP. Do not start the next milestone.
NEVER: redesign, add speculative features, fake a failure/hash, set a nonce, hold a key,
duplicate finished work, skip verification, or auto-continue.
```

**`.convoy/playbooks/recovery.md` (recovery playbook, actual content):**
```markdown
# Recovery after an interrupted AI session
1. git status; git log --oneline -15. Uncommitted work? Finish or `git stash`.
2. Read docs/WORKLOG.md tail (last completed milestone + notes).
3. Read docs/IMPLEMENTATION_STATUS.md — the live truth. Trust it over memory.
4. Health gate: pnpm install && pnpm --filter @convoy/db db:generate && pnpm -r build && pnpm -r test
   && (cd packages/contracts && forge test)
   - Green → clean milestone boundary; proceed to highest unfinished milestone.
   - Red → last milestone broke "repo always builds". Fix ONLY the break; no new scope.
     If it's a KH/SDK gap, record in KNOWN_GAPS and use the documented fallback.
5. Run stuck mid-execution (worker crash): run services/worker reconcile. For each item in SUBMITTED,
   GET /status by execution_id from `attempts`: completed+txHash → LANDED; failed → RETRYING/FAILED per
   rules; unknown & no execution_id → re-issue with the SAME Idempotency-Key runId:idx:attempt (dedupe protects).
6. Never re-broadcast without the original Idempotency-Key. Never invent a tx hash.
7. Update WORKLOG.md with what you recovered and how.
```

**`.convoy/checklists/review.md` (review checklist, actual content):**
```markdown
# Milestone review checklist (all YES)
- [ ] Scope = exactly one CVY milestone; no extra features.
- [ ] pnpm -r build passes; pnpm -r test passes; forge test passes (if contracts touched).
- [ ] forge fmt --check + lint + typecheck clean.
- [ ] No raw fetch to app.keeperhub.com outside packages/kh-client.
- [ ] Every state transition transactional and emits one events row.
- [ ] No nonce set anywhere; no key held anywhere; no staged failure anywhere.
- [ ] KH proof attached if integration touched (simulate JSON or tx hash + Basescan link).
- [ ] Architecture invariants intact (§16); kill-list items not resurrected (§17).
- [ ] WORKLOG appended; IMPLEMENTATION_STATUS updated; KNOWN_GAPS updated if friction.
- [ ] Demo scenario still runs (or explicitly N/A pre-CVY-010).
- [ ] Milestone report generated. Session STOPS here.
```

**`.convoy/mcp/mcp.json`:**
```json
{ "mcpServers": { "keeperhub": {
  "type": "http", "url": "https://app.keeperhub.com/mcp",
  "headers": { "Authorization": "Bearer ${KEEPERHUB_API_KEY}" } } } }
```
MCP is used for parity/discovery only (`list_action_schemas`, `get_wallet_integration`, `get_direct_execution_status`); all writes go through the REST kh-client. Verify with `/mcp` in Claude Code, then `get_wallet_integration` confirms the org wallet. Also ship `.convoy/templates/{worklog-entry,milestone-report,pr}.md`, `.convoy/checklists/{milestone-done,pre-submit}.md`, `.convoy/playbooks/{release,demo}.md`.

### 4. Milestone Roadmap (mapped to locked D1–D15 + two gates)

| ID | Objective | D-day | Gate | P |
|----|-----------|-------|------|---|
| CVY-000 | Repo bootstrap: monorepo, tooling, CLAUDE.md, docs skeleton | D1 | | P0 |
| CVY-001 | ConvoyRegistry + MockRewardDistributor + Foundry unit/invariant tests | D1 | | P0 |
| CVY-002 | payloadHash parity (Sol↔TS) + deploy script | D1–D2 | | P0 |
| CVY-003 | Deploy+verify ConvoyRegistry on Base; **FIRST REAL BASE TX (openRun)** | D2 | | P0 |
| CVY-004 | kh-client: write + simulate + status + errors + idempotency | D2–D3 | | P0 |
| CVY-005 | DB package: Prisma schema, migrations, seed | D4 | | P0 |
| CVY-006 | BullMQ queue + worker + idempotent handler skeleton | D4 | | P0 |
| CVY-007 | Budget meter + gas→USDC accounting | D4/D8 | | P0 |
| CVY-008 | Orchestrator + RUN/ITEM state machine (3-item RECEIVED→SEALED) | D4 | | P0 |
| CVY-GATE1 | **GATE 1**: end-to-end thin slice, a real tx landed via Convoy | D5 | ✅ | P0 |
| CVY-009 | SSE timeline UI + audit drawer + replay-on-refresh | D9 | | P0 |
| CVY-010 | Planner + zod schema + repair + 10-run eval (recall ≥0.9) | D6 | | P0 |
| CVY-011 | Critic + simulate-veto + corroboration (0 false vetoes) | D7 | | P0 |
| CVY-012 | Manifest exporter: 3-way reconcile + sha256 + export | D10 | | P0 |
| CVY-GATE2 | **GATE 2**: full 12-item run, manifest reconcile, DAG view | D10 | ✅ | P0/P1 |
| CVY-013 | DAG view (React Flow) + deferral + onchain check-and-execute gate | D8/D10 | | P1 |
| CVY-014 | Human approval gate | D8 | | P1 |
| CVY-015 | Idempotency + crash-resume + kill-worker test | D12 | | P0 |
| CVY-016 | Ablation harness + README honesty table | D11 | | P0 |
| CVY-017 | x402 payment leg (or cut per cut-order #1) | D13 | | P1 |
| CVY-018 | Telegram notifications (P2, if time) | D13 | | P2 |
| CVY-019 | Playwright demo E2E + 4 backup paths + record video + SUBMIT | D14–D15 | | P0 |

### 5. Task Breakdown

Format: **Objective · Deliverables · Tasks · Deps · Complexity · Risk · Fallback · Effort · DoD.**

**CVY-000 — Repo bootstrap.** Monorepo scaffold that builds empty and runs all tooling. Deliverables: `pnpm-workspace.yaml`, root scripts, `tsconfig.base`, `.nvmrc(22)`, `.env.example`, `CLAUDE.md`, `.convoy/*`, docs skeleton, CI stub. Deps: none. S / low. Fallback: drop turbo, use `pnpm -r`. **3h.** DoD: `pnpm install && pnpm -r build` succeeds on empty packages; CLAUDE.md present.

**CVY-001 — Contracts + tests.** ConvoyRegistry + MockRewardDistributor with green unit + invariant tests. Implement enum/struct/mappings/events/errors/functions exactly as frozen; unit tests for happy+revert paths; invariants (open→commit→seal ordering; no commit before open; no double-seal; idx monotonic) via `StdInvariant` handler. Deps: 000. M / low. **6h.** DoD: `forge test` all pass; `forge fmt --check` clean; invariants pass at runs=1000 depth=32.

**CVY-002 — payloadHash parity + deploy script.** Byte-identical payloadHash Sol↔TS; deploy script ready. Parity test asserts TS==Sol on ≥10 fixtures (fixtures dumped by a forge script). Deps: 001. M / **med** (dynamic-type packing). Fallback: hash-the-pieces variant (above), record in DECISIONS. **3h.** DoD: parity test green.

**CVY-003 — Deploy + verify + FIRST REAL BASE TX.** ConvoyRegistry deployed+verified on Base 8453; `openRun` landed; hash on Basescan. `forge script Deploy --rpc-url base --broadcast --verify --chain base`; run `first-tx.ts` openRun via kh-client; capture txHash + transactionLink. Deps: 002, 004(minimal write). M / **HIGH** (submission requirement). Fallback: de-risk on Base Sepolia 84532 first; if KH write blocked, land openRun via `kh ex cc --wait`. **4h.** DoD: verified contract on Basescan; one real openRun tx recorded in README honesty table.

**CVY-004 — kh-client.** Single typed client for all KeeperHub direct execution (write+simulate, status poll, checkAndExecute, errors classifier, idempotency, types; vitest + VCR). Send `chainId`+`network`; `functionArgs` as JSON-array string; simulate returns typed `{wouldRevert,revertReason,gasEstimate}`; status honors `X-Poll-Interval-Hint` and short-circuits on terminal POST; classify 401/403/422/429 + coded run errors; own-fault retry (LLM/DB/network) with jittered backoff; **never** retry config-revert. Deps: 000. L / **HIGH** (external drift → A1/A2/A3). Fallback: log rejected fields to KNOWN_GAPS; VCR mode unblocks UI dev. **10h.** DoD: simulate returns wouldRevert for fund-before-setRoot; write returns executionId; status returns txHash; tests green.

**CVY-005 — DB package.** Locked Prisma schema (runs/items/attempts/events/manifests exactly as frozen; `Bytes` for bytea, `Decimal` for numeric) + migration + seed (3-item + 12-item). Deps: 000. M / med (Decimal/Bytes mapping). **5h.** DoD: `db:migrate` clean; `db:seed` inserts fixtures; client imports in web+worker.

**CVY-006 — BullMQ queue + worker.** One queue, worker bootstrap, idempotent handler skeleton keyed (runId,itemIdx,phase), graceful shutdown. IORedis `maxRetriesPerRequest:null`; concurrency 1 per run (serialize per org wallet); `jobId = runId:phase:itemIdx` for dedupe; `SIGTERM → worker.close()`; AbortSignal for cooperative abort. Per BullMQ docs, `close()` *"will mark the worker as closing so it will not pick up new jobs, and at the same time it will wait for all the current jobs to be processed (or failed)"* (note: stalled jobs are re-picked after ~30s by default). Deps: 005. M / med. Fallback: in-process single-consumer if Redis unavailable in demo. **6h.** DoD: enqueue→handler→complete; SIGTERM drains; duplicate jobId does not double-run.

**CVY-007 — Budget meter + gas accounting.** USDC meter draining from real gas + pay spend. Pinned formula (A5), `runEthUsd` at open, BUDGET_LOW at 20%, over_budget veto, SKIPPED on exhaustion. Deps: 004, 005. S / low. Fallback: gas-only budget (cut #1). **5h.** DoD: meter drains on real gas; amber@20%; run ends early with SKIPPED items.

**CVY-008 — Orchestrator + state machine.** RUN/ITEM state machine driving a 3-item hardcoded batch RECEIVED→SEALED. Phases OPENING/PLANNING/CRITIQUING/EXECUTING/SEALING with guards (COMMITTED requires SIMULATED+APPROVE; SUBMITTED→LANDED requires completed+txHash; RETRYING only on a transient code, capped→FAILED); openRun→commit→seal via kh-client+registry; app-side deferral gate (A7). Deps: 004,005,006,007. L / **HIGH** (core). Fallback: hardcode plan until CVY-010. **12h.** DoD: 3-item batch runs RECEIVED→SEALED_OK with real hashes; all transitions emit events.

**CVY-GATE1.** Prove a real tx lands end-to-end through Convoy. DoD: submit 3-item batch → openRun + ≥1 item LANDED on Base with Basescan link. **If no real tx landed: STOP features, fix executor, cut x402 + DAG view.**

**CVY-009 — SSE timeline + audit drawer.** Live timeline via SSE, survives refresh via DB replay. `stream/route.ts` uses a `ReadableStream` with `export const dynamic = "force-dynamic"` and the `X-Accel-Buffering: no` header (per Next.js streaming docs — *"Nginx and similar reverse proxies buffer responses by default. Disable buffering by setting the X-Accel-Buffering header to no"*). SSE event id = `events.id`; on connect replay `id > Last-Event-ID` then tail; render state/retry/gas chips; audit drawer shows planner reason, critic verdict+simulate, attempts+txlink, registry event. Deps: 005,008. M / med. Fallback: 2s polling of GET /runs/:id. **10h.** DoD: events stream live; refresh mid-run replays full history; drawer shows all fields.

**CVY-010 — Planner.** Strict-JSON plan; dependency recall ≥0.9. zod schema `{order, deferrals:[{idx,untilItem}], gasBudgetPerItem, rationalePerItem}` via structured outputs + zod (reject+repair on parse fail); whitelist targets; evidence as delimited untrusted data; cycle check. Deps: 008. L / med. Fallback: deterministic topological order from `depends_on`. **10h.** DoD: ≥95% valid-JSON first pass; recall ≥0.9; zero cycles.

**CVY-011 — Critic.** Per-action APPROVE/VETO corroborated by simulate: `VETO(would_revert)` requires `simulate.wouldRevert=true`; the simulator overrides on disagreement; a Critic APPROVE on an action the simulator says would revert is overridden to VETO; one re-plan cycle then FAILED. Veto reasons enum; unknown target → VETO evidence_mismatch. Deps: 004,010. L / med. Fallback: simulator-only gate (Critic advisory). **10h.** DoD: veto ≥4/5 invalid, pass 5/5 valid, **zero false vetoes**.

**CVY-012 — Manifest exporter.** 3-way reconcile (KeeperHub status ↔ ConvoyRegistry events via viem read ↔ Convoy ledger) + sha256 + export. Deps: 008,009. M / med. Fallback: 2-way (KH + ledger), disclosed (cut #5). **8h.** DoD: all-green reconcile on a completed run; exported JSON hash stable.

**CVY-GATE2.** DoD: full 12-item run; manifest 3-way reconcile; DAG view. **If unstable: cut to 2-way + list view; freeze P1.**

**CVY-013 — DAG + deferral + onchain gate.** React Flow DAG colored by state; deferred edges dashed; optional `check-and-execute` reading registry `committed[runId][idx]`. Deps: 009,012. M / med. Fallback: ordered list + dependency badges (cut #2); app-side gate reading registry via RPC (cut #3). **8h+6h.** DoD: DAG renders live; deferred item releases on dependency LANDED.

**CVY-014 — Human approval gate.** POST /approve pauses before EXECUTING. Deps: 008. S / low. Fallback: auto (cut #4). **3h.** DoD: run pauses; approve resumes.

**CVY-015 — Idempotency + crash-resume.** Kill worker mid-execute; resume with no duplicate tx. `reconcile.ts` (recovery playbook) + kill-worker test. Deps: 006,008. L / **HIGH** (reliability weighted in judging). Fallback: **none — never cut.** **6h.** DoD: SIGKILL during EXECUTE → resume → same execution_id/txHash, no double broadcast.

**CVY-016 — Ablation + honesty table.** `--ablate-planner`/`--ablate-critic` print degradation; README honesty table maps each claim to an artifact. Deps: 010,011,012. M / low. **5h.** DoD: ablate-planner drops landed rate 100%→~55% + wasted gas>0; ablate-critic wasted-gas 0→2 + one starved dependent; table complete.

**CVY-017 — x402 payment leg.** One paid-workflow leg via `@keeperhub/wallet` bounded by server-side Turnkey caps. Deps: 004,007. M / med (**unverified SDK surface** → G-06). Fallback: **CUT to gas-only** (cut #1). **6h.** DoD: one real x402 payment with server-cap enforcement, or documented cut.

**CVY-018 — Telegram (P2).** Run-sealed notification. **2h.** Fallback: omit.

**CVY-019 — Demo E2E + submit.** Playwright of the exact 3:00 demo daily; all 4 backup paths tested; ≤3min video; SUBMIT EARLY. Deps: all P0. M / **HIGH** (deadline). Fallback: pre-recorded morning run with real Basescan hashes. **D14–D15.** DoD: green E2E; video; README with tx links; BUIDL submitted before Aug 13 12:00 UTC+2.

### 6. Dependency Graph

```
CVY-000 (bootstrap)
   ├─► CVY-001 (contracts) ─► CVY-002 (payloadHash+deploy) ─► CVY-003 (FIRST TX)
   ├─► CVY-004 (kh-client) ───────────────────────────────┘ (needed by 003)
   ├─► CVY-005 (db) ─► CVY-006 (bullmq) ┐
   └─► CVY-007 (budget) ────────────────┤
                                        ├─► CVY-008 (orchestrator/state machine)
   CVY-003, CVY-004 ────────────────────┘         │
                                                   ├─► CVY-GATE1
                                                   ├─► CVY-009 (SSE UI)
                                                   ├─► CVY-010 (Planner) ─► CVY-011 (Critic)
                                                   ├─► CVY-012 (manifest) ─► CVY-GATE2
                                                   ├─► CVY-013 (DAG/gate) [parallel]
                                                   ├─► CVY-014 (approval)
                                                   └─► CVY-015 (crash-resume)
   CVY-010+011+012 ─► CVY-016 (ablation)   ;   CVY-004+007 ─► CVY-017 (x402)   ;   CVY-008 ─► CVY-018
   all P0 ─► CVY-019 (demo+submit)
```

| Layer | Milestones | Note |
|-------|-----------|------|
| Foundation | 000, 001, 004, 005 | must precede everything |
| Critical path | 002→003→(004)→008→GATE1→012→GATE2→015→019 | the spine; first tx front-loaded to D2 |
| Parallel after 008 | 009 / 010→011 / 013 / 014 | UI vs agents vs P1 |
| Blocking | 003 blocks submission; 008 blocks all run behavior; 015 blocks reliability story |
| Unlocks | 004 unlocks 003 & 008; 008 unlocks 009/010/012/013/014/015 |

### 7. Engineering Execution Order (dependency-driven, with justification)

1. **CVY-000** — nothing builds without the workspace.
2. **CVY-001** — contracts are the genuine-revert source the Critic simulates against; the builder's strongest area, so de-risk early.
3. **CVY-004** (parallel with 002) — kh-client is needed to land the first tx and by the orchestrator; highest external risk, surface drift first.
4. **CVY-002** — payloadHash parity gates `commitAction` correctness and deploy.
5. **CVY-003** — **front-load the first real Base tx to Day 2**; provisionally satisfies the submission requirement and validates the whole KH path before feature work.
6. **CVY-005 → 006 → 007** — persistence, then queue, then budget: each a dependency of the orchestrator.
7. **CVY-008** — the state machine ties contracts+client+db+queue+budget together.
8. **CVY-GATE1** — hard checkpoint; if no real tx lands, stop and fix the executor (cut x402+DAG).
9. **CVY-009 / 010→011 / 013 / 014** — parallel tracks once the spine works.
10. **CVY-012 → GATE2** — manifest is the audit artifact; gate on a full 12-item run.
11. **CVY-015** — crash-resume; reliability is weighted heavily in judging.
12. **CVY-016** — ablation proves the Planner/Critic earn their place.
13. **CVY-017 / 018** — P1/P2, cut first if time slips.
14. **CVY-019** — demo, backups, submit early.

### 8. Acceptance Criteria (per milestone)

Every milestone satisfies: **Build succeeds · Tests pass · Architecture preserved · KH integration verified (if touched) · State machine preserved · Deployment verified (if deploy) · Demo scenario still functional.**

| Milestone | Build | Tests | KH verified | State machine | Deploy | Demo intact |
|-----------|-------|-------|-------------|---------------|--------|-------------|
| 000 | ✔ empty | vitest stub | n/a | n/a | n/a | n/a |
| 001 | ✔ | forge unit+invariant | n/a | n/a | n/a | n/a |
| 002 | ✔ | parity test | n/a | n/a | script compiles | n/a |
| 003 | ✔ | first-tx smoke | ✔ real tx+Basescan | openRun | ✔ verified Base | first tx visible |
| 004 | ✔ | vitest VCR | ✔ simulate+write+status | n/a | n/a | n/a |
| 005 | ✔ | migrate+seed | n/a | schema matches | n/a | n/a |
| 006 | ✔ | job dedupe | n/a | n/a | n/a | n/a |
| 007 | ✔ | budget unit | ✔ real gasUsedWei | budget guards | n/a | meter drains |
| 008 | ✔ | 3-item E2E | ✔ commit/seal | full RUN/ITEM | n/a | RECEIVED→SEALED |
| GATE1 | ✔ | thin-slice E2E | ✔ tx lands | ✔ | ✔ | ✔ |
| 009 | ✔ | SSE replay | n/a | events emitted | n/a | timeline live |
| 010 | ✔ | recall eval | n/a | PLANNING | n/a | plan+DAG |
| 011 | ✔ | 5+5 veto eval | ✔ simulate corrob | CRITIQUING | n/a | 2 vetoes |
| 012 | ✔ | reconcile | ✔ status join | SEALING | n/a | manifest all-green |
| GATE2 | ✔ | 12-item E2E | ✔ | ✔ | ✔ | full demo |
| 013 | ✔ | DAG render | ✔ check-and-execute | DEFERRED | n/a | DAG+deferral |
| 014 | ✔ | approve | n/a | approval gate | n/a | pause/resume |
| 015 | ✔ | kill-worker | ✔ no dup tx | resume | n/a | retry chip real |
| 016 | ✔ | ablation metrics | n/a | n/a | n/a | ablation punchline |
| 017 | ✔ | x402 | ✔ real payment | pay budget | n/a | pay leg or cut |
| 019 | ✔ | Playwright green | ✔ all paths | ✔ | ✔ prod | ✔ ≤3min |

### 9. Testing Strategy (concrete names + commands)

| Layer | Test name(s) | Command |
|-------|-------------|---------|
| Contract unit | `test_openRun_setsOpen`, `test_commitAction_revertsNotOpen`, `test_commitAction_revertsDupIndex`, `test_sealRun_revertsNothingCommitted`, `test_commitAction_revertsNotOperator` | `cd packages/contracts && forge test` |
| Invariant | `invariant_noCommitBeforeOpen`, `invariant_noDoubleSeal`, `invariant_idxMonotonic`, `invariant_committedCountMatches` | `forge test --match-path test/*.invariant.t.sol` |
| Contract fmt/build | — | `forge fmt --check && forge build` |
| payloadHash parity | `payloadHash.parity.test.ts` | `pnpm --filter @convoy/kh-client test` |
| kh-client (VCR) | `contractCall.simulate.wouldRevert.test.ts`, `contractCall.write.executionId.test.ts`, `status.pollHint.test.ts`, `errors.classify.test.ts`, `idempotency.key.test.ts` | `pnpm --filter @convoy/kh-client test` |
| DB | `schema.migrate.test.ts`, `seed.fixtures.test.ts` | `pnpm --filter @convoy/db test` |
| Queue | `queue.dedupeJobId.test.ts`, `worker.gracefulShutdown.test.ts` | `pnpm --filter @convoy/worker test` |
| State machine | `orchestrator.3item.e2e.test.ts`, `guards.committedRequiresApprove.test.ts`, `guards.landedRequiresTxHash.test.ts` | `pnpm --filter @convoy/worker test` |
| Planner eval | `planner.recall.eval.ts` (≥0.9), `planner.validJson.eval.ts` (≥95%) | `pnpm tsx tests/planner.recall.eval.ts` |
| Critic eval | `critic.veto.eval.ts` (≥4/5 invalid, 5/5 valid, 0 false) | `pnpm tsx tests/critic.veto.eval.ts` |
| Simulation | `critic.corroboration.test.ts` (APPROVE overridden to VETO) | vitest |
| Retry | `retry.transientOnly.test.ts` (retries E-0002/N-0001, never config-revert) | vitest |
| Failure recovery | `reconcile.crashResume.test.ts`, `killworker.noDuplicateTx.test.ts` | `pnpm --filter @convoy/worker test` |
| API | `api.runs.create.test.ts`, `api.stream.replay.test.ts`, `api.manifest.export.test.ts` | `pnpm --filter @convoy/web test` |
| Frontend | `timeline.render.test.tsx`, `budgetMeter.amber.test.tsx` | vitest |
| E2E | `demo.spec.ts` (exact 3:00 run), `refresh.replay.spec.ts` | `pnpm --filter @convoy/web exec playwright test` |
| Regression | full `pnpm -r test && forge test` in CI on every PR | `.github/workflows/ci.yml` |
| Deploy verify | `scripts/verify-env.ts` PASS/FAIL matrix; Basescan verified check | `pnpm tsx scripts/verify-env.ts` |
| Demo validation | daily Playwright `demo.spec.ts` (week 3) | scheduled CI |

Integration modes: **live** (Base Sepolia against real KeeperHub) and **VCR** (recorded fixtures for offline UI dev), toggled by `CONVOY_KH_MODE=live|vcr`.

### 10. Deployment Strategy

| Stage | Action |
|-------|--------|
| Local dev | `pnpm install`; local Postgres + Redis; `db:migrate`; `pnpm --filter @convoy/web dev` + `pnpm --filter @convoy/worker dev`. |
| Env verification | `pnpm tsx scripts/verify-env.ts` → PASS/FAIL matrix (§11). |
| Dependency validation | `pnpm -r build`; `forge build`; `db:generate`. |
| Testnet deploy | `forge script Deploy --rpc-url base-sepolia --broadcast --verify --chain base-sepolia` (84532); first-tx on Sepolia via kh-client. |
| KeeperHub verification | `/mcp` OAuth or Bearer; `get_wallet_integration` confirms org wallet; one simulate + one write; confirm txLink. |
| Smoke tests | `scripts/first-tx.ts`; `demo.spec.ts` against preview URL. |
| Release candidate | tag; full CI + Playwright; freeze P1 if GATE2 unstable. |
| Mainnet deploy | `forge script Deploy --rpc-url base --broadcast --verify --chain base` (8453); record verified address. Basescan verification uses the single Etherscan V2 key (legacy per-chain keys are no longer accepted — *"As of August 15th, 2025, the legacy Etherscan API V1 endpoints have been deprecated in favor of the new Etherscan API V2, which introduces a unified multichain experience"*). |
| Web deploy | **Vercel git integration only** (never CLI). One project, Root Directory `apps/web`, env in dashboard; push to `main` triggers prod. |
| Worker deploy | Off Vercel (Vercel can't host long-lived workers): a small always-on host (Railway/Fly/local for demo). Documented in DEPLOYMENT.md. |
| Rollback | Contracts immutable → deploy a fresh instance, update `CONVOY_REGISTRY_ADDR`; never migrate state. Web → Vercel "Promote previous deployment". DB → forward-only migrations; keep a pre-demo snapshot. |
| Final demo deploy | Deploy morning-of; run a real morning batch whose hashes are on Basescan (backup path a); freeze env. |

### 11. Bootstrap & Environment Setup

**`scripts/bootstrap.sh`:**
```bash
#!/usr/bin/env bash
set -euo pipefail
# CONVOY fresh-environment bootstrap (WSL2/Ubuntu, Node 22)
node -v | grep -q "v22" || { echo "Node 22 required (nvm install 22)"; exit 1; }
corepack enable && corepack prepare pnpm@latest --activate
command -v forge >/dev/null || { curl -L https://foundry.paradigm.xyz | bash && foundryup; }
[ -f .env ] || { cp .env.example .env; echo "Fill .env, then re-run"; exit 1; }
pnpm install
( cd packages/contracts && forge install && forge build && forge test )
pnpm --filter @convoy/db db:generate
pnpm --filter @convoy/db db:migrate
pnpm --filter @convoy/db db:seed
pnpm -r build
pnpm -r test
pnpm tsx scripts/verify-env.ts
echo "Bootstrap complete. Next: pnpm tsx scripts/first-tx.ts (land the first Base tx)."
```

**Environment variables:**

| Var | Purpose | Example |
|-----|---------|---------|
| `NODE_ENV` | runtime mode | `development` |
| `DATABASE_URL` | Postgres (Prisma) | `postgresql://convoy:convoy@localhost:5432/convoy` |
| `REDIS_URL` | BullMQ connection | `redis://localhost:6379` |
| `KEEPERHUB_API_KEY` | org key `kh_` for REST + MCP | `kh_live_xxx` |
| `KEEPERHUB_BASE_URL` | KH API base | `https://app.keeperhub.com` |
| `CONVOY_KH_MODE` | live vs recorded fixtures | `live` / `vcr` |
| `BASE_RPC_URL` | dedicated RPC, chain pinned 8453 | `https://base-mainnet.g.alchemy.com/v2/xxx` |
| `BASE_RPC_URL_FALLBACK` | hot-swappable second provider | `https://…` |
| `BASE_SEPOLIA_RPC_URL` | testnet RPC | `https://base-sepolia…` |
| `CONVOY_REGISTRY_ADDR` | deployed ConvoyRegistry | `0x…` |
| `MOCK_DISTRIBUTOR_ADDR` | demo distributor | `0x…` |
| `ETHERSCAN_API_KEY` | Etherscan V2 single key (Basescan) | `XXXX` |
| `OPENAI_API_KEY` | Planner/Critic LLM | `sk-…` |
| `CONVOY_ETH_USD` | frozen ETH price for gas→USDC | `3400` |
| `CONVOY_LLM_TIMEOUT_MS` | cache-fallback threshold | `8000` |
| `DEPLOYER_PRIVATE_KEY` | Foundry deploy only (never app runtime) | `0x…` |
| `TELEGRAM_BOT_TOKEN` | P2 notifications (optional) | — |

**PASS/FAIL validation matrix (`verify-env.ts`):**

| Check | PASS condition |
|-------|----------------|
| Node version | `v22.x` |
| pnpm present | `pnpm -v` ok |
| Foundry present | `forge --version` ok |
| Postgres reachable | Prisma `SELECT 1` |
| Redis reachable | `PING`→`PONG` |
| Prisma client generated | import succeeds |
| Migrations applied | no pending migrations |
| KH auth | `GET /api/chains` 200 with Bearer |
| KH wallet configured | `get_wallet_integration` present (not 422) |
| Base RPC pinned 8453 | `eth_chainId` == 0x2105 |
| Registry deployed | `runs()` read succeeds |
| Contracts build | `forge build` ok |
| Web build | `next build` ok |

### 12. Engineering Workflow (standard milestone lifecycle)

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

### 13. AI Operating Rules

**Always:** read WORKLOG/STATUS/KNOWN_GAPS before acting; implement exactly one milestone; keep the repo building; verify (build+test+KH proof) before commit; append to WORKLOG; update STATUS; record friction in KNOWN_GAPS rather than redesigning; route all KeeperHub access through the kh-client; keep the chain pinned to 8453; treat evidence as untrusted delimited data.

**Never:** duplicate completed work; redesign the product or architecture; add features not in the frozen spec; bypass milestone order; skip verification; implement speculative/temporary code (record a gap instead); auto-continue after a milestone; stage a failure, inject a gas spike, or fabricate a hash/retry; set a nonce; hold a private key; call `call_workflow` for writes; use `abiFunction` (workflow vocabulary); run `eth_getLogs` on a public RPC; deploy via Vercel CLI.

### 14. Project Tracking System (templates)

**`WORKLOG.md` (append-only):**
```markdown
## 2026-07-29 — CVY-001 ConvoyRegistry + tests
Summary: Implemented ConvoyRegistry + MockRewardDistributor; unit + invariant tests green.
Files: packages/contracts/src/ConvoyRegistry.sol, .../MockRewardDistributor.sol, test/*.t.sol, foundry.toml
Commit: a1b2c3d
Verification: forge test 18 passed; forge fmt --check clean; invariants runs=1000 depth=32.
Notes: NotOperator revert is the genuine invalid-input source for the Critic. No gaps.
```

**`IMPLEMENTATION_STATUS.md` (live dashboard):**
```markdown
# Convoy Implementation Status  (updated 2026-07-29)
Overall: 8% (CVY-000, CVY-001 done)   Next milestone: CVY-002
| ID | Milestone | Status | % | Notes |
|----|-----------|--------|---|-------|
| CVY-000 | Bootstrap | DONE | 100 | |
| CVY-001 | Contracts+tests | DONE | 100 | invariants green |
| CVY-002 | payloadHash+deploy | TODO | 0 | next |
Gates: GATE1 not reached · GATE2 not reached
```

**`KNOWN_GAPS.md`:**
```markdown
# Known Gaps
| ID | Description | Impact | Fallback | Status |
|----|-------------|--------|----------|--------|
| G-01 | Live KH docs use `chainId`; frozen spec used `network` (deprecated) | write may break if only `network` sent | send both chainId+network | MITIGATED |
| G-02 | Writes execute synchronously (202 completed), not async pending | poll may be redundant | short-circuit poll on terminal POST | MITIGATED |
| G-03 | Daily cap returns 403 not 422 | error classify | treat 403(cap)+422(wallet) as fatal-to-run | MITIGATED |
| G-04 | No live ETH price oracle (would be load-bearing) | gas→USDC approx | freeze CONVOY_ETH_USD per run | ACCEPTED |
| G-05 | CLI has no --simulate/--value; ABI flag is --abi-file | backup path limited | simulate only via REST; CLI for writes | ACCEPTED |
| G-06 | @keeperhub/wallet x402 surface unverified in available docs | x402 leg risk | cut to gas-only budget (cut #1) | OPEN |
```

### 15. Architecture Traceability

| Milestone | Architecture sections | Components affected | Invariants preserved |
|-----------|----------------------|---------------------|----------------------|
| 001 | Smart contracts | contracts | genuine reverts; operator binding; one-shot committed |
| 002 | payloadHash spec; commit binding | contracts, kh-client | Sol↔TS parity; DupIndex |
| 003 | Roadmap D2 first tx; submission | contracts, kh-client | Convoy triggers own exec; no key held |
| 004 | KH API shapes; error state machine; idempotency | kh-client | no relayer; nonces delegated; simulate-before-spend |
| 005 | DB schema (locked) | db | append-only events; ledger of record |
| 006 | Backend (BullMQ, idempotent handlers) | worker | idempotency key; own-fault retry only |
| 007 | Budget meter; gas allocation | web, worker | over_budget veto; run ends early |
| 008 | Execution state machine; event model | worker | all guards; transactional transitions |
| 009 | Frontend timeline; SSE+replay | web | replay-on-refresh; audit trail |
| 010 | Planner; whitelist, schema-validate | web/lib | never execute raw; no cycles |
| 011 | Critic; simulate corroboration; tiebreak | web/lib | simulator overrides; 0 false vetoes |
| 012 | Manifest 3-way reconcile; sha256 | web, worker | audit artifact; honesty |
| 013 | DAG view; check-and-execute gate | web, worker | deferral correctness; registry-read gate |
| 014 | Human approval gate (P1) | web, worker | cooperative pause |
| 015 | Idempotency; crash-resume | worker | no duplicate tx; nonce never set |
| 016 | Ablation harness; honesty table | scripts, README | claims map to artifacts |
| 017 | x402 payment leg; wallet caps | kh-client, web | server-side Turnkey caps |
| 019 | Demo; backup paths | web, e2e | never fake a hash |

### 16. Engineering Invariants (mechanically verified)

| Invariant | Verification |
|-----------|--------------|
| Repo always builds | CI `pnpm -r build && forge build` on every PR; recovery gate |
| Every milestone ends deployable | GATE checks; `next build` + worker start in CI |
| No partial features | milestone DoD requires full feature or documented cut; lint rule bans `// TODO(impl)` in exports |
| No duplicated KeeperHub functionality | CI grep-guard: no `app.keeperhub.com` fetch outside packages/kh-client |
| Every execution path testable | each phase handler has a vitest; coverage gate on worker |
| Every commit improves the working system | conventional commit + green CI required to merge |
| No staged failures anywhere | CI grep-guard bans `mockRevert`, fake tx-hash literals, `throw new Error("fake…` in non-test code |
| Convoy never sets a nonce | grep-guard: no `nonce:` in kh-client/worker payloads; review checklist |
| Convoy never holds a private key | grep-guard: `PRIVATE_KEY` referenced only in packages/contracts/script; runtime ban |

### 17. Architecture Kill List

| Excluded idea | Why removed | Complexity avoided | Demo value sacrificed | Could return |
|---------------|-------------|--------------------|-----------------------|--------------|
| KH Workflow Builder graphs per run | Convoy owns direct execution; graphs add an unsigned-calldata path | workflow CRUD, node/edge modeling | little | post-hackathon multi-tenant |
| Safe/multisig execution | simulate `from` is EOA not Safe (docs limitation); adds signing complexity | Safe routing, threshold sigs | modest | targeting DAO treasuries |
| Cross-chain / CCIP | single-chain (Base) keeps the reliability story tight | bridge steps, fee quoting | low | multi-chain epochs |
| MPP / Tempo second rail | one rail (x402) shows payments | second payment integration | low | broader payment demo |
| Protocol plugins (Aave/Spark) | Convoy is protocol-agnostic | plugin schemas | low | vertical templates |
| Marketplace listing of Convoy | out of scope for execution story | listing/x402 seller flow | low | productization |
| Multi-tenant auth/orgs | single-tenant demo auth suffices | auth, org scoping | none | SaaS |
| Gas-sponsorship reliance | source-conflicted, void on private routes | sponsorship plumbing | none (org wallet funded) | never load-bearing |
| Self-built relayer / nonce manager | violates invariant; KH owns nonces | nonce mgmt, mempool | none | never |
| ML dependency extractor | LLM Planner + labeled fixture suffice | training pipeline | low | scale-up |

### 18. Milestone Backlog (operational guide)

Each `.convoy/tasks/CVY-XXX.md` gives Objective · Files expected · Dependencies · Acceptance criteria · Verification steps · Rollback · Effort · Deliverables. Example — **`.convoy/tasks/CVY-004.md`:**
```markdown
# CVY-004 — kh-client (KeeperHub REST direct execution)
Objective: Single typed client for all KeeperHub writes/simulate/status.
Files: packages/kh-client/src/{client,contractCall,status,checkAndExecute,errors,idempotency,payloadHash,types,index}.ts + test/*
Depends: CVY-000. Blocks: CVY-003, CVY-008.
Acceptance:
- simulate(fund before setRoot) → { wouldRevert:true, revertReason:"Error(...)" }
- write → { executionId:"direct_...", status } ; sends chainId+network+functionArgs(JSON string)
- status honors X-Poll-Interval-Hint; short-circuits on terminal POST
- errors: 401 fatal; 403 cap + 422 wallet fatal-to-run; 429 backoff; E/N/P transient; config-revert FAILED-no-retry
- Idempotency-Key runId:idx:attempt on every write; simulate exempt
Verification: pnpm --filter @convoy/kh-client test ; live smoke against Base Sepolia
Rollback: revert package; VCR mode keeps UI dev unblocked
Effort: 10h
Deliverables: typed client + tests + README (vocabulary note: never abiFunction/call_workflow)
```
Generate one such card per CVY-XXX before implementation.

### 19. Final Readiness Checklist

| Dimension | Ready when |
|-----------|-----------|
| Repository structure complete | tree in §1 exists; empty builds pass |
| Milestones logically ordered | §7 order followed; first tx front-loaded to D2 |
| Dependencies validated | §6 graph acyclic; foundation before spine |
| Architecture preserved | §16 invariants green; §15 traceability filled |
| KeeperHub integration accounted for | kh-client verified; simulate+write+status proven; MCP parity checked |
| AI responsibilities preserved | CLAUDE.md + AI_WORKFLOW.md + task cards present; one-milestone rule enforced |
| Testing complete | §9 suites green; ablation prints degradation; crash-resume no-dup-tx |
| Deployment strategy complete | Vercel git-only; worker off-Vercel; contracts verified; rollback defined |
| Documentation complete | all §2 docs present and current |
| Solo-buildable | effort sums within 2.5–3 weeks; cut order defined |
| Demo-ready | Playwright `demo.spec` green; 4 backup paths tested; ≤3min video |
| Hackathon-ready | GitHub source + demo video + real KeeperHub tx link; submitted before Aug 13 12:00 UTC+2 |

**Submission requirements (hard):** (1) public GitHub source; (2) short demo video showing the agent executing onchain **through KeeperHub**; (3) a link to a **transaction the agent executed via KeeperHub** (Basescan). Incomplete submissions cannot be judged — submit early (D15), keep buffer D16–D17 for the Onboarding-UX bounty PR.

---

## Recommendations

1. **Start now with CVY-000 → CVY-001 → CVY-004 in the first 48 hours, and treat CVY-003 (first real Base tx) as a hard Day-2 deadline.** The single biggest risk to a hackathon that "weights execution heavily" is discovering on Day 10 that the KeeperHub write path doesn't work. Landing one real `openRun` tx on Day 2 collapses that risk and provisionally satisfies the submission requirement. **Threshold that changes the plan:** if `openRun` has not landed on Base (or at minimum Base Sepolia) by end of Day 2, stop all other work and use the CLI fallback (`kh ex cc --wait`) until a hash exists.

2. **Isolate all KeeperHub drift in the kh-client and never let it leak.** The three verified discrepancies (`chainId` vs `network`, synchronous execution, 403 vs 422) are handled once, in one package, behind a typed interface. Every other package consumes stable types. This is the highest-leverage decision for "recoverability after interrupted AI sessions" because a future session only has to trust the kh-client contract, not re-derive the API.

3. **Enforce the invariants mechanically, not by hope.** Ship the CI grep-guards (no nonce, no held key, no staged failure, no KH fetch outside kh-client) in CVY-000 so they fail the build the moment an AI session drifts. This is what makes "never stage a failure" real rather than aspirational, and it directly serves the reliability/observability judging axis.

4. **Follow the locked cut order the instant week 2 slips**, in this exact sequence: x402 → gas-only; React Flow DAG → ordered list with dependency badges; onchain check-and-execute → app-side gate reading the registry via RPC; human approval → auto; 3-way manifest → 2-way (disclosed). **Never cut the timeline or the Critic veto** — those are the demo's two structurally-real reliability moments. Benchmark: if GATE2 (full 12-item run) is not stable by end of D10, freeze all P1 and cut to 2-way manifest + list view.

5. **Rehearse the reliability story around what is always available, not around a live failure.** The two real simulate-vetoes and the real nonce-serialization of concurrent submits happen every run; the genuine transient retry may not. Point to a prior run in the history tab that did retry (real hashes) as the fallback (backup path d). Record a morning run whose hashes are already on Basescan before the live demo (backup path a). Never fabricate a hash.

6. **Prove the agents earn their place with the ablation harness (CVY-016) and put the numbers in the README honesty table.** `--ablate-planner` dropping the landed-item rate from 100% to ~55% and `--ablate-critic` taking wasted-gas events from 0 to 2 is the single most persuasive "originality + real-world usefulness" evidence a judge can verify by running one command.

## Caveats

- **The frozen spec's KeeperHub field names and error codes are partially stale versus live docs (July 2026).** This blueprint corrects them in the kh-client and records the drift in KNOWN_GAPS (G-01/G-02/G-03/G-05). If KeeperHub updates its API again during the build window, re-verify `/api/execute/contract-call`, the status endpoint, and the error taxonomy, and update only the kh-client.
- **The `@keeperhub/wallet` x402 SDK surface (install/config/API) is not confirmed by the available KeeperHub documentation** — this is recorded as gap G-06 with an explicit fallback (cut x402 to a gas-only budget, cut order #1). Do not block P0 progress on it; treat CVY-017 as genuinely optional.
- **Gas→USDC uses a frozen ETH price captured at run open, by design.** A live price oracle would violate the "gas sponsorship / pricing is never load-bearing" invariant and add an external dependency to the reliability path. The manifest should disclose the `runEthUsd` used, so the accounting is honest and reproducible.
- **The worker cannot run on Vercel** (no long-lived processes); it must run on a separate always-on host, or locally during the demo. This is a deployment topology constraint, not an architecture change, and is documented in DEPLOYMENT.md.
- **Effort estimates assume the stated builder profile** (strong Solidity/Foundry, TypeScript, React/viem; solo). The critical-path milestones most likely to overrun are CVY-004 (external API drift), CVY-008 (state machine), and CVY-015 (crash-resume); the gates and cut order exist specifically to absorb that variance without endangering the submission.