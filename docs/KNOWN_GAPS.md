# Known Gaps

Friction, API drift, and unverified surfaces. **Gaps are recorded here and handled with the
documented fallback — never resolved by redesigning the architecture.** If the architecture and the
blueprint appear to conflict, the architecture wins and the friction is logged here.

Status values: `OPEN` (no mitigation yet) · `MITIGATED` (handled in code) · `ACCEPTED` (deliberate,
no further action) · `CUT` (feature removed per the cut order) · `CLOSED` (no longer applicable).

## Gap register

| ID   | Description                                                                                                                                                                                                                                                                                                                          | Impact                                                                                                                                                                                                               | Fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| G-01 | Live KH docs use `chainId`; frozen spec used `network` (deprecated)                                                                                                                                                                                                                                                                  | write may break if only `network` sent                                                                                                                                                                               | send both chainId+network                                                                                                                                                                                                                                                                                                                                                                                                                                                   | MITIGATED |
| G-02 | Writes execute synchronously (202 completed), not async pending                                                                                                                                                                                                                                                                      | poll may be redundant                                                                                                                                                                                                | short-circuit poll on terminal POST                                                                                                                                                                                                                                                                                                                                                                                                                                         | MITIGATED |
| G-03 | Daily cap returns 403 not 422                                                                                                                                                                                                                                                                                                        | error classify                                                                                                                                                                                                       | treat 403(cap)+422(wallet) as fatal-to-run                                                                                                                                                                                                                                                                                                                                                                                                                                  | MITIGATED |
| G-04 | No live ETH price oracle (would be load-bearing)                                                                                                                                                                                                                                                                                     | gas→USDC approx                                                                                                                                                                                                      | freeze CONVOY_ETH_USD per run                                                                                                                                                                                                                                                                                                                                                                                                                                               | ACCEPTED  |
| G-05 | CLI has no --simulate/--value; ABI flag is --abi-file                                                                                                                                                                                                                                                                                | backup path limited                                                                                                                                                                                                  | simulate only via REST; CLI for writes                                                                                                                                                                                                                                                                                                                                                                                                                                      | ACCEPTED  |
| G-06 | @keeperhub/wallet x402 surface unverified in available docs                                                                                                                                                                                                                                                                          | x402 leg risk                                                                                                                                                                                                        | cut to gas-only budget (cut #1)                                                                                                                                                                                                                                                                                                                                                                                                                                             | OPEN      |
| G-07 | Product Discovery §8/§18 describes Convoy owning KeeperHub workflows (`create_workflow`, `execute_workflow`, `call_workflow`); Architecture §3 explicitly **omits** Workflow Builder and uses direct execution only                                                                                                                  | choosing the wrong surface would route writes through `call_workflow`, which returns unsigned calldata and bypasses the entire reliability stack                                                                     | **Architecture wins.** Direct-execution REST only; `call_workflow` is never used for a write; the owned-workflow variant stays P2/omitted                                                                                                                                                                                                                                                                                                                                   | ACCEPTED  |
| G-08 | Gas-sponsorship chain coverage conflicts between sources: DoraHacks page says Ethereum mainnet only; Product Discovery §Key Findings cites KH docs covering Ethereum/Base/Polygon/Arbitrum                                                                                                                                           | a demo depending on sponsorship could break; sponsorship is also void on private routes                                                                                                                              | **Never load-bearing.** The org wallet is self-funded with a few dollars of Base ETH; sponsorship is never claimed in the demo or the honesty table                                                                                                                                                                                                                                                                                                                         | ACCEPTED  |
| G-09 | Product Discovery §10/§11 specifies a WebSocket feed and `run_items`/`payments`/`audit_export` tables; Architecture §5 specifies SSE and the `runs`/`items`/`attempts`/`events`/`manifests` schema                                                                                                                                   | building the wrong transport or schema would desync the timeline, the audit trail and the manifest                                                                                                                   | **Architecture wins.** SSE with `events.id` replay (blueprint A6) and the five frozen tables                                                                                                                                                                                                                                                                                                                                                                                | ACCEPTED  |
| G-10 | `ConvoyRegistry.AlreadySealed()` is declared in the frozen source but is unreachable — `openRun` guards on `state != State.None`, so reopening a **sealed** run reverts `AlreadyOpen()`                                                                                                                                              | a `revertReason` of `AlreadyOpen()` where a reader would expect `AlreadySealed()`; the Critic must not key on the latter                                                                                             | **Not reconciled.** Ship the six errors exactly as frozen; a unit test pins the actual behaviour; Critic keys on `AlreadyOpen()`                                                                                                                                                                                                                                                                                                                                            | ACCEPTED  |
| G-11 | `commitAction` increments `uint32 committedCount` inside `unchecked`                                                                                                                                                                                                                                                                 | wraps after 2^32 commits in one run                                                                                                                                                                                  | **Not reconciled.** Frozen source; unreachable at any real batch size (demo batch is 12). No guard added                                                                                                                                                                                                                                                                                                                                                                    | ACCEPTED  |
| G-12 | Blueprint A4 says the `payloadHash` helper lives "in `ConvoyRegistry`"; the frozen Architecture §8 source contains no such function, and CVY-001 forbids additions                                                                                                                                                                   | adding a helper to the registry would break "no additions" and change the deployed surface                                                                                                                           | **Architecture wins.** No helper in the registry; the Solidity side of the parity fixture lives in `script/DumpPayloadHashFixtures.s.sol` (CVY-002)                                                                                                                                                                                                                                                                                                                         | ACCEPTED  |
| G-13 | `foundry.toml` freezes `[invariant] fail_on_revert = false`, so reverting fuzz calls are silently dropped — a handler that rejects nearly every call still reports 1000 green runs                                                                                                                                                   | green invariants could be evidence of nothing                                                                                                                                                                        | Handler wraps every call in try/catch, records accepted vs rejected counters, asserts the campaign was non-empty, plus a deterministic reachability test                                                                                                                                                                                                                                                                                                                    | MITIGATED |
| G-14 | A ghost variable assigned from the contract under test mirrors it, so the invariant comparing the two passes even on a broken contract                                                                                                                                                                                               | a green invariant that cannot fail is worse than none, because it is trusted                                                                                                                                         | Ghost counters are incremented by the handler, never assigned from a registry read; falsifiability proven by a `+= 1` → `+= 2` mutation of `committedCount` (see D-011)                                                                                                                                                                                                                                                                                                     | MITIGATED |
| G-15 | Compiling `Deploy.s.sol` emits `packages/contracts/out/Deploy.s.sol/Deploy.json`, which contains the string `PRIVATE_KEY` and tripped the "no private key" grep-guard                                                                                                                                                                | CI unaffected (that job checks out a clean tree and `out/` is gitignored), but the guards are meant to be run locally by reviewers, where they went red on a correct repo                                            | Guards 1, 3 and 4 gained `--exclude-dir=out --exclude-dir=dist --exclude-dir=node_modules`; mirrored in `.convoy/checklists/review.md`. The guard's scope is unchanged — only build output is excluded                                                                                                                                                                                                                                                                      | MITIGATED |
| G-16 | `packages/kh-client/tsconfig.json` includes only `src/**/*.ts`, so `pnpm -r typecheck` does not typecheck `test/`                                                                                                                                                                                                                    | a type error in a test file is caught by vitest and eslint, but not by the typecheck gate                                                                                                                            | **Accepted, CVY-000 convention.** Not widened at CVY-002 — the parity test compiles under vitest and lints clean. Revisit only if a test-only type error ever escapes                                                                                                                                                                                                                                                                                                       | ACCEPTED  |
| G-17 | **x402 is Base-mainnet-only.** The agentic wallet's Turnkey allowlist covers Base 8453 USDC and Tempo USDC.e. There is no Base Sepolia path for the payment leg                                                                                                                                                                      | CVY-017 cannot run on the development chain                                                                                                                                                                          | Cut to a gas-only budget (cut order #1), or run a single sub-dollar x402 payment on Base mainnet independently of execution                                                                                                                                                                                                                                                                                                                                                 | OPEN      |
| G-18 | **Budget meter is notional, and sponsorship is a metered allowance that expires.** The gas consumed and the fee in wei are real; the USD price is frozen and testnet gas has no market value. KeeperHub's ERC-4337 paymaster covers ~$1/month on a free account; once exhausted **every write is charged to the org Turnkey wallet** | budget figures are notional; the wallet's spending is not a fixed property but a function of an allowance that runs out mid-run                                                                                      | Disclose the two figures separately: **gas consumed** (always real, drains the budget) and **wallet debited** (only where `sponsored:false`). Measured in DEC-004, amended by DEC-006, mechanism supplied by **DEC-008**, implemented by **DEC-010**                                                                                                                                                                                                                        | ACCEPTED  |
| G-19 | DEC-001 residue: chain references outside the amendment's enumerated file list still say Base mainnet / 8453 / `0x2105`                                                                                                                                                                                                              | `.convoy/playbooks/release.md` is the authoritative operational sequence and its step 2 deploys to mainnet — a session following it literally does the wrong-chain deploy                                            | **Tracked, not swept.** DEC-001 enumerated its files deliberately; DECISIONS.md DEC-001 records the supersession. **Swept 2026-08-03.** Regeneration command + annotated survivor verdicts in the detail section below                                                                                                                                                                                                                                                      | CLOSED    |
| G-20 | `revertReason` never names a custom error — the API says `execution reverted (unknown custom error)`, not the documented `Error(...)`                                                                                                                                                                                                | the Critic keys on `revertReason`; an unnamed error is far weaker veto evidence, and CVY-011 depends on it                                                                                                           | **Resolved at CVY-003, better than feared.** The blob carries `data="0x1c8b6259"` — the 4-byte selector, fully recoverable. `SimulateResult.revertSelector` extracts it; CVY-011 maps selector → name from the ABI                                                                                                                                                                                                                                                          | MITIGATED |
| G-21 | A would-revert simulate answers on **HTTP 400** with `success:false` and `wouldRevert:true` — a successful simulate reported on an error status                                                                                                                                                                                      | classifying that 400 as an API error turns every Critic veto into a hard failure and removes the veto mechanism entirely                                                                                             | 400 is declared an expected status for simulate and the revert is returned as data. A 400 **without** a `wouldRevert` field still throws, so a validation error cannot masquerade as "would not revert"                                                                                                                                                                                                                                                                     | MITIGATED |
| G-22 | An unsupported chain returns **HTTP 500 with an empty body**, not a 4xx validation error                                                                                                                                                                                                                                             | 5xx is classified transient, so a permanent configuration error would be retried forever                                                                                                                             | `KhClient` validates `chainId` against `SUPPORTED_CHAIN_IDS` at construction, before any request is sent. The 500 path stays transient for genuine server faults                                                                                                                                                                                                                                                                                                            | MITIGATED |
| G-23 | A synchronous write returns `202 {status:"completed"}` with **no** `transactionHash`; the hash appears only on `GET /status`                                                                                                                                                                                                         | the G-02 mitigation ("short-circuit the poll on a terminal POST") would discard the transaction hash — the field the manifest, the honesty table and the Basescan link all need                                      | `pollUntilTerminal` short-circuits only when the write is terminal **and** already carries a hash; otherwise it polls. Found by the CVY-004 live smoke, not by reading docs                                                                                                                                                                                                                                                                                                 | MITIGATED |
| G-24 | A KeeperHub-executed transaction's receipt `to` is the sponsoring relay (`0x5af5194b…7f07d`), not the target contract, and `from` is a relay EOA, not the org wallet                                                                                                                                                                 | reconciling the manifest's onchain leg by `to == CONVOY_REGISTRY_ADDR` or `from == org wallet` would report a false mismatch on every single item                                                                    | **MITIGATED at CVY-012.** Read logs with `address=CONVOY_REGISTRY_ADDR`, match `RunOpened.operator` to storage, and reconcile `ActionCommitted` by runId/idx/payloadHash/txHash. Receipt `to`/`from` are never used                                                                                                                                                                                                                                                         | MITIGATED |
| G-25 | The KeeperHub Claude Code plugin's authenticated tool list was unmeasured — `/plugin` and `/keeperhub:login` need a human and a browser                                                                                                                                                                                              | criterion 2 names MCP, so the plugin is a judged surface                                                                                                                                                             | **Closed 2026-08-04.** Operator installed and authenticated it; measured live and diffed against the manifest in `.convoy/mcp/README.md`. It reaches the same `/mcp` endpoint and adds no execution capability Bearer auth lacks                                                                                                                                                                                                                                            | CLOSED    |
| G-26 | BullMQ re-picks a stalled job after ~30s (`stalledInterval`). The re-picked job re-runs the handler, which for an EXECUTE job means re-issuing a write that may already be in flight or already landed                                                                                                                               | a double submission on chain — real gas, duplicate state — from a crash-resume path that believed it was safe                                                                                                        | **Mitigated in code and live-proven at CVY-015.** Attempts are prepared before submission; the execution ID is persisted before polling. A re-picked job polls that ID, or reissues only the same persisted phase-folded key when no ID was durably recorded. Deterministic transport and the real Base Sepolia SIGKILL/restart proof record one broadcast/hash/event. Three legacy zero-length `bytea` test artifacts are excluded from valid 32-byte duplicate-hash proof | MITIGATED |
| G-27 | BullMQ 6 rejects a custom job id containing **more than two colons** (`Custom Id cannot contain :`). The frozen scheme `runId:phase:itemIdx` spends exactly both                                                                                                                                                                     | any future extension of the job id — a retry counter, a shard, a version — silently breaks every enqueue if it adds a third colon                                                                                    | Retry ids append `#<attempt>` instead. Measured, not assumed: `a:b:0` accepted, `a:b:0:1` rejected, `a:b:0#1` accepted. `buildJobId` rejects a `runId` containing `:` or `#` so the budget cannot be overspent from the other end                                                                                                                                                                                                                                           | MITIGATED |
| G-28 | KeeperHub's status response omits the OP-stack **L1 data fee** entirely, and its `gasUsedWei` field does not mean what its name says (see **G-31**, which supersedes this row's units-only reading)                                                                                                                                  | dropping the L1 fee understates cost ~2.9%; misreading the units/wei field understates or overstates it ~6.2 million×                                                                                                | **Re-mitigated at DEC-010.** The CVY-007 mitigation was documented but not wired — `composeGasFeeWei` was never called with `l1FeeWei` in the live path, so `l1FeeIncluded` was always false. Accounting now composes the fee from `eth_getTransactionReceipt` itself                                                                                                                                                                                                       | MITIGATED |
| G-29 | The frozen Idempotency-Key `<runId>:<idx>:<attempt>` assumes one write per item, but a run makes **2 + 2K** writes (openRun, K× commitAction, K× item write, sealRun). `openRun` and item 0's write both key to `<run>:0:0`                                                                                                          | KeeperHub rejects the second as `idempotency_conflict` → the item is FAILED and never retried. Measured: the first CVY-008 run lost item 0 to exactly this                                                           | The phase is folded into the runId component — `<runId>-<phase>:<idx>:<attempt>` — preserving the frozen three-part shape. `-` and not `:`, which `buildIdempotencyKey` rejects (G-27)                                                                                                                                                                                                                                                                                      | MITIGATED |
| G-30 | **Demo-narration risk.** §15 attributes nonce serialization to "one wallet, one sequential nonce" — the org Turnkey wallet. Measured, the serializing nonce belongs to a KeeperHub **relay EOA**; `from` on Basescan is not the org wallet                                                                                           | a judge opening any transaction sees a `from` the narration does not mention. Serialization itself is real and backup path d survives; the **attribution** is the overclaim                                          | **Closed 2026-08-04 by DEC-009.** The approved claim credits serialization to KeeperHub and drops the wallet attribution: "Convoy submits concurrently; KeeperHub serializes onto a single sequential nonce." Every clause measured; the fanout table is the README artifact                                                                                                                                                                                                | CLOSED    |
| G-31 | **`gasUsedWei` is polymorphic.** It carries gas **UNITS** when `sponsored:true` and the **L2 fee in wei** when `sponsored:false`. G-28 recorded only the first, having measured only sponsored transactions                                                                                                                          | reading an unsponsored record as units and multiplying by the gas price overstates the fee **6,000,000×** — the same error as G-28, in the opposite direction and on the branch that actually costs the wallet money | `decodeReportedGas` populates `gasUsedUnits` **or** `gasFeeWeiL2`, never both, and **neither** when `sponsored` is absent. Accounting reads the chain receipt regardless; KeeperHub's figure is corroboration. Measured on 3 transactions against receipts (DEC-010)                                                                                                                                                                                                        | MITIGATED |
| G-32 | `packages/db/test/schema.migrate.test.ts` "the five frozen tables exist" intermittently times out or cannot connect while the database-backed workspace suites are running                                                                                                                                                           | a flaky gate is a gate nobody trusts; worse, it trains a reader to rerun until green, which is how a real failure gets waved through                                                                                 | **Still recorded, not fixed.** CVY-GATE2 reproduced a first-query timeout in the shared workspace run and a first-create connection failure in the worker run; isolated suites on a freshly restarted user-owned cluster passed. The resource/socket boundary remains unroot-caused                                                                                                                                                                                         | OPEN      |
| G-33 | **All four BullMQ phase handlers were skeletons**; the live driver was `runBatch`, which called the orchestrator directly                                                                                                                                                                                                            | the queue path — retries, stalled-job re-pick, concurrency, SIGTERM drain — exercised no real run, so crash-resume had nothing to resume                                                                             | **Partially mitigated at CVY-015.** The production enqueue is one deduplicated plan job, every phase handler delegates to the same resumable lifecycle, and a real queue-backed SIGKILL/restart acceptance completed successfully. Plain-language run creation and browser/API-to-queue evidence remain open under G-43                                                                                                                                                     | OPEN      |
| G-34 | The Critic could not compare an onchain amount against evidence without being told the token's decimal convention. First live measurement produced a **false veto** on `fund(75000000)` against evidence reading "75.000000 USDC" — read as 75,000,000 vs 75                                                                         | a false veto stops a legitimate release, which is the expensive error and the one the 5/5 acceptance bar exists to prevent                                                                                           | **MITIGATED at CVY-011.** The fixed instruction now states the base-unit convention and that a factor of exactly 1,000,000 is the convention rather than a discrepancy. Re-measured: 0 false vetoes. The rule is general — it names no fixture amount                                                                                                                                                                                                                       | MITIGATED |
| G-35 | `executeItem` recorded a COMMIT attempt and advanced `SIMULATED → COMMITTED` without checking that `commitAction` finished `completed` with a transaction hash; it then submitted the item write anyway                                                                                                                              | an item write could land without its registry commitment, violating the execution ordering claim                                                                                                                     | **Mitigated at CVY-013.** A completed+hash guard now terminates the item before any target call; a worker test pins the failed-commit path.                                                                                                                                                                                                                                                                                                                                 | MITIGATED |
| G-36 | The CVY-012 card names the Keeper Runs audit trail in addition to `GET /api/execute/{id}/status`, but the verified KeeperHub facts and typed client contain no authenticated audit-trail REST endpoint                                                                                                                               | claiming that source would invent a capability; the current KeeperHub column is independently refreshed from the direct-execution status endpoint only                                                               | **Disclose, do not invent.** Export the status response fields and ledger attempts; verify a real Keeper Runs API/tool surface before adding it. The three-way row remains status ↔ registry ↔ ledger                                                                                                                                                                                                                                                                       | OPEN      |
| G-37 | `CVY-GATE2` depends on CVY-009 and CVY-013, but the status file previously placed the gate immediately after CVY-012 and listed CVY-013 after the gate; CVY-009 was still TODO even though CVY-012 declared it a dependency                                                                                                          | following the status table literally makes the hard gate impossible: it requires a refresh-proof timeline and DAG that have not shipped                                                                              | **Status ordering corrected at CVY-012; CVY-009 is now complete.** CVY-013 remains the only feature dependency before GATE 2. If time forces the frozen cut order, apply cut #2 explicitly and record the gate decision                                                                                                                                                                                                                                                     | MITIGATED |
| G-38 | Live check-and-execute accepts the documented flat request, but requires `condition.value` as a string and returns the verdict under `conditionResult`; the previous wrapper sent nested `check`/`execute` fields and required an executionId even when the condition was unmet                                                      | the dependency gate was unusable: the API rejected the request, and a legitimate no-write answer would have been treated as a failure                                                                                | **Mitigated at CVY-013.** The wrapper sends the measured flat REST shape, parses met and unmet responses, and requires an executionId only when `executed:true`.                                                                                                                                                                                                                                                                                                            | MITIGATED |
| G-39 | `next build` and `next dev` share `.next`. Review confirmed that a stale dev server broke after a build rewrote the directory: the run page lost a React Flow vendor chunk; the earlier build symptom was missing `/_document`                                                                                                       | concurrent sessions can break either the build or live demo even when source is correct                                                                                                                              | **Cause confirmed; enforcement open.** Failing trees are preserved under `/tmp/convoy-web-next-*g39*`. Stop dev before build and move `.next` aside between modes. Clean build and browser E2E pass; enforced isolation needs a scoped corrective task                                                                                                                                                                                                                      | OPEN      |
| G-40 | GATE 2 at the default execution fanout of 4 produced two real KeeperHub wallet `InvalidNonce()` reverts; the same 12-item batch completed at the existing `fanout=1` option. Convoy did not set a nonce                                                                                                                              | the full demo is not stable at the default fanout even though KeeperHub is expected to serialize submissions                                                                                                         | **Operational constraint:** run the full demo with `fanout=1`; preserve the default in code until the KeeperHub serialization failure is investigated. The failed and serial runs remain separate real evidence                                                                                                                                                                                                                                                             | OPEN      |
| G-41 | The configured Base Sepolia RPC free tier accepts `eth_getLogs` over at most ten blocks; the manifest exporter requested the full open-to-seal range                                                                                                                                                                                 | the registry source is unavailable for the 12-item export, so all rows are honestly amber even though direct post-run storage reads agree                                                                            | Keep the amber verdict and disclose it. Use direct storage reads as separate corroboration; chunked log retrieval needs a scoped manifest correction                                                                                                                                                                                                                                                                                                                        | OPEN      |
| G-42 | The raw viem/provider error stored in the manifest includes the complete configured RPC URL, whose path contains the provider credential                                                                                                                                                                                             | raw manifest JSON, the registry error cells, copied/downloaded JSON and unmasked screenshots can disclose the RPC credential                                                                                         | Do not distribute the raw GATE 2 manifest or unmasked manifest screenshot. Mask browser evidence and rotate the exposed provider credential; sanitize provider errors in a scoped security correction                                                                                                                                                                                                                                                                       | OPEN      |
| G-43 | The GATE 2 card named `POST /api/runs`, but the route returned 501; the named fixture still does not exist                                                                                                                                                                                                                           | the documented operator entrypoint could not start the queue-backed run path                                                                                                                                         | **PARTIALLY MITIGATED at CVY-015.** POST `/api/runs` validates an existing run ID and enqueues the one production lifecycle with the worker retry/backoff policy. The route still is not the documented plain-language run-creation surface, and live browser submission remains future evidence                                                                                                                                                                            | OPEN      |

