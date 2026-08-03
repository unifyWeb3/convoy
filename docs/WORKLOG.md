# Convoy Worklog

Append-only build diary. One entry per milestone, newest at the bottom. Never edit or delete an
existing entry. Template: `.convoy/templates/worklog-entry.md`.

---

## 2026-07-29 — CVY-000 Repository bootstrap and toolchain

Summary: Bootstrapped the pnpm monorepo from an empty repository containing only the three frozen
reports. Moved the reports to their canonical `docs/` paths byte-identically, created the full
repository tree from blueprint §1, populated the `.convoy/` AI operating system with real content
(5 agent roles, 2 instruction files, the milestone prompt, 3 playbooks, 3 checklists, 3 templates,
22 task cards, MCP config), seeded the seven tracking documents, wrote the environment template and
verification script, and shipped three CI workflows carrying the four mechanical grep-guards. All
implementation modules are empty compilable scaffolds — no protocol logic, no contracts, no state
machine, no agents, no UI logic.

Files: package.json, pnpm-workspace.yaml, tsconfig.base.json, .nvmrc, .gitignore, .env.example,
vercel.json, README.md, CLAUDE.md, AGENTS.md, .eslintrc.cjs, .prettierrc, .prettierignore,
.github/workflows/{ci,contracts,e2e}.yml, .convoy/** (36 files), docs/** (10 files),
packages/contracts/{foundry.toml,remappings.txt,src,test,script},
packages/db/**, packages/kh-client/**, apps/web/**, services/worker/**,
scripts/{bootstrap.sh,verify-env.ts,first-tx.ts,ablation.ts}, tests/fixtures/

Commit: see the milestone report

Verification: pnpm install clean; pnpm -r build across 4 packages; pnpm -r typecheck clean;
pnpm -r lint clean; pnpm -r test passes with no test files; forge build clean;
scripts/bootstrap.sh executable; verify-env.ts prints the PASS/FAIL matrix; all four CI grep-guards
return no output; CLAUDE.md and AGENTS.md byte-identical.

Notes: Environment audit found Node 22, pnpm, Foundry and git already present and compatible — reused,
not reinstalled. PostgreSQL and Redis were absent and were installed during Stage 1. Checks requiring
credentials that do not exist yet (KeeperHub auth, KeeperHub wallet, Base RPC, deployed registry)
FAIL by design and are reported as expected failures rather than faked. Recorded gaps G-01…G-06 from
the blueprint, plus G-07/G-08/G-09 for three conflicts between the Product Discovery Report and the
frozen Architecture — resolved in the architecture's favour in every case, never by redesigning.
Decisions D-001…D-005 recorded.

---

## 2026-08-03 — CVY-001 ConvoyRegistry + MockRewardDistributor + Foundry tests

Summary: Implemented both contracts exactly as frozen in ARCHITECTURE §8 — no additions, no
optimisations, no extra functions — with 45 green Foundry tests. `ConvoyRegistry` ships the
`None/Open/Sealed` enum, the packed `Run` struct, the `runs`/`payloadHash`/`committed` mappings,
three events, six custom errors, and `openRun`/`commitAction`/`sealRun`/`isCommitted`.
`MockRewardDistributor` implements the genuine precondition chain `setRoot → fund → enableMarket`.
Unit tests cover every happy and revert path including the five named on the task card; a
`StdInvariant` handler drives the four named invariants (plus `invariant_operatorIsOpener`) at
runs=1000 depth=32.

Files: packages/contracts/src/ConvoyRegistry.sol, packages/contracts/src/MockRewardDistributor.sol,
packages/contracts/test/ConvoyRegistry.t.sol, packages/contracts/test/ConvoyRegistry.invariant.t.sol,
packages/contracts/test/MockRewardDistributor.t.sol, docs/IMPLEMENTATION_STATUS.md,
docs/KNOWN_GAPS.md, docs/DECISIONS.md, docs/TESTING.md, docs/WORKLOG.md, README.md,
docs/milestones/CVY-001.md

Commit: 8b6ce3a

Verification: forge test 45 passed / 0 failed across 3 suites; invariants 5×(runs 1000, calls 32000,
reverts 0); forge fmt --check clean; forge build --sizes clean (ConvoyRegistry runtime 1,538 B);
pnpm format:check clean; pnpm -r lint clean; pnpm -r typecheck clean; pnpm -r build 4 packages;
pnpm -r test passes with no TS test files yet; all four CI grep-guards return no output.
foundry.toml was already correct from CVY-000 (optimizer, [invariant] runs=1000 depth=32,
[etherscan]) and was not modified.

Notes: `AlreadySealed()` is declared in the frozen source but is unreachable — `openRun` guards on
`state != None`, so reopening a sealed run reverts `AlreadyOpen()`. Recorded as G-10 and pinned by a
unit test; **not** reconciled. G-11 records the `unchecked` uint32 counter increment, also left as
frozen. G-12 records that blueprint A4 places a `payloadHash` helper "in ConvoyRegistry" while the
frozen §8 source has none — architecture wins, the helper lands in CVY-002's fixture-dump script.
G-13 records that `fail_on_revert = false` makes green invariants meaningless without coverage
evidence: uniform actor selection was measured landing `accepted open/commit/seal: 4 0 0` over 32
calls, so the handler now biases towards the run's operator (4 5 1 accepted after the fix) and
prints accepted/rejected counters. G-14 records that a ghost variable assigned from the contract
under test mirrors it and makes its invariant tautological: `ghostLastSeq` is now incremented by the
handler and the counting invariants were mutation-tested — changing the contract's
`committedCount += 1` to `+= 2` fails both `invariant_idxMonotonic` and
`invariant_committedCountMatches` on the first accepted commit. Decisions D-009 (mock ships without
events or access control), D-010 (handler bias + coverage counters) and D-011 (independently derived
ghosts + mutation test) recorded. No KeeperHub proof: this milestone touches no
KeeperHub surface and deploys nothing. The roadmap's "hard Day-2 deadline" for CVY-003 has passed
unmet — the slip is recorded in IMPLEMENTATION_STATUS.md and is not re-baselined here.

---

## 2026-08-03 — CVY-002 payloadHash parity (Sol↔TS) + deploy script

Summary: Pinned the payload commitment byte-for-byte across Solidity and TypeScript, proven on 13
fixtures dumped from real Solidity output by a forge script rather than hand-written. Added
`payloadHash()` and `encodeArgs()` to `@convoy/kh-client` and re-exported them from the package
entry point, and wrote `Deploy.s.sol` for Base Sepolia (84532) and Base mainnet (8453). The frozen
blueprint A4 encoding was used unchanged; the documented fallback encoding was not needed.

Files: packages/contracts/script/DumpPayloadHashFixtures.s.sol,
packages/contracts/script/Deploy.s.sol, packages/contracts/foundry.toml,
packages/kh-client/src/payloadHash.ts, packages/kh-client/src/index.ts,
packages/kh-client/test/payloadHash.parity.test.ts, packages/kh-client/package.json,
tests/fixtures/payloadHash.fixtures.json, .github/workflows/ci.yml,
.convoy/checklists/review.md, .prettierignore, pnpm-lock.yaml, docs/IMPLEMENTATION_STATUS.md,
docs/KNOWN_GAPS.md, docs/DECISIONS.md, docs/TESTING.md, docs/DEPLOYMENT.md, docs/WORKLOG.md,
README.md, docs/milestones/CVY-002.md

Commit: c5dedf2

Verification: 47 parity assertions green across 13 fixtures on the first run; forge test still
45 passed / 0 failed; forge fmt --check clean; forge build clean (the CVY-001 "AST source not found
for Deploy.s.sol" warning is gone now that the script has real content); pnpm format:check clean;
pnpm -r lint / typecheck / build / test clean; all four CI grep-guards return no output; the fixture
dump is deterministic (identical md5 across two runs, no git diff); the deploy script's chain guard
verified by a real stray run, which reverted `UnsupportedChain(31337)`.

Notes: Parity held on the first attempt for every case including the ones most likely to diverge —
empty args (Solidity zero-length `bytes` vs viem's `"0x"`), an empty function name, a 103-character
function name, multi-byte UTF-8 in a dynamic string, a 33-byte `bytes` blob, `address[]`,
`uint256[]`, a negative `int256`, and `idx` at `uint256` max. Falsifiability was checked rather than
assumed: adding 1 to `idx` inside `payloadHash()` fails 26 of the 47 assertions. G-15 records that
compiling `Deploy.s.sol` emits a build artifact containing the string `PRIVATE_KEY`, which tripped
the key grep-guard locally (CI unaffected — clean checkout, `out/` gitignored); guards 1, 3 and 4
now exclude build output. G-16 records that `test/` sits outside the typecheck gate, accepted as the
CVY-000 convention. Decisions D-012…D-015 recorded. Off-card but required: viem added to kh-client,
`fs_permissions` scoped to the fixtures directory in foundry.toml, the generated fixture file added
to `.prettierignore`. Nothing was deployed and no transaction hash is claimed. **CVY-003 is blocked
on four operator credentials that still do not exist.**

---

## DEC-001 — 2026-08-03 — Chain target amendment: Base mainnet (8453) → Base Sepolia (84532)

Scope: a spec amendment, not a milestone. No milestone was started or advanced; CVY-003 remains the
next unfinished milestone and remains blocked on operator credentials.

What changed: the execution chain for development, rehearsal and the demo is now Base Sepolia
(84532). Base mainnet (8453) is retained as an optional final demo target at CVY-019 — support is
parameterised, never removed. Rationale as recorded in DECISIONS.md: Base Sepolia keeps the ~2s
block times the 3-minute demo's serialized-nonce beat depends on (Ethereum Sepolia's ~12s blocks
were considered and rejected for exactly this reason), testnet gas removes funding risk from the
critical path, and staying in the Base family keeps a late flip to 8453 cheap.

Files changed: docs/DECISIONS.md (new "Spec amendments" section + DEC-001), docs/KNOWN_GAPS.md
(G-17, G-18, G-19 + detail), .env.example, packages/contracts/foundry.toml,
scripts/verify-env.ts, .convoy/tasks/CVY-002.md, .convoy/tasks/CVY-003.md, .convoy/tasks/CVY-004.md,
.convoy/tasks/CVY-012.md, .convoy/tasks/CVY-019.md, CLAUDE.md, AGENTS.md,
docs/IMPLEMENTATION_STATUS.md, docs/WORKLOG.md

Verification: pnpm -r build / typecheck / lint clean; pnpm format:check clean; forge build and
forge test clean (45 passed / 0 failed) with BASE_MAINNET_RPC_URL unset, confirming the remapped
endpoint resolves lazily; all four CI grep-guards clean; CLAUDE.md and AGENTS.md byte-identical.

Notes: **DEC-001 asked for the two new gaps to be numbered G-07 and G-08, but those IDs have been
occupied since CVY-000** (workflow-surface conflict; gas-sponsorship conflict) and are referenced
from DECISIONS.md and the milestone reports. Renumbering would break those references, so the gaps
were recorded verbatim at the next free IDs — **G-17** (x402 is Base-mainnet-only) and **G-18**
(budget meter notional on testnet) — cross-referenced to their near-neighbours G-06 and G-04 so
nobody merges them later.

One change was made outside DEC-001's file list because the amendment itself created the hazard:
foundry.toml mapped `[rpc_endpoints] base = "${BASE_RPC_URL}"`, so repointing BASE_RPC_URL at
Sepolia would have made `--rpc-url base --broadcast` deploy to Sepolia while the operator believed
it was mainnet — and Deploy.s.sol's allowlist permits both chains, so the accident guard would not
have caught it. `base` now maps to a new optional `BASE_MAINNET_RPC_URL`, unset by default.

G-19 records nine chain references across eight files that DEC-001 did not enumerate and that were
deliberately not swept — most importantly README.md:8 ("Chain: **Base mainnet (8453)**"), now an
externally-visible false claim, and .convoy/agents/principal-blockchain.md:50, which instructs a
future agent to assert `0x2105`. DEC-001 carries an explicit supersession note naming the frozen
blueprint §11 lines that still say 8453, so verify-env's new 84532 pin is not "corrected" back.

DEC-001 assumes KeeperHub direct execution works on 84532. PRODUCT_DISCOVERY §Key Findings supports
it — Base Sepolia is in the supported chain list and the 8453-only restriction applies to
agentic-wallet signing (which is G-17) — but it cannot be verified offline and is proven at
CVY-003/CVY-004 with a real key. CVY-003's fallback #1 now covers the case where it is false.

---

## DEC-001 closeout — 2026-08-03 — premise verified, G-19 swept and CLOSED

Not a milestone. Three things: a status-tracking fix, the live verification of DEC-001's one
unproven premise, and the G-19 sweep.

**Tracking bug fixed.** `docs/IMPLEMENTATION_STATUS.md` named CVY-003 as "**next**". It is not:
CVY-003's own card requires "a minimal write path from CVY-004", and CVY-004's card lists CVY-003
among the things it blocks. The dependency order is **002 → 004 → 003**, and the critical-path line
had it inverted as `002 → 003 → (004)`. Also stale: CVY-003 was marked "BLOCKED on operator
credentials" when all four now exist, and DEC-001 was absent from the milestone table entirely.
CVY-003 remains **unfinished** — nothing is deployed, no hash is claimed; it is simply not next.

**DEC-001's premise is VERIFIED, not inferred.** One `simulate:true` call to
`POST /api/execute/contract-call` with `chainId:"84532"` / `network:"84532"`, targeting the WETH9
predeploy with an explicit `abi`, returned **HTTP 200**
`{"success":true,"status":"simulated","wouldRevert":false,"gasEstimate":"25989"}` plus a real `from`
address — so the org Turnkey wallet is provisioned for 84532 and does not 422. No `executionId` is
returned for a simulate, and no validation errors were returned. Because the primary returned a
simulate-shaped response, the 8453 control run was not needed and was not made. Redacted request and
response recorded at `packages/kh-client/test/vcr/dec-001.simulate.84532.probe.json`. The probe ran
from outside the repository on purpose — `packages/kh-client` is the only module permitted to reach
`app.keeperhub.com` and it does not exist yet.

**Response-shape drift worth noting for CVY-004:** the live simulate response is
`{success, status:"simulated", from, to, value, gasEstimate, simulatedReturnValue, wouldRevert}`.
CLAUDE.md documents `{wouldRevert, gasEstimate, ...}`; the extra fields are additive, so no gap is
recorded, but the client's types are modelled on the observed shape rather than the documented one.

**G-19 swept and CLOSED.** All twelve stale references fixed, including the three named explicitly:
`.convoy/playbooks/release.md` step 2 is now "OPTIONAL, CVY-019 flip only" with a skip-by-default
banner (it was instructing a mainnet deploy as step 2 of the authoritative release sequence);
`.convoy/agents/principal-blockchain.md:50` now asserts `Number(eth_chainId) === 84532` numerically;
`README.md:8` and its three artifact rows name Base Sepolia 84532. Re-running the regeneration
command still returns hits **by design** — 8453 survives wherever it correctly names the optional
CVY-019 target, the `Deploy.s.sol` chain allowlist, CVY-003's fallback, or the dual-chain Etherscan
key. Every survivor is annotated with a verdict in the G-19 detail section. A zero-hit result would
have meant the optional mainnet path had been deleted, which DEC-001 explicitly forbids.

Files changed: docs/IMPLEMENTATION_STATUS.md, docs/KNOWN_GAPS.md, docs/DECISIONS.md,
docs/DEPLOYMENT.md, docs/TESTING.md, docs/AI_WORKFLOW.md, README.md, .convoy/playbooks/release.md,
.convoy/playbooks/demo.md, .convoy/agents/principal-blockchain.md,
.convoy/agents/lead-protocol-engineer.md, .convoy/instructions/coding-standards.md,
.convoy/checklists/milestone-done.md, .convoy/templates/pr.md, .convoy/tasks/CVY-003.md,
packages/kh-client/test/vcr/dec-001.simulate.84532.probe.json, docs/WORKLOG.md

---

## CVY-004 — 2026-08-03 — kh-client: KeeperHub REST direct execution

The one module permitted to reach `app.keeperhub.com`. Write, simulate, status polling,
check-and-execute, error classification, idempotency, VCR replay.

**114 tests green** in the package (67 new + 47 CVY-002 parity). All four grep-guards clean;
`format:check`, `-r lint`, `-r typecheck`, `-r build`, `-r test` clean.

**Verified live against Base Sepolia, through the built client** — not raw fetch, so what is proven
is the client rather than the API: simulate-veto returned 400 `wouldRevert:true`; simulate-pass
returned 200 `gasEstimate:25989`; the write returned 202 `completed`, execution
`415udzxz33omkbg8okz17`; the status poll returned the hash
`0x94502f69ef87d4bfe75053064275c210e27f7502d78babffb60e59dbc81b4426`
(https://sepolia.basescan.org/tx/0x94502f69ef87d4bfe75053064275c210e27f7502d78babffb60e59dbc81b4426),
`gasUsedWei:74093`, `retryCount:0`, `sponsored:true`. **That transaction is a client smoke test, not
CVY-003's submission artifact** — the submission transaction is `openRun` on the deployed registry and
is not claimed anywhere yet.

**Four new drift findings, all from measurement rather than documentation:**

- **G-21** — a would-revert simulate answers on **HTTP 400** with `success:false` and
  `wouldRevert:true`. The verdict is `wouldRevert`, not `success`. Classifying that 400 as an API
  error would turn every Critic veto into a hard failure and remove the veto mechanism. Mitigated,
  and the inverse guarded: a 400 with no `wouldRevert` field throws rather than reporting "would not
  revert", which would let the Critic approve an item the API never evaluated.
- **G-23** — a synchronous write returns `202 {status:"completed"}` with **no** `transactionHash`;
  the hash exists only on `GET /status`. Gap G-02's mitigation is "short-circuit the poll on a
  terminal POST", and applied literally that discards the transaction hash — the field the manifest's
  KeeperHub leg, the honesty table and the Basescan link all depend on. **This was a real bug in the
  first implementation**, found by running the live write, not by reading docs. `pollUntilTerminal`
  now short-circuits only on `terminal && transactionHash`.
- **G-22** — an unsupported chain returns **HTTP 500 with an empty body**, and 5xx is transient, so a
  permanent misconfiguration would be retried until the budget ran out. `KhClient` now validates
  `chainId` at construction, before anything is sent. This also retroactively strengthens the DEC-001
  probe: an unsupported 84532 would have looked unmistakably different from the 200 it returned.
- **G-20** — `revertReason` is an ethers v6 diagnostic blob, not the documented `Error(...)`. **OPEN
  and deliberately not attributed:** the probe used WETH9, whose bare `require` emits no revert data
  at all, so `data=null` may be the contract's fault rather than the API's. `MockRewardDistributor`
  uses custom errors and should decode better. Re-measure at CVY-003 before concluding anything —
  CVY-011's veto evidence quality depends on the answer.

**Falsifiability.** Six mutations, each caught: removing `expectedStatuses:[400]` (2 fail); moving the
coded-run-error check after the status rules (6 fail); swapping the two 409s (2 fail); dropping
`attempt` from the idempotency key (3 fail); treating a 0 poll-hint as absent (1 fail); short-circuiting
the poll on terminality alone (1 fail). All reverted, 114 green.

**D-019 — acceptance criterion substituted, not met.** CVY-004 names a `fund`-before-`setRoot` call
returning `wouldRevert:true`. `MockRewardDistributor` is not deployed (that is CVY-003), so the veto
path was proven with a different genuinely-reverting call: WETH9 `withdraw` of more than the wallet
holds. Nothing is staged — the contract legitimately rejects it — but this is a substitution of the
named revert source and is recorded as such rather than ticked off. The named case must run at CVY-003.

Decisions D-016…D-020. Files: `packages/kh-client/src/{types,errors,idempotency,client,contractCall,status,checkAndExecute,index}.ts`,
`packages/kh-client/test/{errors.classify,contractCall.simulate.wouldRevert,contractCall.write.executionId,status.pollHint,idempotency.key}.test.ts`,
`packages/kh-client/test/vcr/*.json`, `packages/kh-client/README.md`, `.prettierignore`,
`docs/{KNOWN_GAPS,DECISIONS,TESTING,IMPLEMENTATION_STATUS,WORKLOG}.md`

**Next: CVY-003**, now genuinely unblocked — credentials present, write path proven.
