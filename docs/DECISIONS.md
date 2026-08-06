# Decisions

Numbered decision log. Format: `D-NNN <date>: decision, rationale`. A decision is recorded whenever
an implementation choice was not fully determined by the frozen documents. Decisions never change
the architecture — where the frozen documents speak, they win, and the friction goes to
`docs/KNOWN_GAPS.md`.

---

**D-001 2026-07-29: Use `pnpm -r` for orchestration; do not add Turborepo.**
The blueprint's repository tree marks `turbo.json` "optional" and the CVY-000 fallback is explicitly
"drop turbo, use `pnpm -r`". At four packages with a shallow dependency graph, Turborepo's caching
buys little and adds a moving part to the build that every future session must reason about. All
root scripts are `pnpm -r <script>`, and every package exposes the same four scripts
(`build`, `typecheck`, `lint`, `test`) so recursion is uniform. Revisit only if build time becomes a
real constraint.

**D-002 2026-07-29: `vercel.json` lives at the repository root; the dashboard's Root Directory
setting is authoritative.**
The blueprint's tree places `vercel.json` at the root, while the deployment section specifies a
Vercel project with Root Directory `apps/web`. Vercel reads `vercel.json` from the configured Root
Directory, so the two cannot both be literally true. The file is kept at the root per the tree, with
the build wired as `pnpm --filter @convoy/web build`; `docs/DEPLOYMENT.md` records that the dashboard
settings are authoritative and that deployment is **git-integration only, never the Vercel CLI**.

**D-003 2026-07-29: ESLint 8 with `.eslintrc.cjs` cascade rather than flat config.**
Next.js 14 and `eslint-config-next` are built around the eslintrc format. A single root
`.eslintrc.cjs` with `root: true` is discovered by every package, so `pnpm -r lint` behaves
identically everywhere without duplicating configuration. Flat config would mean per-package
configuration files and a Next.js compatibility shim for no gain at this stage.

**D-004 2026-07-29: CI grep-guards run inline in `ci.yml` as a dedicated `invariants` job.**
The blueprint requires the guards at CVY-000 so they "fail the build the moment an AI session
drifts". Keeping them inline and self-contained means the exact commands are visible in the workflow
file, can be copy-pasted into a terminal, and are mirrored verbatim in
`.convoy/checklists/review.md` so a reviewer runs precisely what CI runs. The guards scope to code
directories (`apps`, `packages`, `services`, `scripts`) so that documentation, `.env.example`, and
`CLAUDE.md` — which legitimately name `app.keeperhub.com` and `PRIVATE_KEY` — do not produce false
failures.

**D-005 2026-07-29: Implementation modules ship as empty compilable scaffolds at CVY-000.**
The blueprint's repository tree lists every source file, but CVY-000's Definition of Done is only
"`pnpm install && pnpm -r build` succeeds on empty packages". Each listed module therefore exists
with its exports declared but no behaviour, carrying a one-line comment naming the milestone that
implements it. This keeps the tree complete and the build green without pre-empting CVY-001 onward,
and it means no future session has to guess where a module belongs.

**D-006 2026-07-29: `verify-env.ts` runs the web build with `NODE_ENV=production`.**
`.env` sets `NODE_ENV=development` per the blueprint's environment table, and the verification
script loads `.env` before spawning child processes. `next build` rejects a non-production
`NODE_ENV`, so the inherited value made the "Web build" row fail even though the build itself was
green. The check now overrides `NODE_ENV=production` for that child process only — a production
build is a production build by definition. The script also surfaces the child's stderr in the
failure detail rather than a generic "Command failed", so a future session debugs the real error.

**D-007 2026-07-29: `scripts/bootstrap.sh` ships verbatim from the blueprint; its database steps
become runnable at CVY-005.**
The blueprint gives the script's exact content, so it is reproduced without modification. Executed
today it completes the Node check, corepack activation, the Foundry check, the `.env` gate,
`pnpm install`, and `forge install/build/test`, then stops at `pnpm --filter @convoy/db db:generate`
because Prisma is a CVY-005 dependency that does not exist yet. That is milestone ordering, not a
defect, and it is reported as such rather than worked around by weakening the script. Every step
before the database block is verified working.

**D-008 2026-07-29: `forge-std` is committed as a git submodule; `packages/contracts/lib/` is not
ignored.**
`forge install` registers dependencies as git submodules, which is the Foundry convention: the
committed submodule pointer plus `foundry.lock` pin the exact revision, so contract builds are
reproducible from a clean clone and in CI. The initial `.gitignore` excluded `lib/`, which would
have left the pinned revision unrecorded and reintroduced the revision-mismatch warning seen during
the first bootstrap run. `cache/`, `out/`, and `broadcast/` remain ignored.

**D-009 2026-08-03: `MockRewardDistributor` ships with no events and no access control.**
Architecture §8 names exactly three functions (`setRoot`, `fund`, `enableMarket`) and one
requirement — that they _genuinely revert_ on unmet preconditions. Events, an owner, and a token
transfer would all be defensible in a real distributor and are all additions to a frozen surface, so
none were added. The contract's entire job is to be an honest revert source for the Critic; the
proof surface is `ConvoyRegistry`, which does emit. The precondition chain implemented is
`setRoot → fund → enableMarket`, with `fund` before `setRoot` reverting `RootNotSet()` as the
canonical case named in the architecture.