## Detail

### G-01 — `chainId` vs `network`

Live KeeperHub docs (July 2026) name the request field `chainId`; `network` is deprecated but still
accepted. The frozen spec used `network`. **Mitigation:** `packages/kh-client` sends **both** fields
on every write and simulate. Lands in CVY-004. Architecture unchanged.

### G-02 — synchronous execution

The frozen state machine assumed async polling (`pending → running → completed`). Live docs state
that `contract-call` executes **synchronously**, returning HTTP 202 with
`{executionId, status:"completed"|"failed"}`. **Mitigation:** the EXECUTE phase treats the POST
response as possibly-terminal and short-circuits the status poll when it is; otherwise it polls
`/status`. The guard is untouched — `SUBMITTED → LANDED` still requires `completed` **and** a
non-null `transactionHash`. Lands in CVY-004 and CVY-008.

### G-03 — spending cap status code

Frozen spec expected `422 SPENDING_CAP`; live docs return `403 "Daily spending cap exceeded"`.
**Mitigation:** classify **both** 403 (cap) and 422 (wallet not configured) as fatal-to-run. Lands in
CVY-004 and CVY-008.

### G-04 — no ETH price oracle

A live price feed on the reliability path would be a load-bearing external dependency, which the
architecture forbids. **Accepted:** `runEthUsd` is frozen into the `runs` row at open from
`CONVOY_ETH_USD`, and `gas_used_usdc = (Number(gasUsedWei)/1e18) * runEthUsd`. The manifest
discloses the rate used, so the accounting is honest and reproducible.

