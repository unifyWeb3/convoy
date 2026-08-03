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