**D-010 2026-08-03: the invariant handler biases its actor towards the run's operator, and reports
accepted-vs-rejected call counts.**
`openRun` is permissionless, so the opener becomes the operator; with a uniformly random actor drawn
from three, only one commit in three could be accepted. Measured on a real campaign, that produced
`accepted open/commit/seal: 4 0 0` over 32 calls — 1000 green runs proving essentially nothing,
because `fail_on_revert = false` discards the rejected calls silently (gap G-13). The handler now
routes three seeds in four to the run's own operator, keeps the fourth random so `NotOperator()`
stays reachable, counts accepted and rejected calls per function, and prints them from
`afterInvariant()`. The campaign-non-empty assertion deliberately checks _calls driven_ rather than
_calls accepted_, because the latter is not guaranteed by the fuzzer and a flaky CI check is worse
than no check; reachability is guaranteed instead by the deterministic
`test_handler_reachesEveryState`.

**D-011 2026-08-03: ghost counters are derived by the handler, never assigned from a registry read,
and the counting invariants are mutation-tested.**
A ghost variable assigned from the contract it is supposed to check can degenerate into a mirror of
that contract, and the invariant comparing them becomes a tautology that passes on a broken
contract. `ghostLastSeq` is therefore incremented by the handler (`+= 1`) and compared against
`committedCount`, rather than assigned from it. The property is verified the only way that means
anything: mutating `committedCount += 1` to `+= 2` in the contract must turn the invariants red. It
does — both `invariant_idxMonotonic` and `invariant_committedCountMatches` fail on the first
accepted commit. Re-run that mutation whenever the handler's ghost state is refactored; a green
invariant that cannot fail is worse than no invariant, because it is trusted.

**D-012 2026-08-03: parity fixtures carry `argTypes` + `argValues`, not just precomputed `args`
bytes.**
A fixture that only carried Solidity's `args` bytes plus the expected hash would prove that
TypeScript can hash a byte string — which viem obviously can. The interesting failure is in the
_argument encoding_: whether `encodeAbiParameters` over `address[]`, a negative `int256`, or
multi-byte UTF-8 in a `string` produces the same bytes Solidity's `abi.encode` did. The fixtures
therefore carry the types and the values, TypeScript re-encodes them independently, and the test
asserts both that the re-encoded bytes equal Solidity's and that the resulting hash matches. Values
travel as strings because JSON numbers cannot represent `uint256`.

**D-013 2026-08-03: `fs_permissions` in `foundry.toml` is scoped to the fixtures directory only.**
`DumpPayloadHashFixtures.s.sol` needs to write outside the Foundry project root
(`../../tests/fixtures`), which Foundry refuses without an explicit grant. The grant names exactly
one directory and grants only `write`. A blanket `access = "read-write"` on `"./"` would have been
one line shorter and would have let any future script write anywhere in the repository.

**D-014 2026-08-03: the generated fixture file is `.prettierignore`d.**
Prettier wanted to reformat the JSON the forge script emits. Letting it would mean every
`forge script DumpPayloadHashFixtures` run dirties the working tree, and "the fixtures are dumped,
not hand-written" would quietly stop being verifiable — you could no longer re-run the dump and get
`git diff` silence. The file is a build artifact and is treated like one, alongside
`packages/db/src/generated/`.

**D-015 2026-08-03: the CI grep-guards exclude build output.**
See G-15. Compiling `Deploy.s.sol` produces `out/Deploy.s.sol/Deploy.json` containing the string
`PRIVATE_KEY`, so the "no private key" guard went red on a correct repository. CI never saw it — that
job checks out a clean tree and `out/` is gitignored — but the guards are mirrored into
`.convoy/checklists/review.md` specifically so a human can paste them into a terminal, and there they
failed. `--exclude-dir=out --exclude-dir=dist --exclude-dir=node_modules` was added to the three
guards that scan broadly. The guards' semantics are unchanged; only uncommitted generated output is
skipped. A guard that cries wolf is a guard that gets ignored, and these guards are the mechanism
that makes "no held keys" a claim rather than an aspiration.

Loosening a guard without re-testing it would replace one failure mode with a worse one, so the
exclusion was checked the same way the invariants were: planting
`const k = process.env.PRIVATE_KEY;` in `services/worker/src/` makes guard 3 report the file, and
removing it makes the guard clean again. The exclusion skips generated output and nothing else.
**Re-run that probe whenever a guard's scope changes.**

---

## Spec amendments

A `DEC-NNN` entry is a **scoped amendment to a frozen document's parameters**, not an implementation
choice. It carries the same weight as the frozen documents for the parameter it names, and it is the
only mechanism by which such a parameter changes. Where a frozen document and a `DEC-NNN` entry
conflict, the amendment wins **for that parameter only** and the frozen text is superseded, not
edited.

**DEC-001 2026-08-03: the execution chain for development, rehearsal, and the demo is Base Sepolia
(84532), not Base mainnet (8453).**

- Base Sepolia keeps ~2s block times, which the 3-minute demo's serialized-nonce execution beat
  depends on. Ethereum Sepolia's ~12s blocks were considered and rejected for this reason.
- Testnet gas removes funding risk from the critical path.
- Basescan verification, RPC provider, and tooling stay in the same family as Base mainnet, so a
  late flip of the final demo run to 8453 remains cheap.

Base mainnet (8453) is retained as an **optional final demo target at CVY-019**, not as the
development target. Mainnet support is not removed from the code; the chain is parameterised.