### G-05 — CLI flag surface

The `kh` CLI has **no** `--simulate` and **no** `--value`; the ABI flag is `--abi-file`, not `--abi`.
**Accepted:** the backup demo path uses only verified flags
(`kh ex cc --chain --contract --method --args --wait`); simulation is REST-only. Affects
`.convoy/playbooks/demo.md` backup path a.

### G-06 — `@keeperhub/wallet` x402 surface **(OPEN)**

The install, configuration, and API surface of the x402 agentic wallet package is not confirmed by
the available documentation. **Do not invent the SDK signature.** If it cannot be verified against
real documentation or a real response at CVY-017, apply **cut order #1** — a gas-only budget — and
update this row to `CUT`. This gap must not block any P0 milestone.

### G-07 — workflow surface conflict

The Product Discovery Report describes Convoy creating and executing KeeperHub _workflows_; the
frozen Architecture (§3 omissions, §13 kill list) uses **direct execution only** and explicitly rules
out the Workflow Builder. The architecture is the protocol source of truth and wins. Convoy uses the
REST vocabulary (`contractAddress`/`functionName`/`functionArgs`/`abi`), never `abiFunction`, and
never `call_workflow` for a write — a write returns unsigned calldata to the caller, which would
bypass nonce management, simulation, retries, and multi-RPC failover. The owned-workflow variant
remains P2/omitted.

