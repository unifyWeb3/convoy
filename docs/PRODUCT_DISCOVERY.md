# Product Discovery Report — KeeperHub "Agents Onchain" Hackathon (DoraHacks)

## TL;DR
- **Cadence is rejected.** It loses on a single primary-source fact: KeeperHub's marketplace returns *unsigned calldata for the caller to submit* on any cross-org WRITE workflow ("write workflows return unsigned calldata `{to, data, value}` for the caller to submit"), so KeeperHub's retry / nonce-orchestration / smart-gas / private-routing / simulation stack never touches a "hired" write — Cadence's 10/10 reliability axis collapses on contact with the docs.
- **The winner is CONVOY** — a demand-side, budget-bound autonomous operator that lands a *burst* of interdependent onchain writes as one reliable, provable "run." It OWNS and triggers its KeeperHub workflows, so KeeperHub executes them through the org Turnkey wallet with the full reliability stack, and the reliability demonstration is structurally real (genuine nonce contention from concurrent submission, genuine simulation vetoes) — never staged.
- Convoy answers the killer question cleanly: KeeperHub cannot "launch this next week" because Convoy is a heavy *customer* of KeeperHub execution (planning + adjudication + budget-solvency on top), not an infrastructure feature — and it hits every pattern that won KeeperHub's last hackathon (multi-agent swarm, shared execution primitive, a critic agent, real onchain volume, replayable audit).

## Key Findings

### The hackathon (verified from primary sources)
- **Timeline:** opens July 27 2026 12:00 (UTC+2); build to Aug 13 2026 12:00 (submission deadline; registrations and BUIDL submissions close); judging Aug 13–20; winners Aug 20. This confirms the ~2.5-week solo window.
- **Prizes:** Grand Prize **1st $2,000 / 2nd $1,200 / 3rd $800** ($4,000 grand pool), plus a separately-stackable **$1,000 "Best Onboarding UX Improvement"** bounty split across two winners (~$5,000 total). "A project can place in the top three and still win a bounty." Paid in stablecoins. A single strong solo build can plausibly take a top-three slot *and* the UX bounty via a merged PR / starter template.
- **Judging (execution weighted heavily, verbatim):** "Execution is weighted heavily, because that is the point." (1) "Does it execute onchain via KeeperHub? Working transactions, not mockups. Every team links a transaction their agent has executed." (2) "Use of KeeperHub surfaces. MCP server, CLI, x402, MPP, workflow builder, audit trail." (3) "Reliability and observability. Does the build show it understands failure modes? Retries, gas handling, and audit trail usage all count." Plus originality/usefulness and integration quality/DX.
- **Submission requires:** GitHub source, a short demo video showing the agent executing onchain via KeeperHub, and a link to a transaction the agent executed via KeeperHub. "Incomplete submissions cannot be judged."