**Superseded frozen text — do not "correct" these back.** `docs/IMPLEMENTATION_BLUEPRINT.md` §11
line 509 describes `BASE_RPC_URL` as "dedicated RPC, chain pinned 8453" and its §11 verification
matrix (line 534) as `eth_chainId == 0x2105`; `.convoy/agents/principal-blockchain.md` line 50 says
the same. Those files are frozen or outside this amendment's enumerated scope, so they still read 8453. **This entry supersedes them.** `scripts/verify-env.ts` asserts `0x14a34` (84532) by design,
and a future session that "fixes" it back to `0x2105` is reintroducing the funding risk this
amendment removed.

**Consequential change (outside DEC-001's file list, made because the amendment creates the
hazard):** `packages/contracts/foundry.toml` mapped `[rpc_endpoints] base = "${BASE_RPC_URL}"`. Once
`BASE_RPC_URL` holds a Sepolia endpoint, `forge script --rpc-url base --broadcast` would deploy to
**Sepolia while the operator believed it was mainnet** — and `Deploy.s.sol`'s chain allowlist permits
both 8453 and 84532, so the accident guard does not catch it. The endpoint is remapped to
`${BASE_MAINNET_RPC_URL}`, a new optional variable. `base_sepolia` is unchanged.

**Premise VERIFIED 2026-08-03 against the live API.** This amendment assumed KeeperHub direct
execution works on 84532 — inferred from `docs/PRODUCT_DISCOVERY.md` §Key Findings, where Base
Sepolia is in the supported chain list and the 8453-only restriction applies to _agentic-wallet
signing_ (gap G-17), not to direct execution. That assumption is now **proven rather than inferred**:
one `simulate:true` call to `POST /api/execute/contract-call` with `chainId:"84532"` /
`network:"84532"` returned **HTTP 200** with
`{"success":true,"status":"simulated","wouldRevert":false,"gasEstimate":"25989"}` and a real `from`
address — so the org Turnkey wallet is provisioned for 84532 and does not return `422`. No control
run against 8453 was required. The redacted request and response are recorded verbatim at
`packages/kh-client/test/vcr/dec-001.simulate.84532.probe.json`.

The probe passed an explicit `abi` and targeted the WETH9 predeploy
`0x4200000000000000000000000000000000000006` deliberately, so a failure could not have been
misattributed: an unresolved ABI or a missing contract would otherwise read as a rejected network.

---

**D-016 2026-08-03: `simulate` is omitted entirely on a write rather than sent as `false`.**
The API treats `simulate` as a strict boolean and the documented contract is `simulate:true`. Sending
`simulate:false` is a different request from omitting the field, and nothing verifies that the API
treats them identically. `buildContractCallBody` therefore adds the key only for simulates. Pinned by
a test asserting `'simulate' in body === false` for writes.

**D-017 2026-08-03: the chain id is validated in the `KhClient` constructor, not at the call site.**
An unsupported chain returns HTTP 500 with an empty body (gap G-22), and 5xx is classified transient,
so a permanent configuration error would be retried until the attempt budget ran out. Validating once
at construction turns that into an immediate local failure and means no call site can forget. The
supported set is `{84532, 8453}` — the DEC-001 target plus the optional CVY-019 flip.

**D-018 2026-08-03: `pollUntilTerminal` short-circuits on `terminal && transactionHash`, not on
`terminal` alone.**
Gap G-02's mitigation is "short-circuit the poll when the POST response is already terminal". Applied
literally that is wrong: the live smoke showed a synchronous write returning
`202 {status:"completed"}` with **no** `transactionHash`, which appears only on `GET /status`
(gap G-23). Short-circuiting on terminality alone silently discards the transaction hash — the field
the manifest's KeeperHub leg, the README honesty table and the Basescan link all depend on. The
stricter condition is what supplies the second half of the architecture's `SUBMITTED → LANDED` guard.
This was found by executing a real write, not by reading the documentation, which is the argument for
the live smoke being part of the milestone rather than an optional extra.

**D-019 2026-08-03: the CVY-004 revert-source acceptance criterion is met with WETH9, and the
`MockRewardDistributor` case is deferred to CVY-003.**
CVY-004's criteria name a `fund`-before-`setRoot` call returning `wouldRevert:true`. That contract is
not deployed — deploying it is CVY-003 scope. The veto path is therefore proven against a different
**genuinely reverting** call: WETH9 `withdraw` of more than the wallet holds. Nothing is staged; the
contract legitimately rejects it. This is a **substitution of the named revert source**, not a
satisfied criterion, and it is recorded as such rather than quietly ticked off. The named case must be
run at CVY-003 once `MockRewardDistributor` exists — and it carries a second purpose, because gap
G-20 needs a custom-error contract to establish whether poor `revertReason` decoding is the API's
fault or WETH9's.

**D-020 2026-08-03: VCR tapes are recorded from real responses and `.prettierignore`d.**
Same reasoning as D-014 for the payloadHash fixtures. A tape that has been reformatted is a
transcription, not a recording, and the value of a tape is that the bytes came off the wire. A missing
tape throws rather than falling through to a default, because a VCR suite that silently passes when a
tape is absent is worse than no VCR suite.

**D-021 2026-08-04: `docs/RUNBOOK_FIRST_TRANSACTION.md` is the single operational authority for the
deploy and first transaction; four other locations now delegate to it.**
`docs/DEPLOYMENT.md`, `.convoy/playbooks/release.md`, `.convoy/tasks/CVY-003.md` and
`Deploy.s.sol`'s NatSpec each carried their own copy of the deploy command. **Every one of them was
wrong**, in two different ways: `--rpc-url` names a `foundry.toml` key and takes an **underscore**
(`base_sepolia`), while `--chain` names a Foundry chain enum value and takes a **hyphen**
(`base-sepolia`) or the numeric id. `release.md` had the rpc-url hyphenated, so it resolved as a file
path and could never have worked; `DEPLOYMENT.md` and the task card had `--chain base_sepolia`, which
errors `invalid digit found in string`. Four copies, zero working commands. That is G-19's failure
mode with a sharper edge, so the commands now live in exactly one file and the others link to it.