### G-08 — gas sponsorship conflict

Sources disagree on which chains gas sponsorship covers. **Resolution:** Convoy never depends on it.
The org wallet is funded directly, sponsorship is never claimed in the demo narration or the honesty
table, and private-routed transactions are not sponsored regardless.

### G-09 — transport and schema conflict

The Product Discovery Report mentions a WebSocket feed and an earlier table layout. The frozen
Architecture specifies SSE (with `events.id` as the SSE event id and `Last-Event-ID` replay) and the
five-table schema. The architecture wins on both.

### G-15 — build output trips the private-key grep-guard

`forge build` compiles `script/Deploy.s.sol` and writes `packages/contracts/out/Deploy.s.sol/Deploy.json`,
whose ABI/metadata contains the literal string `PRIVATE_KEY` (from `vm.envUint("DEPLOYER_PRIVATE_KEY")`).
The guard greps `apps packages services scripts` and excludes only `packages/contracts/script/`, so it
reported a hit on a completely correct repository.

**CI was never affected:** the `invariants` job runs on a fresh `actions/checkout` with no build step,
and `packages/contracts/out/` is gitignored. The failure is local-only — but the guards exist to be
run by a human reviewer (they are mirrored verbatim in `.convoy/checklists/review.md` precisely so
they can be copy-pasted into a terminal), and a guard that goes red on correct code is one reviewers
learn to skip. **Mitigation:** guards 1, 3 and 4 exclude `out/`, `dist/` and `node_modules/`. The
guards' semantics are unchanged; only generated, uncommitted output is skipped. The nonce guard
(guard 2) already scoped itself to specific `src` directories and needed no change.

### G-16 — test files are outside the typecheck gate

