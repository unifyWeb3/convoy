# Known Gaps

Friction, API drift, and unverified surfaces. **Gaps are recorded here and handled with the
documented fallback — never resolved by redesigning the architecture.** If the architecture and the
blueprint appear to conflict, the architecture wins and the friction is logged here.

Status values: `OPEN` (no mitigation yet) · `MITIGATED` (handled in code) · `ACCEPTED` (deliberate,
no further action) · `CUT` (feature removed per the cut order) · `CLOSED` (no longer applicable).

## Gap register

| ID   | Description                                                                                                                                                                                                         | Impact                                                                                                                                                                    | Fallback                                                                                                                                                                                                               | Status    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| G-01 | Live KH docs use `chainId`; frozen spec used `network` (deprecated)                                                                                                                                                 | write may break if only `network` sent                                                                                                                                    | send both chainId+network                                                                                                                                                                                              | MITIGATED |
| G-02 | Writes execute synchronously (202 completed), not async pending                                                                                                                                                     | poll may be redundant                                                                                                                                                     | short-circuit poll on terminal POST                                                                                                                                                                                    | MITIGATED |
| G-03 | Daily cap returns 403 not 422                                                                                                                                                                                       | error classify                                                                                                                                                            | treat 403(cap)+422(wallet) as fatal-to-run                                                                                                                                                                             | MITIGATED |
| G-04 | No live ETH price oracle (would be load-bearing)                                                                                                                                                                    | gas→USDC approx                                                                                                                                                           | freeze CONVOY_ETH_USD per run                                                                                                                                                                                          | ACCEPTED  |
| G-05 | CLI has no --simulate/--value; ABI flag is --abi-file                                                                                                                                                               | backup path limited                                                                                                                                                       | simulate only via REST; CLI for writes                                                                                                                                                                                 | ACCEPTED  |
| G-06 | @keeperhub/wallet x402 surface unverified in available docs                                                                                                                                                         | x402 leg risk                                                                                                                                                             | cut to gas-only budget (cut #1)                                                                                                                                                                                        | OPEN      |
| G-07 | Product Discovery §8/§18 describes Convoy owning KeeperHub workflows (`create_workflow`, `execute_workflow`, `call_workflow`); Architecture §3 explicitly **omits** Workflow Builder and uses direct execution only | choosing the wrong surface would route writes through `call_workflow`, which returns unsigned calldata and bypasses the entire reliability stack                          | **Architecture wins.** Direct-execution REST only; `call_workflow` is never used for a write; the owned-workflow variant stays P2/omitted                                                                              | ACCEPTED  |
| G-08 | Gas-sponsorship chain coverage conflicts between sources: DoraHacks page says Ethereum mainnet only; Product Discovery §Key Findings cites KH docs covering Ethereum/Base/Polygon/Arbitrum                          | a demo depending on sponsorship could break; sponsorship is also void on private routes                                                                                   | **Never load-bearing.** The org wallet is self-funded with a few dollars of Base ETH; sponsorship is never claimed in the demo or the honesty table                                                                    | ACCEPTED  |
| G-09 | Product Discovery §10/§11 specifies a WebSocket feed and `run_items`/`payments`/`audit_export` tables; Architecture §5 specifies SSE and the `runs`/`items`/`attempts`/`events`/`manifests` schema                  | building the wrong transport or schema would desync the timeline, the audit trail and the manifest                                                                        | **Architecture wins.** SSE with `events.id` replay (blueprint A6) and the five frozen tables                                                                                                                           | ACCEPTED  |
| G-10 | `ConvoyRegistry.AlreadySealed()` is declared in the frozen source but is unreachable — `openRun` guards on `state != State.None`, so reopening a **sealed** run reverts `AlreadyOpen()`                             | a `revertReason` of `AlreadyOpen()` where a reader would expect `AlreadySealed()`; the Critic must not key on the latter                                                  | **Not reconciled.** Ship the six errors exactly as frozen; a unit test pins the actual behaviour; Critic keys on `AlreadyOpen()`                                                                                       | ACCEPTED  |
| G-11 | `commitAction` increments `uint32 committedCount` inside `unchecked`                                                                                                                                                | wraps after 2^32 commits in one run                                                                                                                                       | **Not reconciled.** Frozen source; unreachable at any real batch size (demo batch is 12). No guard added                                                                                                               | ACCEPTED  |
| G-12 | Blueprint A4 says the `payloadHash` helper lives "in `ConvoyRegistry`"; the frozen Architecture §8 source contains no such function, and CVY-001 forbids additions                                                  | adding a helper to the registry would break "no additions" and change the deployed surface                                                                                | **Architecture wins.** No helper in the registry; the Solidity side of the parity fixture lives in `script/DumpPayloadHashFixtures.s.sol` (CVY-002)                                                                    | ACCEPTED  |
| G-13 | `foundry.toml` freezes `[invariant] fail_on_revert = false`, so reverting fuzz calls are silently dropped — a handler that rejects nearly every call still reports 1000 green runs                                  | green invariants could be evidence of nothing                                                                                                                             | Handler wraps every call in try/catch, records accepted vs rejected counters, asserts the campaign was non-empty, plus a deterministic reachability test                                                               | MITIGATED |
| G-14 | A ghost variable assigned from the contract under test mirrors it, so the invariant comparing the two passes even on a broken contract                                                                              | a green invariant that cannot fail is worse than none, because it is trusted                                                                                              | Ghost counters are incremented by the handler, never assigned from a registry read; falsifiability proven by a `+= 1` → `+= 2` mutation of `committedCount` (see D-011)                                                | MITIGATED |
| G-15 | Compiling `Deploy.s.sol` emits `packages/contracts/out/Deploy.s.sol/Deploy.json`, which contains the string `PRIVATE_KEY` and tripped the "no private key" grep-guard                                               | CI unaffected (that job checks out a clean tree and `out/` is gitignored), but the guards are meant to be run locally by reviewers, where they went red on a correct repo | Guards 1, 3 and 4 gained `--exclude-dir=out --exclude-dir=dist --exclude-dir=node_modules`; mirrored in `.convoy/checklists/review.md`. The guard's scope is unchanged — only build output is excluded                 | MITIGATED |
| G-16 | `packages/kh-client/tsconfig.json` includes only `src/**/*.ts`, so `pnpm -r typecheck` does not typecheck `test/`                                                                                                   | a type error in a test file is caught by vitest and eslint, but not by the typecheck gate                                                                                 | **Accepted, CVY-000 convention.** Not widened at CVY-002 — the parity test compiles under vitest and lints clean. Revisit only if a test-only type error ever escapes                                                  | ACCEPTED  |
| G-17 | **x402 is Base-mainnet-only.** The agentic wallet's Turnkey allowlist covers Base 8453 USDC and Tempo USDC.e. There is no Base Sepolia path for the payment leg                                                     | CVY-017 cannot run on the development chain                                                                                                                               | Cut to a gas-only budget (cut order #1), or run a single sub-dollar x402 payment on Base mainnet independently of execution                                                                                            | OPEN      |
| G-18 | **Budget meter is notional on testnet.** `gasUsedWei` is real; the USD price is frozen and testnet gas has no market value                                                                                          | budget figures are notional                                                                                                                                               | None needed — disclose in the README honesty table as "real gas units, notional USD at a frozen price"                                                                                                                 | ACCEPTED  |
| G-19 | DEC-001 residue: chain references outside the amendment's enumerated file list still say Base mainnet / 8453 / `0x2105`                                                                                             | `.convoy/playbooks/release.md` is the authoritative operational sequence and its step 2 deploys to mainnet — a session following it literally does the wrong-chain deploy | **Tracked, not swept.** DEC-001 enumerated its files deliberately; DECISIONS.md DEC-001 records the supersession. **Swept 2026-08-03.** Regeneration command + annotated survivor verdicts in the detail section below | CLOSED    |

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

### G-18 — budget meter is notional on testnet

Recorded by DEC-001. `gasUsedWei` comes from a real KeeperHub status response and is a real gas
figure. The USD conversion uses `CONVOY_ETH_USD`, frozen per run (G-04) — and on a testnet the gas
being priced has no market value at all.

**Impact:** budget figures are notional. **Fallback:** none needed. **This must be disclosed**: the
README honesty table states "real gas units, notional USD at a frozen price." The gas units are the
honest part and the claim is scoped to them.

Distinct from **G-04**, which is about _not using a live oracle_. G-04 makes the price frozen and
reproducible; G-18 says that on 84532 even a perfect price would be pricing something worthless.
G-04 is a design choice, G-18 is a consequence of DEC-001.

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