**D-022 2026-08-04: `SimulateResult.revertSelector` extracts the 4-byte selector in the client.**
The API reports a custom error as `execution reverted (unknown custom error)` but includes the revert
data as `data="0x1c8b6259"`. The name is absent; the selector is not. Extracting it once in
`packages/kh-client` — whose stated job is absorbing API drift behind stable types — beats having the
Critic, the manifest and the audit drawer each re-parse an ethers diagnostic blob. This is what
downgrades G-20 from a threat to CVY-011's veto quality into a lookup against an ABI already in hand.

**D-023 2026-08-04: error selectors are always derived, never hardcoded.**
The first G-20 measurement used a hand-written constant for `RootNotSet()`. It was wrong, and it
misreported the verdict as "the API returns no selector" when the API had returned it all along.
A hardcoded selector is a guess that looks like a fact once it is checked in. Derive them:
`toFunctionSelector()` in TypeScript, `cast sig` at the terminal.

**D-024 2026-08-04: `events` append-only is enforced at runtime, not only in types.**
The frozen design says the event log is append-only and that no update or delete path exists in the
client surface. A types-only restriction is one `as any` from being ignored, and the cost of ignoring
it is severe: `events.id` is the SSE event id a browser sends back as `Last-Event-ID`, so mutating or
deleting a row silently corrupts every client replaying from that point and the audit trail stops
being a record of what happened. `@convoy/db` therefore does both — `ConvoyDb` narrows `event` to
create/read at the type level, **and** a Prisma client extension throws `AppendOnlyViolationError`
on `update`/`updateMany`/`upsert`/`delete`/`deleteMany`. Five tests call each forbidden operation
through a cast that defeats the types, and assert it still throws.

**D-025 2026-08-04: the schema is verified by reading `information_schema`, not `schema.prisma`.**
`schema.prisma` is what we asked for; the applied database is what we got. Only the second is
evidence, and the two can diverge whenever a migration is edited, partially applied, or drifts. The
CVY-005 tests therefore read column types, precisions, nullability and index definitions back out of
Postgres and compare them to the frozen `docs/ARCHITECTURE.md` §5(g) block. The `(run_id, idx)`
unique constraint additionally gets a behavioural test — inserting a duplicate must reject — because
an index that exists and an index that bites are different claims.

**D-026 2026-08-04: Prisma and esbuild are the only packages allowed to run install scripts.**
`pnpm-workspace.yaml` denies build scripts by default; CVY-000 allowed `esbuild` alone. Prisma's
query engine is a native binary fetched at install, so `@convoy/db` cannot generate, migrate or seed
without it, and CVY-005 adds `prisma`, `@prisma/client` and `@prisma/engines` to `allowBuilds`. Each
entry is a deliberate decision rather than a convenience: an install script runs arbitrary code with
the developer's environment in scope. pnpm had written placeholder `set this to true or false`
values into the file; those are now explicit.

**D-027 2026-08-04: seed fixtures compute `payloadHash` rather than hardcoding it.**
A hardcoded hash in a fixture is a guess that stops tracking the encoding the moment either side
moves — exactly the failure D-023 recorded for error selectors. The seed computes it with the
CVY-002 encoding, and `seed.fixtures.test.ts` recomputes it independently from the stored target,
function, args and idx rather than asserting a literal. The 12-item fixture also carries two
**genuinely invalid** items (a duplicate `enableMarket` and a second `setRoot`) whose reverts —
`MarketAlreadyEnabled()` and `RootAlreadySet()` — come from the contract's own preconditions. Nothing
is staged.

**DEC-002 2026-08-04: EXECUTE-phase dispatch fans out concurrently. `.convoy/tasks/CVY-006.md`'s
"concurrency 1 per run" is superseded.**

The CVY-006 card said "Concurrency **1 per run** — submissions serialize against the single org
wallet". Taken literally that inverts the architecture and would hollow out the demo.

`docs/ARCHITECTURE.md` requires the opposite in four separate places:

- §3 capability table — "One org wallet = one sequential nonce; **concurrent submits genuinely
  serialize**. [Without it] the reliability demo has no substrate."
- §4 step 6 — "**Contention is real:** deferred-now-ready items are **submitted concurrently**
  against the one org wallet; KeeperHub serializes them on the single nonce."
- §13 risk table — "Convoy _submits_ concurrency; KeeperHub _serializes_ it — the honest contention
  story."
- §15 demo script, 1:00–2:00 — "Convoy submits the ready items concurrently; KeeperHub serializes
  them on the nonce."

**Serial submission would make the narration an overclaim.** If Convoy submits one at a time there is
no contention, nothing for KeeperHub's nonce manager to resolve, and the sentence "KeeperHub
serializes them" describes an event that did not happen. It also removes the demo's _deterministic_
reliability beat: backup path d (§15) explicitly relies on nonce-serialization of concurrent submits
being reproducible when a live transient retry does not occur. Golden rule 1 applies — the
architecture wins and the card is the thing that is wrong.

**Resolution — implementation-level, not an architecture change:**

- **Run-level phase orchestration stays serial.** One run's state machine advances one phase at a
  time: PLAN → CRITIQUE → EXECUTE → SEAL. Nothing here changes.