`packages/kh-client/tsconfig.json` sets `rootDir: "src"` and `include: ["src/**/*.ts"]`, so
`pnpm -r typecheck` never sees `test/`. Widening `include` would require changing `rootDir`, which
changes the `dist/` layout and the package's published entry points.

**Accepted.** This is the CVY-000 convention across every package, not something CVY-002 introduced,
and CVY-002 is not the milestone to change a build layout. The parity test is still type-checked in
practice — vitest compiles it and `eslint src test` lints it, and both are green gates. Revisit only
if a type error in a test file ever escapes to CI.

### G-20 — `revertReason` never names a custom error, but does carry its selector **(MITIGATED)**

`CLAUDE.md` documents `400 {wouldRevert:true, revertReason:"Error(...)"}`. The live field is an
ethers v6 diagnostic string instead.

**Measured twice, and the second measurement changed the conclusion.**

At CVY-004, against WETH9, the blob read `missing revert data … data=null` — which looked like the
API failing to decode. It was not: WETH9's `withdraw` uses a bare `require`, which emits **no revert
data at all**. That was the contract's doing.

At CVY-003, against the deployed `MockRewardDistributor` (custom errors, 4-byte selectors):

```
Simulation reverted: execution reverted (unknown custom error)
(action="estimateGas", data="0x1c8b6259", reason=null, …, code=CALL_EXCEPTION, version=6.16.0)
```

`0x1c8b6259` is exactly `RootNotSet()` — confirmed by `cast decode-error 0x1c8b6259`. The API does
not _name_ the error, but it returns the revert data, so **the error is fully recoverable**.

**Mitigation:** `SimulateResult.revertSelector` extracts the selector once in the client rather than
leaving every consumer to re-parse a diagnostic blob. CVY-011 maps selector → error name from the ABI
it already holds, so the Critic's veto evidence reads `RootNotSet()` rather than "unknown custom
error".

**Do not hardcode selectors.** The first attempt at this measurement used a hand-written constant
that was wrong, and it misreported the verdict as "no selector present". Derive them —
`toFunctionSelector()` in TypeScript, `cast sig` at the terminal.

### G-21 — a successful simulate arrives on HTTP 400

The would-revert verdict is delivered on an error status with `success:false`:

```jsonc
{ "success": false, "status": "simulated", "wouldRevert": true, "revertReason": "…" }
```

The verdict is `wouldRevert`, **not** `success`. **Mitigated:** `simulateContractCall` declares 400
an expected status and returns the revert as data. The inverse mistake is guarded too — a 400 with no
`wouldRevert` field throws, because reporting it as "would not revert" would let the Critic approve an
item the API never evaluated. Both directions are pinned by tests against the recorded tape, and the
mitigation is mutation-tested: removing `expectedStatuses: [400]` fails two tests.

### G-22 — an unsupported chain returns 500 with an empty body

`chainId:"999999"` returns **HTTP 500** and a zero-length body — no validation error, no message.
Since 5xx is classified transient, a permanent misconfiguration would be retried until the attempt
budget ran out. **Mitigated:** `KhClient` validates `chainId` against `SUPPORTED_CHAIN_IDS` in its
constructor, so an unsupported chain fails locally and is never sent. Genuine 5xx faults keep their
transient classification.

This also retroactively strengthens the DEC-001 premise probe: had 84532 been unsupported, the answer
would have been a 500 with an empty body, which is unmistakably different from the 200 it returned.

### G-23 — the synchronous write does not carry the transaction hash

Found by the CVY-004 live smoke, not by reading documentation. A real write returned:

```jsonc
// POST 202
{ "executionId": "415udzxz33omkbg8okz17", "status": "completed" } // no transactionHash
```

The hash exists only on `GET /api/execute/{id}/status`, alongside `gasUsedWei`, `retryCount` and
`sponsored`. Gap G-02's mitigation is "short-circuit the poll when the POST response is already
terminal" — applied literally, that **discards the transaction hash**, which is the field the manifest's
KeeperHub leg, the README honesty table and the Basescan link all depend on.

**Mitigated:** `pollUntilTerminal` short-circuits only when the write is terminal **and** already
carries a hash. This is what supplies the second half of the architecture's `SUBMITTED → LANDED`
guard (`completed` **and** a non-null `transactionHash`). Falsifiability: reverting the condition to
terminality alone fails the pinning test.

### G-24 — the receipt's `to` is the relay, not the registry **(OPEN)**

Measured on the CVY-003 first transaction
(`0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd`):

| Field                | Value                                        | Expected naively          |
| -------------------- | -------------------------------------------- | ------------------------- |
| receipt `to`         | `0x5af5194b4b0909eb978e3cf1e25333852277f07d` | the ConvoyRegistry        |
| receipt `from`       | `0x6331eb4571de9284f7e9ead98ac7b0661a091e99` | the org Turnkey wallet    |
| log `operator` topic | `0x65f5afd3…90da6`                           | the org Turnkey wallet ✅ |

KeeperHub routes sponsored transactions through a relay (`sponsored: true` on the status response),
so neither `to` nor `from` is what a reader expects. **The org wallet is still the effective sender**
— provable from the `RunOpened` indexed `operator` topic and from `runs(runId).operator` in storage,
both of which read `0x65f5…90da6`.

**Impact lands at CVY-012.** The manifest's three-way reconciliation compares KeeperHub's status
against `ConvoyRegistry` events read from chain. Matching on `to == CONVOY_REGISTRY_ADDR` would mark
**every** item as a divergence — an amber row on a perfectly correct run, which is exactly the kind of
false signal that trains a reader to ignore the reconciliation. Match on the log's emitting address
and the `operator` topic instead.

### G-25 — the KeeperHub Claude Code plugin **(CLOSED — installed and measured)**

`github.com/KeeperHub/claude-plugins` exists (HTTP 200) and looks entirely compatible — marketplace
`keeperhub-plugins`, plugin `keeperhub` v4.0.0, MIT, 2 slash commands and 5 skills. **Nothing about it
is unavailable or broken.**

It is not installed for a mechanical reason: `/plugin marketplace add`, `/plugin install` and
`/keeperhub:login` are **Claude Code REPL commands typed by a human**, not shell commands an agent
session can execute, and the login step opens a browser for OAuth consent. This is a limitation of
who can type, not of the plugin.

**What was measured** (by cloning the repo at `d3ba890` and reading the artifact, rather than
describing it from docs) is recorded in `.convoy/mcp/README.md`. **What was not measured** is the
authenticated tool list — the actual MCP tools, their schemas, and how they differ from the raw
`/mcp` surface Convoy already uses. That needs an interactive session.

**Why this blocks nothing:** the plugin's own `.mcp.json` points at
`https://app.keeperhub.com/mcp` — the same endpoint `.convoy/mcp/mcp.json` already reaches with a
`kh_` Bearer token. The plugin is an OAuth wrapper plus prompt-level skills over the same server, so
it cannot expose execution capability that Bearer auth lacks. Convoy's execution path is untouched.

**Closed 2026-08-04.** The operator installed and authenticated it. Measured live and diffed against
the manifest in `.convoy/mcp/README.md`. Three findings:

