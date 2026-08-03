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