- **Within EXECUTE, dispatch of ready items fans out.** The card's "serialize against the single org
  wallet" is right about _where_ serialization happens — it happens at KeeperHub, on the nonce, not
  in Convoy's dispatcher. That is the whole point.
- The fan-out is a **named constant with a documented default**, never a hardcoded 1:

  | Constant             | Where                           | Env override                | Default |
  | -------------------- | ------------------------------- | --------------------------- | ------- |
  | `EXECUTE_FANOUT`     | `services/worker/src/config.ts` | `CONVOY_EXECUTE_FANOUT`     | `4`     |
  | `WORKER_CONCURRENCY` | `services/worker/src/config.ts` | `CONVOY_WORKER_CONCURRENCY` | `4`     |

  `WORKER_CONCURRENCY` is clamped to at least `EXECUTE_FANOUT`: a worker that processes fewer jobs
  at once than the fan-out asks for silently re-serializes the dispatch, which is exactly the bug
  this decision exists to prevent.

**The default of 4 is provisional and is chosen properly at CVY-008**, where the EXECUTE phase
actually exists and the number can be measured against a real 12-item batch. 4 is enough to produce
genuine nonce contention and small enough to stay clear of the observed KeeperHub rate limit
(`x-ratelimit-limit: 60`). CVY-006 ships the constant and the plumbing; it does not ship a tuned
value, because there is nothing yet to tune it against.

**DEC-003 2026-08-04: the idempotency attempt number is fixed in the job payload at enqueue time,
never derived at handler runtime.**

BullMQ re-picks a stalled job after `stalledInterval` (~30s default). The re-picked job runs the same
handler again, and if that handler computed its attempt number from anything mutable — a count of
`attempts` rows, `job.attemptsMade`, a clock — it would produce a _different_
`Idempotency-Key: <runId>:<idx>:<attempt>` and KeeperHub would treat the retry as a **new write**.
That is a double-submission, on chain, with real money, from a process that believed it was being
careful.

The attempt number therefore travels in `job.data` and is fixed when the job is enqueued. A re-picked
stalled job carries byte-identical data, produces the identical idempotency key, and KeeperHub's
per-org 24h window collapses it to one execution. A genuine Convoy-side retry enqueues a _new_ job
with `attempt + 1` and deliberately gets a new key. See gap **G-26**.

**DEC-004 2026-08-04: KeeperHub sponsors execution on Base Sepolia. The org wallet's balance does
not move, and the budget meter is a policy limit rather than a claim on a balance.**

Measured, not inferred. For the CVY-003 transaction
`0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd` (block 45020292):

| Address                          | Before             | After              | Delta                 |
| -------------------------------- | ------------------ | ------------------ | --------------------- |
| Org Turnkey wallet `0x65F5…0Da6` | 100000000000000000 | 100000000000000000 | **0 wei**             |
| Relay EOA `0x6331…1e99`          | 248376537161491949 | 248376114708119847 | **−422453372102 wei** |

The relay's delta equals `gasUsed × effectiveGasPrice + l1Fee`
(`68400 × 6000000 + 12053372102 = 422453372102`) **to the wei**, which attributes the payment to this
transaction rather than to other activity in the same block. The org wallet reads 0.1 ETH at the
deploy block, at the transaction block, and now: **it has never moved.**

Scope of the claim: sponsorship was observed on 84532 on every write so far (`sponsored: true` on
both the CVY-004 smoke and CVY-003) — two samples. This confirms sponsorship is _active here_; it
does not settle policy, and **G-08 still stands: sponsorship is never load-bearing.** The runbook's
0.02 ETH org-wallet funding threshold therefore **stays**, deliberately, as belt-and-braces against a
run where sponsorship does not apply.

The design is unchanged. What changes is what the meter can honestly claim — see the widened G-18.

**DEC-005 2026-08-04: KeeperHub's `gasUsedWei` field contains gas UNITS. The frozen formula is right;
the field name is the drift.**

`ARCHITECTURE` §5(g) pins `gas_used_usdc = (gasUsedWei / 1e18) * runEthUsd`, where `gasUsedWei` means
wei. KeeperHub's status response has a field of the same name carrying the receipt's `gasUsed` —
units. Measured on two independent transactions: `status.gasUsedWei` was `68400` and `74093`,
identical to `result.gasUsed` and `result.gasUsedUnits` in the same payloads, and identical to the
on-chain receipt's `gasUsed`.

Feeding units into the formula understates cost by a factor of about **6.2 million** — $0.00000000023
instead of $0.0014 on the CVY-003 transaction. The meter would have looked entirely plausible and
drained essentially never.

**This is API drift, not an architecture change**, and absorbing it is exactly what
`packages/kh-client` exists for — the same shape as G-01 (`chainId` vs `network`). The client now
exposes `gasUsedUnits` and `gasPriceWei` instead of propagating the wrong name, so a consumer cannot
divide units by 1e18 by accident. The DB column `attempts.gas_used_wei` is frozen and keeps its name;
it stores **real wei**.

**The L1 fee is not in KeeperHub's response.** Base is an OP-stack L2 and the fee has two parts:
`units × gasPriceWei` (L2 execution) and `l1Fee` (data availability). KeeperHub returns only the
first; on the CVY-003 transaction the L1 part was 12,053,372,102 of 422,453,372,102 wei — **2.9%**,
too large to drop. CVY-007 therefore takes option (b): read `l1Fee` from the transaction receipt via
`BASE_RPC_URL`, which the manifest reconciles against chain reads at CVY-012 anyway, so the read is
already on the path. `composeGasFeeWei` still produces a figure without it and sets
`l1FeeIncluded: false` — under-reporting is allowed only when it is labelled.