1. **The manifest cannot tell you what the server exposes.** It declares a URL; the tool list
   (`list_workflows`, `execute_contract_call`, `create_workflow`, `delete_workflow`, …) is served at
   connect time. Only connecting reveals it.
2. **Zero KeeperHub tools reach a non-interactive agent session.** `ToolSearch("+keeperhub")` from
   this repository's agent session returns no matches. The plugin extends the _interactive_ tool
   surface only — the clearest possible argument for keeping the runtime on Bearer.
3. **It adds no execution capability.** Same endpoint, same org. A different door to the same room.

The plugin is now named in the README surfaces list, because it has genuinely been used — the org
wallet integration was inspected through it, and that inspection is what settled the
`isManaged: false` question.

### G-26 — stalled-job re-pick vs. crash-resume

BullMQ marks a job stalled when its lock is not renewed within `stalledInterval` (default 30s) — a
crashed worker, a paused container, a long GC pause, or a handler blocked on a slow KeeperHub call
all qualify. The job returns to `wait` and another worker picks it up. `maxStalledCount` (default 1)
bounds how often before the job is failed outright.

**Why this is dangerous for CVY-015.** Crash-resume is the reliability centrepiece
(`killworker.noDuplicateTx.test.ts`), and the stalled-job path is precisely the mechanism it depends
on. But re-running an EXECUTE handler means re-issuing a write. If the original write already landed,
a naive re-run submits a second identical transaction.

**Why the Idempotency-Key covers it.** Every write carries
`Idempotency-Key: <runId>:<idx>:<attempt>`, per-org, 24h. The re-picked job is the _same job_: same
`runId`, same `itemIdx`, and — because the attempt number lives in `job.data` and is fixed at enqueue
(**DEC-003**) — the same `attempt`. The key is byte-identical, so KeeperHub deduplicates rather than
executing twice. The client already classifies the two 409s correctly: `idempotency_in_progress` is
transient (the original is still running — back off and re-poll), `idempotency_conflict` fails the
item (same key, different body — a Convoy bug, not something to retry into).

**The failure mode this rules out, explicitly:** deriving the attempt number at handler runtime from
a count of `attempts` rows, or from `job.attemptsMade` (which BullMQ _increments_ on stall). Either
would hand a re-picked job a fresh key and turn the safety mechanism into a double-spend.

**Mitigated in code and live-proven at CVY-015:** the attempt is prepared before
submission and KeeperHub's `executionId` is persisted before polling. A resumed/re-picked job polls
that ID first. If the process died before the ID was durably recorded, it reissues only the same
persisted attempt/key. Serializable attempt preparation makes concurrent COMMIT/EXECUTE recovery
converge on one durable row without changing the frozen schema. Completed-without-hash never becomes `LANDED`;
coded transient failures advance only under the retry cap; config reverts are terminal. The
deterministic transport and the real Base Sepolia SIGKILL/restart acceptance both prove one target
broadcast/hash/event. The literal legacy duplicate query also finds three zero-length `bytea` test
artifacts; valid 32-byte hash duplicates are zero.

### G-27 — BullMQ's custom job id has a two-colon budget

Found by an enqueue failing, not by reading documentation. BullMQ 6 validates custom job ids and
throws `Custom Id cannot contain :` past two colons. Measured directly against the library:

| Job id                            | Result       |
| --------------------------------- | ------------ |
| `a:b:0`                           | accepted     |
| `a:b:0:1`                         | **rejected** |
| `a:b:0#1`                         | accepted     |
| `a:b:0.1` / `a:b:0-1` / `a:b:0~1` | accepted     |

The frozen scheme `runId:phase:itemIdx` uses exactly the two colons available, so **the id is at its
limit as designed**. That is fine today and a trap tomorrow: the obvious way to extend it — appending
`:attempt` for a retry — fails at runtime, and only at the moment a retry is first attempted, which
is precisely when things are already going wrong.

**Mitigation:** `retryJobId` appends `#<attempt>`, and `buildJobId` rejects a `runId` containing
either `:` or `#` so the budget cannot be overspent from the other end. Any future addition to the
job id must use a non-colon separator.

### G-28 — `gasUsedWei` is gas units, and the L1 fee is missing

Two separate defects in the same number, both found by measuring rather than reading.

**Units, not wei.** `status.gasUsedWei` was `68400` on CVY-003 and `74093` on the CVY-004 smoke —
identical in both payloads to `result.gasUsed` and `result.gasUsedUnits`, and identical to the
on-chain receipt's `gasUsed`. The field is gas units wearing a wei name. The frozen formula
`(gasUsedWei / 1e18) * runEthUsd` means wei, so feeding it the field understates cost by ~6.2 million
times: **$0.00000000023 instead of $0.0014** on a real transaction. The meter would have looked
plausible and drained essentially never.

**No L1 fee.** Base is an OP-stack L2; the fee is `units × gasPriceWei` (L2) **plus** `l1Fee` (data
availability). KeeperHub returns only the first. On CVY-003 the L1 portion was 12,053,372,102 of
422,453,372,102 wei — **2.9%**.

**Mitigation.** `packages/kh-client` renames the field to `gasUsedUnits` and adds `gasPriceWei`, so
no consumer can divide units by 1e18. `services/worker/src/budget.ts` composes the real wei and
reads `l1Fee` from the receipt via `BASE_RPC_URL`; when the receipt has not been read it still
returns a figure but sets `l1FeeIncluded: false` — under-reporting is permitted only when labelled.

**Verification is anchored to the chain, not to itself:** recomputing the fee from the recorded
fields yields **422453372102 wei**, exactly the amount that left the sponsoring relay across that
block. See DEC-005.

### G-29 — the idempotency key has no phase namespace

The frozen key is `<runId>:<idx>:<attempt>` (ARCHITECTURE §5(e)), which reads as one write per item.
A run actually makes **2 + 2K** writes: `openRun`, K× `commitAction`, K× the item's own write, and
`sealRun`. With no phase component, `openRun` and item 0's write both key to `<run>:0:0`.

**Found by it happening.** The first CVY-008 acceptance run lost item 0 with
`Idempotency-Key was reused with a different request payload` — KeeperHub returning
`idempotency_conflict`, which the CVY-004 classifier correctly routed to `item-failed` with **no
retry**. The safety mechanism worked exactly as designed; the key namespacing was the bug.

**Mitigation:** the phase is folded into the runId component (`<runId>-o|c|x|s`), preserving the
frozen three-part shape rather than adding a fourth field. The separator is `-` because
`buildIdempotencyKey` rejects `:` and `#` (G-27).

### G-30 — the narration attributes the nonce to the wrong wallet **(CLOSED)**

Measured across 12 concurrently-dispatched items (DEC-006): 11 transactions came from a single
KeeperHub relay EOA `0x6331eb45…091e99` with strictly increasing nonces, one per successive block;
the 12th came from the org wallet itself. **Serialization is real** — one sequential nonce, strictly
increasing, unaffected by Convoy's dispatch width — so the reliability substrate and backup path d
both hold.