### What KeeperHub actually is (capabilities catalogue)
- **Execution model:** every org gets a non-custodial Turnkey wallet (keys in secure enclaves; "Private keys are generated and stored inside secure enclaves and never leave the hardware boundary"). Owned workflows executed on KeeperHub's managed infrastructure get "automatic gas estimation, nonce management, and transaction ordering," "exponential backoff, nonce management, multi-RPC failover," simulation-before-submit, and private routing (MEV protection) on supported chains. "Whether triggered by a human, a schedule, or an AI agent, every execution gets the same reliability guarantees."
- **Triggers (5, confirmed):** Manual, Schedule (cron/interval), Webhook, Blockchain Event, Block Interval. (MCP config shorthand: `Manual, Schedule, Webhook, Event, Block`.)
- **Action nodes:** Web3 — `web3/check-balance`, `web3/check-token-balance`, `web3/read-contract` (no wallet), `web3/transfer-funds`, `web3/transfer-token`, `web3/write-contract` (require org wallet integration). System — HTTP request, Condition (true/false handles; operators incl. `>`, `contains`, `matchesRegex`, `exists`), For Each loop (`loop`/`done` handles), Collect (aggregation), Code, template rendering. Math — sum/count/average/median/min/max/product. Notifications — Discord, Telegram, SendGrid. 20+ protocol plugins (Aave, Spark, Morpho, Uniswap, CoW, Safe, Chainlink, Chronicle, Blockscout, etc.) and CCIP bridging.
- **MCP surface:** hosted aggregate server at `https://app.keeperhub.com/mcp` (OAuth 2.1 or `kh_` Bearer); per-workflow single-tool servers at `/mcp/w/<slug>`. 30+ tools incl. `create_workflow`, `update_workflow`, `execute_workflow`, `get_execution`, `validate_workflow`, `prepare_test_pin_data`, `list_action_schemas`, `execute_contract_call`, `execute_check_and_execute`, `get_direct_execution_status`, `search_workflows`, `call_workflow`, `get_wallet_integration`, `tools_documentation`. Network field takes chain IDs as strings: "1", "11155111", "8453", "42161", "137".
- **CRITICAL — read vs write asymmetry (decisive):** `call_workflow` — "Read workflows execute and return a result; write workflows return unsigned calldata." The marketplace doc repeats: for write workflows it "returns unsigned calldata `{to, data, value}` for the caller to submit." So the reliability stack applies to **owned/triggered executions via the org wallet**, not to cross-org "hired" writes.
- **Agentic wallet (`@keeperhub/wallet`):** per-wallet Turnkey sub-org, no private key on disk, `PreToolUse` safety hook (auto ≤ `auto_approve_max_usd` default $5 / ask / block ≥ $100). Server-side hard caps enforced by Turnkey: contract allowlist Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` + Tempo USDC.e `0x20C000000000000000000000B9537D11c60E8b50`; ≤100 USDC per transfer/approval; 200 USDC per UTC-day (429 `DAILY_CAP_EXCEEDED`); chains Base 8453, Tempo 4217/42431. These caps bind the *payment* wallet, not the org *workflow* wallet.
- **x402 / MPP:** paid workflows settle x402 on Base USDC or MPP on Tempo USDC.e; agents sign EIP-3009 `TransferWithAuthorization`, facilitator pays gas (no ETH needed). Listings indexed on x402scan.com, mppscan.com, 8004scan.io. Reference workflow `mcp-test` priced $0.01.
- **Marketplace:** 70% creator / 30% platform; node graph private; slug permanent; paid calls ≥$0.05 exempt from monthly execution quota; callers charged only on successful execution.
- **Gas sponsorship (correction to prior brief):** the docs say sponsorship covers **Ethereum, Base, Polygon, Arbitrum + their testnets** — not "mainnet Ethereum only." Conditions: direct wallet sender (no Safe), public mempool (private-routed txs are NOT sponsored), and available gas credits. Sponsorship pays gas only, never the asset moved. Primary source (docs Gas Management) overrides the prior brief.
- **Chains:** 12 EVM chains incl. Ethereum, Base, Arbitrum, Optimism, Polygon; testnets Sepolia + Base Sepolia; agentic-wallet signing today only Base 8453 + Tempo 4217/42431. Solana unsupported.
- **Under-used / white space:** no native "batch/atomic multicall" node, no cross-wallet nonce parallelism (single sequential nonce per wallet — this is the *source* of the real contention Convoy exploits), no built-in planner over pending work. KeeperHub's own examples showcase DeFi auto-compound; nobody showcases **burst execution under concurrent load** or **an audit ledger as the deliverable** — Convoy's white space.

### Ecosystem maturity (safe to demo TODAY, July 2026)
- **x402:** production. Per Chainalysis ("Inside x402: 100M Agentic Payments on Base," June 3 2026), x402 "went from near-zero in mid-2025 to more than 100 million cumulative transactions by Q1," and $1+ payments rose to 95% of value transferred (from 49% in early 2025). The x402 Foundation launched operationally under the Linux Foundation on July 14 2026 with exactly 40 member organizations (premier members incl. AWS, Circle, Cloudflare, Coinbase, Google, Mastercard, Shopify, Stripe, Visa). Per the RZLT x402 explainer (2026), "Base handles roughly 85% of x402 transaction volume as of April 2026," across ~165M transactions and 69,000 active agents. **Caveat:** per Artemis on-chain analysis cited by CoinDesk (March 11 2026), x402 "currently processes only about $28,000 in daily volume, much of it from testing and 'gamed' transactions rather than real commerce," with roughly half of ~131,000 daily transactions classified as artificial (self-dealing/wash). Real but young — safe to demo sub-dollar payments on Base; do not overclaim revenue.
- **MPP / Tempo:** Tempo (incubated by Stripe and Paradigm) launched mainnet March 18 2026 with MPP co-authored by Stripe/Tempo. Per The Defiant (March 18 2026), "MPP introduces a 'sessions' primitive that lets agents authorize a spending limit upfront and stream micropayments continuously without an on-chain transaction per interaction"; Stripe, Visa, and Lightspark have extended MPP to cards, wallets, and Bitcoin Lightning respectively. Demoable but newer than x402 — use as fallback, keep x402/Base primary.
- **ERC-8004:** live on Ethereum mainnet (Jan 29 2026); Identity/Reputation/Validation registries; Base deployment on the roadmap. Use only as optional identity/discovery garnish — not the product.
- **Turnkey policy engine:** production; the hard caps above are real and enforced in-enclave.

### What actually wins these hackathons
KeeperHub reviewed all 180 submissions of its prior ETHGlobal Open Agents event and named three winners. Winning patterns: (1) **real onchain volume with hard numbers** (ZW.ARM: 450 confirmed txs on Base mainnet, 12,559 cycles over 6.9 days, real USDC, 98.4% optimal-decision rate); (2) **multi-agent swarms where KeeperHub is the shared execution primitive** ("one agent decides, another critiques, KeeperHub executes"); (3) **an independent critique agent** that challenges every decision before execution; (4) **per-user KeeperHub wallet provisioning** as broader infra use; (5) **production seriousness** (Tradewise: 125 tests + reproducible KeeperHub bug reports); (6) **reusable connectors** other devs adopt (Keeper-Gate). They explicitly declined to fill prize slots for "shallow integration with a polished pitch." Convoy is engineered to hit patterns 1, 2, 3, 5, 6 in a non-DeFi domain.

### Phase 1 — critique adjudication (Cadence)
Running tally: **4 fatal, 6 structural, 8 cosmetic.** The four fatal:
- **F1 (new; decisive): the reliability axis is architecturally void.** Cadence is a supply-side listing hired by agents; its hired action is a WRITE; KeeperHub returns unsigned calldata to the *caller* for those. So the retries/smart-gas/nonce/private-routing/simulation Cadence scored 10/10 on **do not run** on the hired write — the caller submits it. VALID. Neither prior critique caught this; it is the single strongest reason to abandon Cadence.
- **F2 (Critique B#2 + A#10): weak moat / "not the future."** After hearing "agents hire services," an experienced panel still says "the platform is KeeperHub, not you." VALID.
- **F3 (both, retry authenticity):** injecting a gas spike to force a retry is either staged (disqualifying under the user's rules) or, if simulated, credibility-destroying. VALID and disqualifying.
- **F4 (A#4 + B#3, decorative AI):** "compound/repay/DCA/wait" is policy a rule engine makes; remove the LLM and little changes. VALID — disqualifying under the "LLM decorative = disqualifying" rule.
- **Structural** (fixable but still perceived): DeFi crowding (A#1/B#4/B#5), marketplace cold-start (A#5), competitor overlap with DeFi Saver/Instadapp/Gelato/Otomato (A#6/B), thin/arbitrary economics (A#7/B#8), checkbox smell (B#9), infra-invisibility (B#10). **Cosmetic:** ERC-8004-isn't-the-product (A#8), demo too short (A#9), MCP-is-niche (B#12), "what did YOU build" (B#13), emotional hook (B#11), "weekend replication" overstatement (A).
- **Killer question — "KeeperHub launches Cadence next week":** Cadence loses. Publishing a priced keeper workflow and registering it on the x402/MPP/8004 registries is exactly KeeperHub's own marketplace feature; KeeperHub is the natural first party to ship it. Differentiation insufficient. **Cadence is rejected; it lost on F1 (reliability void) primarily, F2–F4 secondarily.**

## Details — Full Product Discovery Report: CONVOY

### 1. Executive summary
Convoy is an autonomous **onchain release operator**: a budget-bound agent that takes a set of pending, interdependent onchain actions and lands them as one reliable, auditable "run." It composes many KeeperHub workflows into a higher-level operational system, does genuine online planning and recovery (ordering under state dependencies, budget-aware deferral, revert recovery, re-planning), runs a critic agent that simulates and vetoes each step before any spend, and pays for its own verification inputs via x402/MPP so that its *solvency is a function of execution reliability*. Removing KeeperHub deletes the product: the burst of concurrent writes from one wallet degenerates into nonce collisions, replacement-underpriced errors, and half-applied state with no proof of what happened. Convoy is a KeeperHub *customer*, not a KeeperHub feature — which is why no first party can "launch it next week."

### 2. Product vision
Every serious onchain operation is really a *batch* that must land completely or be cleanly recoverable: rotating a set of registry entries, publishing a batch of attestations/snapshots, pushing a coordinated config change across contracts, disbursing a scheduled tranche. Today teams do this with a spreadsheet, a hot wallet, and a prayer — and the failures (a stuck nonce, a gas spike mid-batch, a revert that orphans dependent steps) happen precisely when the batch matters most. Convoy makes "the run" the primitive: describe the batch in plain language, and an agent plans it, lands it reliably under real network conditions, and returns one signed manifest linking every transaction. Execution itself is the product.

### 3. Problem statement
A single EOA/org wallet has one sequential nonce. Firing K writes near-simultaneously against it is a documented, unavoidable failure mode: concurrent workers read the same pending nonce, collide, and one silently overwrites the other or fails "replacement transaction underpriced" (see Chainstack/Openfort nonce literature); a gas spike strands the middle of the batch; a revert on step 3 leaves steps 1–2 applied and 4–K invalid. Naive builders hit exactly this. Solving it correctly requires nonce orchestration, transaction ordering, adaptive gas with backoff, multi-RPC failover, pre-submission simulation, and a complete replayable log — i.e., an execution-reliability layer. That is the "last mile" the hackathon exists to reward.

### 4. Why now
- x402/MPP make it possible for an agent to be *budget-bound and self-funding* for the first time (Base 100M+ cumulative tx per Chainalysis; Tempo/MPP live March 2026), so "solvency depends on reliability" is a real, demoable mechanic, not a metaphor.
- Agent frameworks + MCP make multi-agent planning/critique loops trivial to wire (KeeperHub's own data: 52/180 prior teams integrated via MCP).
- KeeperHub's reliability stack is production-grade (Sky/MakerDAO; "zero-downtime production record protecting $9.5B in assets"), so the last-mile guarantees Convoy leans on are real, not aspirational.

### 5. Why KeeperHub is indispensable ("if KeeperHub vanished, this dies")
Convoy's core behavior — landing a concurrent burst of writes from one wallet correctly and provably — is *only* possible because of: **nonce orchestration + transaction ordering** (serializes the burst so it doesn't self-collide); **adaptive gas + exponential backoff + multi-RPC failover** (lands steps under real spikes/RPC blips); **simulation-before-submit** (the critic's veto is real: a step that would revert never costs gas); **Turnkey unattended signing** (the run executes headless); **the audit trail** (the manifest — trigger, simulation result, submitted tx, gas used, outcome, timestamp, exportable — IS the deliverable); and **x402/MPP** (the budget meter that ties solvency to reliability). Replace KeeperHub with a raw RPC + a hot key and Convoy becomes the exact anti-pattern the nonce literature warns against. This passes the "if KeeperHub disappeared" test at the level of core behavior, not convenience.

### 6. Complete architecture
```
                       ┌────────────────────────────────────────────┐
  Plain-language  ───▶ │  CONVOY PLANNER (LLM)                        │
  batch + budget       │  parses items+evidence, builds execution DAG │
                       │  (order, deferrals, budget allocation)       │
                       └───────────────┬──────────────────────────────┘
                                       │ per step
                       ┌───────────────▼───────────┐   veto/approve
                       │  CRITIC AGENT (LLM #2)     │──────────────┐
                       │  simulates via KeeperHub,  │              │
                       │  challenges risk/spend      │             ▼
                       └───────────────┬────────────┘        (rejected → logged,
   x402/MPP  ◀── pays for ─────────────┤                      no spend)
   data inputs (agentic wallet)        │ approved steps
                                       ▼
                       ┌────────────────────────────────────────────┐
                       │  KEEPERHUB (org Turnkey wallet, owned WFs)   │
                       │  execute_workflow → nonce order, sim, adaptive│
                       │  gas, backoff, multi-RPC, (optional) private  │
                       │  routing, audit trail                         │
                       └───────────────┬──────────────────────────────┘
                                       ▼  writes
                       ┌───────────────────────────┐
                       │ ConvoyRegistry (Base 8453) │  emits events per action
                       └───────────────┬────────────┘
                                       ▼
                       Run Board UI  +  exported Audit Manifest (JSON/CSV, tx links)
```
Two wallets, cleanly separated: the **agentic payment wallet** (`@keeperhub/wallet`, x402/MPP, sub-dollar, bound by Turnkey hard caps) and the **org workflow wallet** (executes registry writes with the full reliability stack). Convoy the agent never holds a raw key for either.

### 7. Agent design (what the model decides; why a rule engine can't substitute)
The Planner solves an **online constrained-planning problem**: given K items — each with an unstructured evidence blob, a deadline, an uncertain gas cost, and registry-state dependencies (an item can require another to land first) — decide which to verify (spending x402 budget), which to write now vs defer, in what order, and how to re-plan when a write reverts or when landing the next step would blow the remaining budget. This is not `if x then y`: it requires (a) interpreting heterogeneous natural-language evidence to decide validity and priority, and (b) combinatorial sequencing under a hard budget with live feedback. The Critic independently re-reads each proposed step, requests a KeeperHub simulation, and vetoes steps that would revert or overspend — the "decide/critique/execute" split KeeperHub's own winners used. **Ablation test (the one judges run):** remove the LLMs and you must hand-build both a bespoke solver *and* a rules engine that still cannot adjudicate unstructured evidence — the system materially degrades. AI is load-bearing.

### 8. KeeperHub integration (exact triggers, nodes, surfaces)
- **Triggers:** Manual (`execute_workflow` for on-demand runs), Schedule (recurring batch windows), Block Interval + Blockchain Event (detect when upstream state is ready).
- **Action nodes:** `web3/read-contract` + `web3/check-balance` (planner/critic reads, no wallet), `web3/write-contract` (registry writes), Condition (dependency gates, true/false handles), For Each (fan-out over the batch, `loop`/`done`), Collect + Math (roll up run stats), HTTP (fetch evidence), Notifications/Discord+Telegram (run summary).
- **Surfaces exercised, each load-bearing (not checkbox):** workflow builder (Convoy owns/updates many workflows), MCP aggregate server (`create_workflow`/`execute_workflow`/`get_execution`/`validate_workflow`/`prepare_test_pin_data` for the run loop; `call_workflow` + x402 for paid data inputs), x402 (Base USDC) + MPP (Tempo USDC.e) for the budget, audit trail (the deliverable), CLI (`kh run logs`, `kh execute`, CI setup), Turnkey org signing, Safe optional for higher-assurance targets.

### 9. Smart contracts (what's deployed, where, why custom is justified)
Deploy one minimal **`ConvoyRegistry`** on Base (8453) — Foundry, verified on Basescan. It exposes `openRun(bytes32 runId)`, `commitAction(bytes32 runId, uint256 idx, bytes32 payloadHash)`, and `sealRun(bytes32 runId)`, emitting an event per call. Custom contract is justified for three reasons judges will accept: (1) it gives Convoy a *non-DeFi* write target so the build cannot be dismissed as "expanded KeeperHub's auto-compound example"; (2) the open→commit→seal lifecycle creates **genuine state dependencies**, which is what makes nonce ordering and sequencing *matter* (and thus makes the reliability story real); (3) it provides an on-chain counterpart to the audit manifest, so every capability claim maps to a verifiable on-chain artifact (the builder's "honesty table" README pattern). No DeFi contracts, no flash loans, no atomic-unwind complexity — deliberately.

### 10. Backend
A small TypeScript service (Node) hosting the two agents (any framework — LangChain/ElizaOS/custom; framework is free per the rules), the KeeperHub MCP client (OAuth or `kh_` Bearer), the `@keeperhub/wallet` payment client, a run-state machine, and a WebSocket feed to the frontend. All onchain actions go through KeeperHub `execute_workflow`/`execute_contract_call`; the backend never signs. Deterministic run IDs; idempotent step submission keyed by `(runId, idx)` so a retry can never double-write.

### 11. Frontend
A single **Run Board** (Next.js): the batch shown as a convoy of cards moving through `planned → simulated → submitted → landed / vetoed / retried`; a live **budget meter** draining as x402 payments and gas are consumed; and the **audit manifest** assembling in real time with clickable Basescan links per landed tx. This directly answers "infrastructure is invisible / best demos are visual": the reliability layer is rendered as visible motion and a draining budget with real stakes.

### 12. Database
Postgres (or SQLite for the solo build): `runs`, `run_items` (evidence, deadline, dependency edges, status, chosen order, gas spent, tx hash, KeeperHub execution ID), `payments` (x402/MPP receipts, budget ledger), `audit_export`. The DB mirrors KeeperHub's audit trail so the exported manifest is reproducible offline and cross-checkable against `get_execution`.

### 13. APIs
- **Inbound:** `POST /run` (plain-language batch + budget), `GET /run/:id` (state + manifest), WebSocket `/run/:id/stream`.
- **KeeperHub:** MCP tools listed in §8 over `https://app.keeperhub.com/mcp`; REST/`kh` CLI for CI.
- **Payments:** x402 402-challenge flow via `@keeperhub/wallet`; MPP fallback on Tempo.
- **Reads:** Blockscout MCP optional for decoded state (KeeperHub's own recommended read layer), keeping Convoy's surface tight.

### 14. Security model
- **Key custody:** no raw keys in Convoy. Org workflow wallet = Turnkey enclave (KeeperHub-signed, policy-bound); payment wallet = `@keeperhub/wallet` Turnkey sub-org, HMAC secret only on disk, hard caps enforced in-enclave (Base USDC + Tempo USDC.e allowlist, ≤100/transfer, 200/UTC-day).
- **Prompt-injection surface:** evidence blobs are untrusted input to the Planner/Critic. Mitigations: (a) the LLMs can only *propose* actions against the `ConvoyRegistry` allowlist and a fixed function set — they cannot synthesize arbitrary `to/data`; (b) the payment safety hook's `auto_approve_max_usd` is set below any single legitimate input cost, and the server-side contract allowlist makes "drain to attacker" unsignable even if the model is fully manipulated; (c) the Critic is a second, separately-prompted model that must independently approve, and simulation is mandatory before spend. Forged trust-hint fields in payloads are ignored by the hook by design.
- **Blast radius:** worst case a manipulated Planner wastes budget on useless-but-allowlisted writes; it cannot exfiltrate funds or touch non-allowlisted contracts.

### 15. Failure recovery
Every step is idempotent by `(runId, idx)`. On a revert, the Planner marks the step failed, prunes steps that depended on it, and re-plans the remainder within the remaining budget; the run can `sealRun` in a partial-but-consistent state with the manifest recording exactly which indices landed and which were pruned and why. Coded transient errors from KeeperHub (`E-0002` step-failed-after-retries, `N-0001` provider unavailable, `P-000x` could-not-start) are surfaced verbatim in the manifest and retried per KeeperHub's guidance; configuration reverts (the actionable kind) halt the step and log the full message. No silent failure is possible.

### 16. Retry strategy (structurally real, not staged)
Retries and contention arise **genuinely**, never injected:
- **Real nonce contention:** Convoy submits multiple approved steps to KeeperHub near-simultaneously against one org wallet. This is the documented collision case; KeeperHub's nonce orchestration + transaction ordering serialize them. The demo shows the burst landing in a correct sequence that a naive single-wallet submitter would have corrupted — verifiable by nonce order on Basescan.
- **Real simulation vetoes:** at least one batch item is genuinely invalid (a dependency not yet sealed); simulation-before-submit rejects it and it costs zero gas. A real veto, not theater.
- **Real transient handling:** if a Base RPC blip or underpriced-replacement occurs during the run, KeeperHub's backoff/multi-RPC failover re-lands it and the manifest records the retry. Convoy does **not** fabricate a gas spike; the README's honesty table states plainly that retries appear only when a genuine transient occurs, and the audit trail is the evidence either way.

### 17. Audit trail integration
The exported **manifest** is the product. For each step Convoy pulls `get_execution` (combined status + step logs) and the direct-execution status (tx hash, gas used), reconciles it against `ConvoyRegistry` events and the local ledger, and produces one JSON/CSV artifact: run ID, per-item trigger, simulation result, submitted tx, gas used, outcome, timestamp, budget consumed. This maps one-to-one to KeeperHub's documented audit fields and to on-chain events — the honesty-table README links every claimed capability to a Basescan tx or an export line.

### 18. MCP integration
Convoy is an MCP-native operator: it drives the aggregate server (`create_workflow`, `execute_workflow`, `get_execution`, `validate_workflow`, `prepare_test_pin_data`, `execute_contract_call`) for the run loop, and consumes paid data via `call_workflow` (handling the 402/x402 challenge through the agentic wallet). Because the hackathon warns MCP is still niche to some judges, the *narrative* leads with "reliable batch execution," and MCP is shown as the plumbing — not the pitch.

### 19. x402 / MPP usage
Load-bearing, not decorative: Convoy's verification inputs (per-item evidence lookups / data workflows) are paid per call via x402 on Base USDC (sub-dollar), MPP on Tempo USDC.e as fallback, through `@keeperhub/wallet` (EIP-3009, facilitator pays gas). The **budget meter** is the Planner's hard constraint — every wasted-gas failure shrinks the budget and can cause the run to end early, so *solvency is literally a function of execution reliability*, exactly the demand-side mechanic both prior critiques said would beat Cadence. Optionally Convoy lists its own verification workflow on the marketplace (≥$0.05, quota-exempt) to close a self-funding loop.

### 20. Three-week implementation roadmap (solo)
- **Week 1 (Jul 27–Aug 2):** Deploy `ConvoyRegistry` on Base Sepolia then Base mainnet (Foundry, verified). Wire KeeperHub org wallet + MCP (OAuth/`kh_`), create the owned write/read workflows, validate with `validate_workflow`/`prepare_test_pin_data`. Land the first real `commitAction` tx (satisfies the hard "one real tx" gate early). Install `@keeperhub/wallet`; make one real x402 payment against `mcp-test`.
- **Week 2 (Aug 3–9):** Planner + Critic agents; run-state machine; idempotent `(runId, idx)` submission; For-Each fan-out; genuine concurrent submission to surface/serialize nonce contention; simulation-veto path; budget ledger tying x402 spend + gas to solvency; manifest export reconciled against `get_execution` + events.
- **Week 3 (Aug 10–13):** Run Board UI + WebSocket; ≥50-item real run on Base with hard metrics (txs landed, nonce order proof, vetoes, budget consumed); tests (target Tradewise-level seriousness); honesty-table README; demo video; **UX-bounty deliverable** (a `create-convoy-run` starter template + a "zero-to-first-tx" teardown PR to `github.com/KeeperHub/keeperhub`) to stack the $1,000 bounty. Submit by Aug 13 12:00 with GitHub + video + tx link.

### 21. Live demo script (<3 min, second-by-second)
- **0:00–0:20** — One sentence: "Convoy lands a batch of onchain writes as one reliable, provable run." Show the Run Board with a 50-item batch queued and a fixed USDC budget.
- **0:20–0:50** — Hit Run. Planner parses items and renders the execution DAG; the budget meter starts; two items pay x402 for verification (real 402 → sign → 200), visible as the meter ticks down.
- **0:50–1:20** — Critic simulates each step; **one genuinely invalid item is vetoed** (dependency not sealed) — zero gas spent, logged. Emotional beat: "it refused to spend on a write that would have failed."
- **1:20–2:10** — A burst of approved steps submits concurrently against the one org wallet; KeeperHub serializes the nonces and lands them; cards flip to `landed` with Basescan links appearing. **The real transaction lands here (~1:40)** — click the top hash live to Basescan showing `commitAction` on `ConvoyRegistry`, correct nonce order. If a transient retry occurred, point to the manifest line.
- **2:10–2:40** — `sealRun` lands; the manifest assembles: 47 landed, 1 vetoed, 2 deferred over budget, gas used, budget remaining. Click "Export" → JSON with every tx.
- **2:40–3:00** — "Remove KeeperHub and this burst self-collides; the manifest is the proof it didn't. Convoy is KeeperHub's customer, not its clone." Close on the honesty-table README.

### 22. Risks and mitigations
- **Base mainnet cost/instability during demo:** rehearse on Base Sepolia; keep mainnet batch small-value; use KeeperHub gas sponsorship eligibility (direct sender, public mempool) to de-risk ETH funding.
- **x402 immaturity / self-dealing optics:** keep payments genuine and sub-dollar; disclose (per Artemis/CoinDesk) that x402 volume is young; don't overclaim revenue.
- **LLM latency in the demo:** pre-warm; planning is not latency-critical (unlike the rejected MEV concept) — Convoy operates on batches with deadlines in minutes, so LLM non-determinism is acceptable and bounded by the Critic + simulation.
- **"Looks like disbursement/payroll":** frame the demo around registry/attestation writes with dependencies, not USDC payouts, so it cannot be pattern-matched to the rejected payroll concept.
- **Private routing not gas-sponsored:** use public mempool on Base for the sponsored path in the demo; reserve private routing as a documented option, not a demo dependency.

### 23. Rejected alternatives (precise reasons)
- **Cadence (supply-side hireable keeper):** reliability axis void (hired writes return unsigned calldata to the caller — §5/F1); moat is KeeperHub's own marketplace; loses the killer question.
- **Security Incident Responder:** deterministic, AI decorative, seen hundreds of times, security burden-of-proof, KeeperHub interchangeable (previously rejected — unchanged).
- **Crypto Payroll / horizontal business automation:** market-map not a product, AI decorative, survives if KeeperHub is a backend. Convoy differs: AI is load-bearing (planning/adjudication) and KeeperHub is core behavior, not backend.
- **Exodus (MEV evacuation):** sub-second LLM latency, custom-unwind complexity, wrong threat model. Convoy deliberately picks a batch/deadline regime where LLM latency is a non-issue.
- **Pure ERC-8004 agent directory:** using a standard earns no points; kept only as optional identity garnish.
- **DeFi yield-rotation swarm:** already won KeeperHub's last hackathon (ZW.ARM); repeating it invites "better version of something I've seen."

### 24. Remaining weaknesses (honest)
- The `ConvoyRegistry` write target is a demonstrator; a skeptic can ask "who needs a generic run operator?" — mitigated by naming concrete batch use cases and shipping the reusable template, but real-world pull is asserted, not proven, in three weeks.
- Nonce-contention drama depends on genuinely concurrent submission; if KeeperHub serializes so smoothly that nothing visibly retries, the reliability "moment" is quieter than a staged spike would be — accepted deliberately, because staging is disqualifying and dishonest. (The simulation-veto beat is the reliable dramatic anchor.)
- Two LLMs + planning add build risk vs. a one-shot demo; the roadmap front-loads the real tx and keeps the agent loop small to contain it.
- x402/MPP are young; the self-funding loop is real but small-scale.

### 25. Why this is the strongest submission
**One-sentence pitch:** Convoy is the autonomous operator that turns a batch of interdependent onchain actions into one reliable, provable run — and it only works because KeeperHub's execution layer survives the concurrent load that would sink a naive single-wallet agent.

Direct answers to the Q&A attacks:
- *"Why isn't this just an API / what did YOU build?"* — I built the planner/critic loop, the budget-solvency mechanic, the dependency-aware run state machine, the `ConvoyRegistry`, and the manifest reconciliation. KeeperHub is the execution fabric I *consume*.
- *"Why does this need an LLM?"* — online constrained planning over unstructured evidence with live budget/revert feedback; ablation degrades the system (§7).
- *"What stops a clone next week / KeeperHub launching it?"* — Convoy is a demand-side customer that hires heavy execution; a first party won't ship an app competing with its own customers, and a cloner must rebuild the planning/critique/solvency system, not relist a workflow.
- *"Is the retry staged?"* — no; contention and vetoes are structurally real (§16), and the manifest is the evidence.
- *"Isn't this another DeFi keeper?"* — no DeFi protocol, no compounding; a non-DeFi registry with genuine state dependencies, an unshowcased KeeperHub surface (burst execution + audit-as-deliverable).
- *"Pricing/economics believable?"* — economics are internal (budget solvency), not an invented $0.05 marketplace fee, so there is no fake-pricing tell.
It matches every pattern that won KeeperHub's last event (multi-agent, shared execution primitive, critic agent, real onchain volume with hard numbers, production seriousness, reusable template) while being memorable, visual, non-DeFi, and impossible to build without KeeperHub.

## Recommendations
- **Commit to Convoy now; drop Cadence.** The decision hinges on one verifiable fact (hired writes return unsigned calldata to the caller), so it is not a matter of taste.
- **Stage-gate the build by benchmarks, not vibes:**
  - *End of Week 1:* if you have not landed one real `commitAction` tx on Base and made one real x402 payment, cut scope to a 10-item run and a single owned write workflow.
  - *End of Week 2:* if concurrent submission does not reproduce genuine nonce contention that KeeperHub serializes, pivot the reliability "moment" to the simulation-veto + real transient retry (both structurally real) and do not stage anything.
  - *End of Week 3:* target ≥50 landed txs on Base with a clickable manifest; if unstable, drop to Base Sepolia for volume and keep a smaller mainnet run for the tx-link requirement.
- **Stack the $1,000 UX bounty:** ship a `create-convoy-run` starter template + a "zero-to-first-tx" teardown PR to `github.com/KeeperHub/keeperhub`; low marginal effort, directly matches the bounty rubric.
- **Keep the surface honest:** minimize third-party deps (Blockscout read layer optional); every reliability claim maps to a Basescan tx or an export line in the honesty-table README.
- **Threshold that would change the plan:** if KeeperHub ships a native "batch/atomic run" node during the build, re-center Convoy's differentiation on the planner/critic/solvency layer and treat the node as a dependency Convoy orchestrates.

## Caveats
- DoraHacks prize/timeline figures were read from search-result snippets of the official page (direct fetch returned HTTP 405); the $4,000 grand total and $5,000 overall total are the arithmetic sum of individually-quoted amounts ($2,000/$1,200/$800 + $1,000 bounty). The page says "stablecoins," not specifically USDC.
- **Documented conflict:** the prior brief said gas sponsorship is "mainnet Ethereum only"; KeeperHub's Gas Management doc says Ethereum, Base, Polygon, Arbitrum + testnets (direct sender, public mempool, credits). Primary source overrides the brief.
- x402 adoption is real but young; per Artemis on-chain analysis cited by CoinDesk (March 11 2026), ~half of observed x402 volume is testing/self-dealing on ~$28,000 daily. Convoy's self-funding loop should be presented as a working mechanic at small scale, not a revenue claim.
- ERC-8004 and MPP are live but newer than x402 on Base; keep x402/Base as the demo spine (≈85% of x402 volume) and treat MPP/Tempo and ERC-8004 identity as documented options, not load-bearing demo dependencies.
- Do not conflate this DoraHacks "Agents Onchain" hackathon with KeeperHub's separate ETHGlobal "OpenAgents" event ($5,000 across three tracks) whose 180-submission review supplied the winning-pattern evidence.
- Convoy's real-world pull is asserted via concrete use cases and a reusable template, not proven in three weeks — the honest residual risk in §24.