Verified end to end: recomputing the fee from the recorded fields equals **422453372102**, the wei
that actually left the relay. The meter is tied to a balance change on chain, not to itself.

**D-028 2026-08-04: the CVY-005 state arrays did not match the frozen §5(i) machine; corrected here.**
`RUN_STATUS` omitted `OPENING`, `CRITIQUING`, `SEALING` and `FAILED_FATAL`, and used `SEALED` where
the machine says `SEALED_OK`. `ITEM_STATE` omitted `RETRYING` and `SKIPPED`. `SKIPPED` is **not an
addition** — §5(i) names it explicitly as `SKIPPED(budget-exhausted)` — and CVY-007 is the milestone
that produces it, which is how the omission surfaced. Checking the frozen text before appending to
the array is what caught this; adding a state that the machine does not name would have been an
architecture surface change.

**DEC-006 2026-08-04: the serializing nonce belongs to a KeeperHub RELAY EOA, not the org Turnkey
wallet. Serialization is real; the demo narration's attribution is not. Flagged for CVY-019.**

Measured by dispatching 12 independent items concurrently through EXECUTE and reading every receipt.

| Question                       | Answer                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from` — same relay or a pool? | **A single relay EOA**, `0x6331eb4571de9284f7e9ead98ac7b0661a091e99`, for **11 of 12**. Not a pool. The 12th came from the **org wallet itself**, `0x65f5afd3…90da6`    |
| Strictly increasing nonces?    | **Yes.** Relay nonces 2485, 2486, 2487, 2488 … 2493–2496 … 2501–2503. The gaps are this run's own interleaved `commitAction` writes. The org-wallet tx used its nonce 1 |
| Same block or successive?      | **Successive** — roughly one transaction per 2s block, never batched                                                                                                    |

**What is true:** concurrent submits genuinely serialize. There is one sequential nonce, it strictly
increases, and Convoy's dispatch width does not change the landing order. The reliability substrate
is real, and **backup path d survives** — nonce serialization is reproducible and deterministic.

**What is NOT true as currently narrated:** §15 says _"one wallet, one sequential nonce"_ and
attributes the serialization to the **org Turnkey wallet**. It belongs to a KeeperHub relay. A judge
opening any of these hashes on Basescan sees `from` = a relay address, not the wallet the narration
names. **This is a demo-narration risk for CVY-019 and is reported, not fixed here** — the narration
is the operator's to adjust.

**Amends DEC-004.** DEC-004 concluded from a single transaction that "the org wallet's balance does
not move". Under a 12-item concurrent burst that is **false**: one write bypassed the relay, was sent
by the org wallet, and the wallet paid its own fee — balance 100000000000000000 →
99999717707646113, a delta of **282,292,353,887 wei**, exactly that transaction's
`gasUsed × effectiveGasPrice + l1Fee`. Sponsorship is therefore **partial and not guaranteed per
transaction**. The runbook's org-wallet funding threshold is **load-bearing, not belt-and-braces** —
keeping it was correct for a better reason than the one recorded at CVY-007. G-08's "never
load-bearing" stands and is now doubly justified.

**DEC-007 2026-08-04: `EXECUTE_FANOUT` stays at 4. Measured, no longer provisional.**

The same 12-item batch, twice:

| Fanout | Elapsed    | Landed |
| ------ | ---------- | ------ |
| 4      | **75.5 s** | 12/12  |
| 12     | **77.8 s** | 12/12  |

Tripling dispatch width changed nothing (the 2.3 s difference is inside run-to-run noise, and the
larger value was marginally _slower_). **Throughput is bounded by KeeperHub's sequential nonce, not
by Convoy's dispatch width** — which is exactly the architecture's claim, now measured rather than
asserted. 4 is enough to create genuine contention at the serialization point; more only adds
in-flight state and rate-limit pressure (observed limit: 60/min) for zero gain. DEC-002's provisional
default becomes the settled value.

**D-029 2026-08-04: the plan is hardcoded and the APPROVE guard is simulator-only, until CVY-010/011.**
There is no Planner and no LLM Critic yet. `phasePlan` writes a plan derived from the seeded item
order and its declared `dependsOn` edges; the `COMMITTED requires APPROVE` guard is satisfied by the
deterministic kh-client `simulate:true` alone. **This is a substitution, recorded rather than ticked
off.** CVY-010 replaces the plan source; CVY-011 layers the LLM Critic **on top of** this gate — the
simulator remains the corroborating verifier, and any VETO(would_revert) must still be backed by
`simulate.wouldRevert = true`. Nothing here is staged: the veto observed in acceptance is
`RootNotSet()`, decoded from selector `0x1c8b6259`, raised by the contract's own precondition.

---

**DEC-008 2026-08-04: sponsorship is an ERC-4337 paymaster on a metered free allowance, not a
property of the chain. When it lapses, the org Turnkey wallet pays.**

**Source: KeeperHub, reported — not measured by Convoy.** Recorded as an explanation supplied by the
vendor, and labelled as such because this repository's whole discipline is the difference between the
two. What Convoy measured is DEC-006; what KeeperHub supplied is the mechanism behind it.

- KeeperHub runs an **ERC-4337 paymaster** that covers roughly **$1/month per free account**, spent
  on early runs.
- Once that allowance is exhausted, **every subsequent write is charged to the org Turnkey wallet**.
- `gasUsedWei` reports **real gas consumed either way**. It indicates **usage, not payer**.

**This is consistent with the measurement and explains its most confusing feature.** DEC-006 found 11
of 12 concurrent writes sent by a relay and one sent by the org wallet, mid-run, with nothing else
changing. A metered allowance running out part-way through a burst produces exactly that: the switch
is a budget boundary, not a routing decision, which is why it fell in the middle of a batch of
identical calls.

**Consequences, all of them already load-bearing:**

1. **DEC-004 is superseded on the point of payment.** "KeeperHub sponsors; the org wallet's balance
   does not move" was measured on one transaction while the allowance still held. It describes a
   _state_, not a _rule_, and that state expires.
2. **The runbook's org-wallet funding threshold is load-bearing.** An unfunded wallet does not
   degrade gracefully once the allowance lapses — writes stop.
3. **Payer must be recorded per execution, not assumed per run.** The flag flips mid-run. See
   DEC-010.

---

**DEC-009 2026-08-04: the demo narration attributes serialization to KeeperHub, not to the org
wallet. G-30 is CLOSED by this entry.**

The approved claim for CVY-019, to be used verbatim in narration and README copy:

> **Convoy submits concurrently; KeeperHub serializes onto a single sequential nonce** — strictly
> increasing, one transaction per block, never batched — **measured identical at dispatch width 4 and 12.**

**Every clause is measured** (DEC-006, DEC-007): strictly increasing nonces 2485–2488 / 2493–2496 /
2501–2503, successive ~2 s blocks, 12/12 landed at both widths in 75.5 s and 77.8 s.

**What must NOT be claimed:** that the sender is the org Turnkey wallet. It is a KeeperHub relay
EOA (`0x6331eb45…091e99` on the measured batch), and a judge opening any hash on Basescan sees that
`from`. The claim above is stronger anyway — it names the property that matters (deterministic
serialization) and drops the one that was never load-bearing (which address holds the nonce). Backup
path d depends on serialization, which survives untouched.

**Superseded frozen text — do not "correct" this back.** `docs/ARCHITECTURE.md` §15 narrates
_"one wallet, one sequential nonce"_ and attributes the serialization to the org Turnkey wallet.
§15 is frozen and still reads that way. **This entry supersedes it for that clause only.** The
fanout comparison table is preserved in the README as the supporting artifact.

---

**DEC-010 2026-08-04: the meter records two figures — gas CONSUMED and wei DEBITED FROM THE WALLET —
and never conflates them.**

| Figure                  | Definition                                                                                  | Recorded                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **consumed**            | `gasUsed × effectiveGasPrice + l1Fee`, from the chain receipt                               | **Always.** Drains the budget; drives BUDGET_LOW and exhaustion |
| **debited from wallet** | the same figure **only** when the execution record says `sponsored:false`; zero when `true` | Per attempt; summed per run                                     |

Budget exhaustion tracks **consumed**, deliberately. A meter that counted only unsponsored writes
would stop working the moment the paymaster was covering things — BUDGET_LOW would never fire and
exhaustion would never arrive. The budget is a policy limit on consumption; what the wallet paid is
tracked beside it, never instead of it.

**`sponsored: null` means unknown, and yields a null debit rather than a zero one.** "Nothing was
charged" and "we do not know what was charged" are different claims, and only one of them is honest.

**Where the numbers come from.** Both figures are composed from `eth_getTransactionReceipt` via
`BASE_RPC_URL` — the same artifact a judge opens on Basescan — not from KeeperHub's reported gas.
KeeperHub's figures are recorded alongside as corroboration. This closes the gap between what
`services/worker/src/budget.ts` documented at CVY-007 (an L1 fee read from the receipt) and what the
code actually did (`composeGasFeeWei` was called with no `l1FeeWei`, so `l1FeeIncluded` was always
false in the live path).

**Schema amendment.** `attempts` gains one nullable column, `sponsored boolean`. The wallet-debited
total is **derived** — `sum(gas_used_usdc) where sponsored = false` — not stored; a stored total
could disagree with its own rows. `attempts.gas_used_wei` now holds the real total fee in wei, and
`gas_used_usdc` is populated for the first time.

**Rows written before this entry hold gas UNITS in `gas_used_wei`, and are NOT migrated.**
Back-filling would require re-reading every receipt and would silently rewrite evidence already cited
in the CVY-007 and CVY-008 milestone reports. `sponsored IS NULL` identifies those rows exactly.

---

**D-030 2026-08-04: the worker does NOT import the Planner. The boundary between them is
`runs.plan`, not a module.**

The frozen file layout puts the Planner in `apps/web/lib/planner` (blueprint §612, CVY-010 card).
The worker compiles with `rootDir: src`, so a direct import fails — **measured, not assumed**:

```
src/__probe.ts(1,29): error TS6059: File 'apps/web/lib/planner/index.ts' is not under
rootDir 'services/worker/src'. 'rootDir' is expected to contain all source files.
```

Rather than widen `rootDir`, extract a fourth package, or move the Planner out of its frozen
location, the plan travels through the ledger: whoever creates a run writes the validated plan to
`runs.plan`, and `phasePlan` consumes it.

**This is the right dependency direction independently of the tsconfig.** The worker must never need
an LLM to execute a run. If it imported the Planner, an unavailable model would be a failure in the
execution path; as it stands, a missing plan degrades to the deterministic topological order — the
same code path as `--ablate-planner` — and the run proceeds. The one duplicated thing is the plan's
shape, read defensively in `readStoredPlan`: `runs.plan` is jsonb and can hold anything, including a
plan written by an older build, so anything unrecognised is treated as absent.

---

**D-031 2026-08-04: `OPENAI_API_KEY` names the variable, not the vendor. The provider is
configurable and is currently OpenRouter.**

The frozen blueprint §11 environment table names the variable `OPENAI_API_KEY`, so the name stays.
The credential supplied for CVY-010 is an OpenRouter key (`sk-or-v1-…`), which requires
`OPENAI_BASE_URL=https://openrouter.ai/api/v1`. Both variables are documented in `.env.example`
together, because a key/base-URL mismatch produces a 401 that names the _wrong_ provider —
`api.openai.com` reporting "Incorrect API key provided: sk-or-v1…" — which is a genuinely confusing
five minutes.