What does not hold is the attribution. §15 narrates _"one wallet, one sequential nonce"_ meaning the
org Turnkey wallet, and a judge opening any of these hashes on Basescan sees `from` = a relay
address. The honest form of the claim is that KeeperHub serializes concurrent submits on a single
sequential nonce **it manages**, which is the capability the architecture actually depends on.

**Closed 2026-08-04 by DEC-009**, which fixes the approved wording:

> Convoy submits concurrently; **KeeperHub serializes onto a single sequential nonce** — strictly
> increasing, one transaction per block, never batched — measured identical at dispatch width 4 and 12.

The claim never says who holds the nonce, because that was never the load-bearing part. What the
architecture depends on is that serialization is deterministic, and every clause above is measured.
The fanout comparison table is preserved in the README as the supporting artifact. `ARCHITECTURE.md`
§15 is frozen and still reads "one wallet"; DEC-009 supersedes it for that clause.

### G-31 — `gasUsedWei` means two different things **(MITIGATED)**

G-28 concluded that KeeperHub's `gasUsedWei` always carries gas units. That was measured on two
transactions, **both sponsored**. It does not generalise.

Measured 2026-08-04 against chain receipts (`services/worker/scripts/gasfield.mjs`), three
transactions, exact equality in every row:

| execution               | `sponsored` | `gasUsedWei`   | receipt `gasUsed` | `gasUsed × price`  | field is   |
| ----------------------- | ----------- | -------------- | ----------------- | ------------------ | ---------- |
| `pkxdn5g2cnpa2n5uu1rqk` | `true`      | `66226`        | **`66226`**       | 397356000000       | **units**  |
| `e9vdaxkipq90kvt3jqgn7` | `false`     | `275418000000` | 45903             | **`275418000000`** | **L2 wei** |
| `tgn3aigyunpl3ric2pj14` | `false`     | `275490000000` | 45915             | **`275490000000`** | **L2 wei** |

The unsponsored rows are the two transactions the org Turnkey wallet paid for. `275418000000 +
6874353887` (the receipt's `l1Fee`) `= 282292353887` — **exactly** the balance delta DEC-006 measured
independently, which is what confirms the reading rather than merely fitting it.

**Why it matters more than G-28 did.** The old reading was wrong precisely on the branch where real
money leaves the wallet. Treating `275418000000` as units and multiplying by the gas price would
report a fee of 1.65 × 10¹⁸ wei — 1.65 ETH for a 45,903-gas call.

**Mitigation.** `decodeReportedGas` populates `gasUsedUnits` **or** `gasFeeWeiL2`, never both, keyed
on `sponsored`; with no flag it populates neither and reports `ambiguous`. Accounting does not depend
on the field at all — the fee is composed from `eth_getTransactionReceipt`, and KeeperHub's numbers
are recorded beside it as corroboration.

**Read `sponsored` from the top level.** `result.sponsored` is **absent** on unsponsored records, so
reading it alone reports `undefined` — indistinguishable from "no flag" — on exactly the executions
that matter. `result.executedCall.sponsored` agreed with the top level on all three.

### G-17 — x402 is Base-mainnet-only **(OPEN)**

Recorded by DEC-001, which moved the execution chain to Base Sepolia. The agentic wallet's Turnkey
allowlist covers Base 8453 USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and Tempo USDC.e
only. There is **no Base Sepolia path** for the payment leg.

**Impact:** CVY-017 cannot run on the development chain. **Fallback:** cut to a gas-only budget (cut
order #1), or run a single sub-dollar x402 payment on Base mainnet independently of execution — the
payment leg does not have to share a chain with the execution leg.

Distinct from **G-06**, which is about the `@keeperhub/wallet` API surface being unverified. G-06 is
"we do not know the signature"; G-17 is "even with the signature, the chain is wrong." They share
cut order #1 as a fallback and should be resolved together at CVY-017, but they are not the same
gap and must not be merged.

### G-18 — the budget meter is notional, and no balance moves at all

Recorded by DEC-001, **widened at CVY-007 by DEC-004** after measuring what actually happens on chain.

| Component                                      | Real?                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Gas **units** consumed                         | **Real** — matches the receipt's `gasUsed` exactly                                 |
| Fee in **wei** (`units × gasPriceWei + l1Fee`) | **Real** — matches the relay's balance delta to the wei                            |
| USD figure                                     | **Notional** — frozen `CONVOY_ETH_USD` (G-04), and testnet gas has no market value |
| Balance movement                               | **None.** KeeperHub sponsors: the org wallet's balance does not change at all      |

The last row is the new part and the one that matters. At CVY-003 the org Turnkey wallet's balance
was identical before and after the transaction — 0 wei delta — while the sponsoring relay paid
422,453,372,102 wei. **The budget meter is a policy limit Convoy enforces on itself, not a claim on a
balance that drains.**

**Impact:** budget figures are notional. **Fallback:** none needed. **This must be disclosed**, and
the README honesty table says: _"Real gas units and a real fee in wei; USD is notional at a frozen
price; KeeperHub sponsors on 84532, so no wallet balance moves."_ Overstating this would be the one
kind of defect this project treats as unacceptable — the meter looks like money leaving an account,
and it is not.

Distinct from **G-04** (no live oracle: a design choice) and from **G-28** (the units/wei and L1-fee
drift: an API defect). G-18 is what those two mean for what Convoy may claim.

Sponsorship being active does **not** relax **G-08** — it is still never load-bearing, and the
runbook's org-wallet funding threshold deliberately stays.

### G-19 — DEC-001 residue: unswept chain references **(CLOSED)**

DEC-001 enumerated the files it changed. References to the old chain target live outside that list
and were **deliberately not swept** — item 5 named `.convoy/` files individually, which makes the
omissions read as intentional rather than overlooked.

**This list is not exhaustive and is not hand-maintained.** Regenerate it; a hand-counted register
entry is exactly the kind of claim that quietly goes stale:

```bash
grep -rn "8453\|0x2105\|Base mainnet" --include='*.md' README.md docs .convoy \
  | grep -vE "ARCHITECTURE|PRODUCT_DISCOVERY|IMPLEMENTATION_BLUEPRINT|docs/milestones/|DECISIONS|KNOWN_GAPS|WORKLOG"
```

Not every hit is stale — DEC-001 keeps 8453 as the optional CVY-019 target, so the mainnet steps in
`CVY-019`, `CVY-003`'s fallback, and `DEPLOYMENT.md`'s mainnet rows are **correct**. Triage the
output; the ones below are the ones that contradict DEC-001, worst first:

| Reference                                     | Why it is dangerous                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.convoy/playbooks/release.md:17,25,27`       | **Worst.** `DEPLOYMENT.md:3` names this the authoritative operational sequence, and its step 2 is "Contracts — mainnet (Base 8453)". A session following it literally performs the wrong-chain deploy the `foundry.toml` remap exists to prevent |
| `.convoy/agents/principal-blockchain.md:50`   | Instructs an agent to assert `eth_chainId == 0x2105`, which is exactly what `verify-env.ts` no longer does                                                                                                                                       |
| `.convoy/agents/principal-blockchain.md:30`   | "the chain is pinned to Base **8453**"                                                                                                                                                                                                           |
| `.convoy/agents/lead-protocol-engineer.md:15` | "Base Sepolia first, then Base mainnet" — describes the superseded sequence as the plan of record                                                                                                                                                |
| `README.md:8`                                 | "Chain: **Base mainnet (8453)**" — the only externally-visible false claim; artifact rows 41–43 likewise                                                                                                                                         |
| `docs/AI_WORKFLOW.md:34`                      | "Keep the chain pinned to Base 8453."                                                                                                                                                                                                            |
| `.convoy/instructions/coding-standards.md:10` | "viem chain pinned to base (8453)"                                                                                                                                                                                                               |
| `.convoy/checklists/milestone-done.md:38`     | "The chain stays pinned to Base 8453"                                                                                                                                                                                                            |
| `.convoy/templates/pr.md:56`                  | "Chain pinned to Base 8453"                                                                                                                                                                                                                      |
| `.convoy/playbooks/demo.md:41`                | "(8453 unconditionally)"                                                                                                                                                                                                                         |
| `docs/DEPLOYMENT.md:13,21,68`                 | stage table framed as testnet-then-mainnet; env-surface row omits `BASE_MAINNET_RPC_URL`                                                                                                                                                         |
| `docs/TESTING.md:36`                          | `live` mode described as rehearsal "before any mainnet run"                                                                                                                                                                                      |

`release.md` and `principal-blockchain.md:50` were the two that caused an **action**, not just a
stale sentence.

### Resolution — swept 2026-08-03, **CLOSED**

All twelve entries above were fixed. `release.md` step 1 is now "Base Sepolia 84532 (the target
chain)" and step 2 is "Base mainnet 8453 (OPTIONAL, CVY-019 flip only)" with a skip-by-default
banner; `principal-blockchain.md:50` now asserts `Number(eth_chainId) === 84532` **numerically**,
matching `verify-env.ts` and noting that `0x14a34` contains hex letters whose case no provider
guarantees; `README.md:8` names Base Sepolia (84532), as do its three artifact rows.

**8453 survives only where it correctly names the optional CVY-019 target.** Re-running the
regeneration command returns hits by design — a zero-hit result would mean the optional path had been
deleted, not that the sweep succeeded. Every surviving line falls into one of four verdicts:

| Verdict          | Where                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sepolia-target` | the majority — lines that now correctly name 84532                                                                                                                          |
| `CVY-019-target` | `CVY-019.md:41,43,44,54`; `DEPLOYMENT.md:17,35,36,49`; `release.md:28`; `lead-protocol-engineer.md:16`; `CVY-002.md:47`; `CVY-004.md:29`; `IMPLEMENTATION_STATUS.md:37,106` |
| `allowlist`      | `DEPLOYMENT.md:54` — `Deploy.s.sol` permits 8453 **and** 84532; DEC-001 changed the target, not the supported set                                                           |
| `fallback`       | `CVY-003.md:62` — the documented fallback if a write fails on 84532                                                                                                         |
| `dual-chain-key` | `IMPLEMENTATION_STATUS.md:103` — one Etherscan V2 key covers both chains                                                                                                    |

Non-`.md` files are outside the command's `--include='*.md'` and were checked separately: `.env.example`,
`scripts/verify-env.ts`, `packages/contracts/foundry.toml` and `script/Deploy.s.sol` are all correct.

### G-32 — database-backed workspace tests remain timing-sensitive **(OPEN)**

CVY-GATE2 reproduced this gap rather than rerunning it away. With the repository database absent,
the first `pnpm -r test` failed as expected because 25 DB tests could not reach `localhost:5432`.
Against the preserved GATE2 cluster on a shared port, the workspace run reached 34/35 DB tests but
the first schema query exceeded Vitest's five-second timeout. A worker run against the same stale
process reached 94/95 and its first DB create briefly reported the server unreachable; later DB
tests in that same process passed.

The user-owned cluster was then stopped cleanly and restarted on an unused, isolated port. Without
changing test code, `@convoy/db` passed 35/35 and `@convoy/worker` passed 95/95. That rules out a
schema or CVY-013 gate regression, but it does not establish a root cause. The remaining candidate is
the test environment's process/socket/resource boundary. Both the failures and the isolated passes
must be reported until the harness is made deterministic.

### G-40 — default fanout exposed a real KeeperHub nonce failure **(OPEN)**

The first CVY-GATE2 run used the configured execution fanout of four. It reached `SEALED_PARTIAL`;
two real target transactions reverted inside the KeeperHub wallet with selector `0x756688fe`,
decoded by `cast run` as `InvalidNonce()`. Convoy submitted through KeeperHub, set no nonce and did
not stage the failure. Re-running a fresh, unused 12-item action set through the existing
`runBatch(..., { fanout: 1 })` option produced `SEALED_OK`: ten items landed and the two intended
simulate vetoes consumed zero gas.

The gate therefore passes only with a serial-fanout operational constraint. It does not establish
that the default width is stable, and the default is not silently changed in this gate.

### G-41 — RPC log-range limit makes the full manifest amber **(OPEN)**

The serial run spanned more than ten blocks. The configured free-tier Base Sepolia provider rejected
the exporter's single full-range `eth_getLogs` request and named a ten-block maximum. KeeperHub
status and Convoy's append-only ledger agree, while the registry source is unavailable, so the
canonical manifest correctly reports `amber` for all twelve rows.

Separate read-only RPC calls after the run found registry state `Sealed`, `committedCount == 10`,
commitments present for the ten landed items and absent for both vetoes. Those reads corroborate the
result but are not substituted into the manifest. A later scoped correction may chunk the log range;
GATE 2 keeps the honest amber artifact.

### G-42 — raw provider errors disclose the RPC credential **(OPEN)**

The provider error captured under the registry source contains the complete configured RPC URL. For
this provider, the URL path is the credential. The raw JSON and the first manifest screenshot are
therefore local sensitive artifacts and must not be copied into reports, commits or public evidence.

The GATE 2 browser spec masks the registry-error column in future screenshots. That does not repair
the product surface: copy/download and the rendered registry cells still carry the raw error. The
credential must be rotated, and provider errors must be sanitized in a separately authorized
security correction.

### G-43 — the documented GATE 2 start path was absent **(OPEN, partially mitigated)**

CVY-015 connects the minimum production entrypoint: `POST /api/runs` validates an already-persisted
run ID and enqueues it with the worker's attempts/backoff policy, and every BullMQ phase handler
delegates to the single resumable `runBatch`/orchestrator path. It deliberately does not invent a
second run-creation surface or the missing fixture. The 501 boundary is gone, but the architecture's
plain-language run creation and a live browser/API-to-queue proof are still absent.

### CVY-015 verification friction

The first DB package run failed because PostgreSQL was absent. An isolated local cluster then hit
the existing G-32 first-query timeout at 34/35; the clean rerun passed 35/35 without code changes.
The live acceptance passed once the runtime configuration was restored. The repository-wide
duplicate query must exclude invalid zero-length legacy `bytea` artifacts; among valid 32-byte
transaction hashes it returned zero rows.