`CONVOY_LLM_MODEL` selects the model and must be one supporting structured outputs
(`response_format: {type:"json_schema", strict:true}`). Measured working: `openai/gpt-oss-20b:free`.

**The evals do not depend on this provider staying available.** They replay a committed transcript
in CI; a live re-measurement is what an operator runs when the model or provider changes.

---

**D-032 2026-08-04: CVY-010's acceptance numbers come from ONE set of 30 live completions, measured
twice, and CI replays that recording rather than re-measuring.**

Both eval scripts exist as the card requires, but running each live would double the spend and
produce two numbers from two different samples that could not be compared. Instead
`planner.validJson.eval.ts` ran live (10 runs × 3 trials = 30 completions, recording every one) and
`planner.recall.eval.ts` replayed the same recording. **Both numbers describe the same 30
completions.** CI replays both. The transcripts are committed, so the numbers are checkable rather
than merely reported.

One completion failed at the transport layer and is excluded from both denominators, reported on its
own line as `unreachable`. A dropped connection is not a model that cannot produce JSON, and counting
it as one would be wrong in the flattering direction for the _next_ run and the unflattering
direction for this one — so it is neither counted nor hidden.

---

**D-033 2026-08-05: `over_budget` is TWO deterministic questions, not one, and both may veto.**

The CVY-011 card says `over_budget` comes from "comparing the simulate `gasEstimate` against the
plan's per-item allocation". CVY-007 had already shipped `canAfford`, which compares that same
allocation against what is left in the meter. The units did not line up — gas estimate in UNITS,
allocation in USDC — and reconciling them wrong is exactly how a valid item gets vetoed for the
wrong number.

They are different questions and both are now asked:

| Function          | Question                                                  | Compares                                    |
| ----------------- | --------------------------------------------------------- | ------------------------------------------- |
| `canAfford`       | Can the RUN still pay for a slice this size?              | allocation vs meter remaining               |
| `projectItemCost` | Does THIS ITEM cost more than the slice the plan gave it? | gasEstimate × gasPrice → USDC vs allocation |

Neither outranks the other; either firing is a real veto, because either means the run cannot honour
the plan as written. Both are arithmetic and **neither is the model's to decide** — a model
`VETO(over_budget)` that the projection does not corroborate is discarded, exactly as an
uncorroborated `VETO(would_revert)` is.

**The projection is L2-only and therefore understates by roughly 2.4%.** At simulate time there is no
receipt, so there is no `l1Fee` to add (gap G-28). That error is left in rather than padded out,
because it errs toward APPROVE and the acceptance bar that matters is **zero false vetoes**. Padding
would trade a hard bar for a soft one.

`unknown` — no allocation, or no gas price — is never a veto. The gas price is read once per phase
from `eth_gasPrice`; when the RPC cannot be reached the projection is reported as unavailable rather
than guessed, because an item vetoed on arithmetic nobody can reproduce is worse than an item not
checked.

---

**D-034 2026-08-05: a veto that cites nothing is not a finding, and is discarded.**

The Critic's instruction requires a VETO to quote the evidence line the action contradicts. That
requirement is enforced in `corroborate`, not merely requested in the prompt: a veto arriving with an
empty `evidenceQuote` is discarded and the discard is recorded in `overrides`.

This cuts one way, deliberately. The hard acceptance bar is 5/5 valid items passed, a false veto
costs a real epoch and a human re-run, and "this looks wrong" is not evidence. The quote is checked
for **existence only** — never matched as a substring against the evidence — because a model that
paraphrases a real contradiction has still found one, and substring matching would discard a true
finding for style.

The same rule discards a `VETO` carrying the `none` sentinel: there is no closed-enum value to record
against the item, and inventing one would be worse than dropping it.

---

**D-035 2026-08-05: a manifest is an immutable terminal-run snapshot; its sha256 excludes only its
own stamp and is computed over canonical JSON.**

Export is available only after a run reaches `SEALED_OK`, `SEALED_PARTIAL`, `ABORTED`, or
`FAILED_FATAL`. The first export reads the three live sources, stores the stamped JSON and 32-byte
digest in `manifests`, and every later export serves that row. This is what makes the demo resilient
to an RPC outage without silently changing history between downloads.

The digest is `sha256(canonicalJson(payload))`, where object keys are recursively sorted and arrays
retain their recorded order. The `sha256` field itself is then appended. Cached reads recompute the
digest and compare it both with the JSON stamp and the `manifests.sha256` byte column; a corrupted
row is rejected rather than served.

Registry log reads are bounded by the ledger's real `RUN_OPENED` and `RUN_SEALED` transaction
blocks. Scanning Base Sepolia from genesis is not a reliability strategy — ordinary dedicated RPCs
cap log ranges. The ledger supplies only the range anchor; the emitting contract, operator,
payloadHash, sequence, transaction hash and current registry storage all still come from chain.
