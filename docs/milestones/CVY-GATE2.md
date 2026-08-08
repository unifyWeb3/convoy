# CVY-GATE2 Milestone Report — Full 12-item checkpoint

**Date:** 2026-08-07
**Decision:** PASSED WITH OPERATIONAL CONSTRAINTS
**Commit:** uncommitted; preserved for review

## Decision

The complete twelve-item Base Sepolia path works with the existing serial-fanout option: plan phase,
real simulation critique, dependency release, KeeperHub execution, seal, live DAG, refresh and
manifest export. Ten actions landed and two were genuinely vetoed before execution.

This is not an unconditional stability claim. A first run at the configured fanout of four produced
two real KeeperHub wallet `InvalidNonce()` reverts and sealed partial. The successful proof used
`fanout=1`. The manifest is also honestly amber because the configured RPC provider rejected a
single full-range log request. No frozen cut is applied: the React Flow DAG and three-source manifest
remain present, with G-40 through G-43 recording the operational friction.

## Run attempts

| Attempt                 | Database run                           | Onchain run                                                          | Fanout | Result           |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------- | -----: | ---------------- |
| Concurrency measurement | `85e0be28-6266-4984-86c8-7b7b2ca5f370` | `0x1d1d0941e7b8c419dba183ef352985acfe2fde0afaab3d0db44f61989a13b66a` |      4 | `SEALED_PARTIAL` |
| Gate proof              | `92d39479-9271-4944-9ca9-5421b94aefd9` | `0x67c8df702f10cd6e70dc735b0465d48dca038775ee47c6a21d429858203a9f48` |      1 | `SEALED_OK`      |

The fanout-four run opened in
[`0x3d31…71cc`](https://sepolia.basescan.org/tx/0x3d31b5b7d862bd3587146b0fafce0f26b774dd13dd22a448b81bc59013df71cc)
and sealed partial in
[`0xe1e3…60a9f`](https://sepolia.basescan.org/tx/0xe1e3dd904d8e88b27f65d9a0a0e9d216ab8642facb4e0b56906d34e61a560a9f).
The two failed target writes are real reverted transactions:
[`0xd25e…71ff`](https://sepolia.basescan.org/tx/0xd25ebf1c1de167b3f5673067856e02f5a6d19d2d722b5b0e0fe0de8df47e71ff)
and
[`0xd208…2ca`](https://sepolia.basescan.org/tx/0xd2082690fba0487dc73d4c55e1672bdea35c49f04195d6dc6f5e74d6400562ca).
`cast run` decoded both wallet reverts as selector `0x756688fe`, `InvalidNonce()`. Convoy made every
write through KeeperHub, set no nonce and did not inject the failure.

The serial proof opened in
[`0xd847…f534`](https://sepolia.basescan.org/tx/0xd847ed057d99d43b53961eff1a0a160448716906ce4bd63c276ddc2136a4f534)
and sealed OK in
[`0x1e6b…5560`](https://sepolia.basescan.org/tx/0x1e6b370a7583431694d8faafbd4c7cc61cc3340bc2ac36de80ed21287e625560).

## Twelve-item result and transaction evidence

| Item | Action                   | Dependencies | Final  | Registry commit                                                                                                     | Target write                                                                                                        |
| ---: | ------------------------ | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
|    0 | `fund(1000000)`          | —            | LANDED | [`0xf7ab…b280`](https://sepolia.basescan.org/tx/0xf7ab4b0f80e215083f71a75bb715ec3b0459fb68111803e43d062dab0f01b280) | [`0x5513…2335`](https://sepolia.basescan.org/tx/0x55135303255eb58ece1137bc8c734191a20a80855cf786459843c9f284dd2335) |
|    1 | `enableMarket(33080701)` | 0            | LANDED | [`0x0d03…253a`](https://sepolia.basescan.org/tx/0x0d03aa46e33c4e75c371b0dd73981c10630673b625c0195c4eac5b4bedab253a) | [`0x6b80…9be5`](https://sepolia.basescan.org/tx/0x6b80424cd188eb57997c2dc648787522591435466bfe207e57a4213991709be5) |
|    2 | `enableMarket(33080702)` | 1            | LANDED | [`0x51fa…b85d`](https://sepolia.basescan.org/tx/0x51faea5abfcf3011b0354e3d132f3fd5b18a59aed7673716453146832109b85d) | [`0x604e…d146`](https://sepolia.basescan.org/tx/0x604e3eaf480754f41182165a80020970c380a5d5d10082f3dfd509a06c6ed146) |
|    3 | `enableMarket(33080703)` | 0            | LANDED | [`0xdf96…3ae6`](https://sepolia.basescan.org/tx/0xdf96cc4c25f72d4da53bee1683b585c8a009bcda0056c6f284c4a095c0c63ae6) | [`0x8c74…2915`](https://sepolia.basescan.org/tx/0x8c743544b68c549bf547d5261bd2a8f68fb13185bc0ac88e99540391b12a2915) |
|    4 | `fund(2000000)`          | —            | LANDED | [`0x020b…4780`](https://sepolia.basescan.org/tx/0x020bf2847ca89bda2dd1cc7425459a78812e8fc8cd25f1f957f18c5262f84780) | [`0x2985…7bd2`](https://sepolia.basescan.org/tx/0x2985bbb3cfec5fca7040e8cd0b9ecc1a2cb56b68f7e44ad5cde12803dab27bd2) |
|    5 | `enableMarket(33080704)` | 4            | LANDED | [`0x4c4d…c0f8`](https://sepolia.basescan.org/tx/0x4c4da5d1c9225225a63d5125d30f37d0882e7fd5a8cc9d373ed5899b7271c0f8) | [`0x1a86…2570`](https://sepolia.basescan.org/tx/0x1a86d4ae75012fecebbee6b38231fc195d029601e74dce0f18d0ed08fe412570) |
|    6 | `enableMarket(33080705)` | —            | LANDED | [`0xac61…41ef`](https://sepolia.basescan.org/tx/0xac6149e6d56e54f5e256c60c09654dfaaa8c3d9cc60763004034228820d941ef) | [`0xfdb6…cb6e`](https://sepolia.basescan.org/tx/0xfdb64d9820f436f308f6acd57c7ef0e01b7ec7d3c25bb2ff0b1d95f2fbc4cb6e) |
|    7 | `enableMarket(1)`        | —            | VETOED | —                                                                                                                   | —                                                                                                                   |
|    8 | `setRoot(0xc3…c3)`       | —            | VETOED | —                                                                                                                   | —                                                                                                                   |
|    9 | `enableMarket(33080706)` | 0            | LANDED | [`0xf386…824f`](https://sepolia.basescan.org/tx/0xf38618858f09c45627714d96a78d58b69e6774457c96203299266fecf616824f) | [`0xde31…e2b4`](https://sepolia.basescan.org/tx/0xde311df7144bf8cfbdc5625f28fac347dff22ec1eb45329655fd564d097be2b4) |
|   10 | `enableMarket(33080707)` | 9            | LANDED | [`0x0357…3b0a`](https://sepolia.basescan.org/tx/0x035707b65d45ac4b6fcc16418dedee3ea39e607534105f9c2d83f884c4d53b0a) | [`0x8e25…2faa`](https://sepolia.basescan.org/tx/0x8e256af6c6b8397d032a49642855cfa18b30f31eaa51fbe947b1fa76f6442faa) |
|   11 | `fund(3000000)`          | 4            | LANDED | [`0xf86e…e823`](https://sepolia.basescan.org/tx/0xf86e69dd0ccd39fbdd87013192d28f19399e491bb7e0d2136738d13bb027e823) | [`0x0399…b111`](https://sepolia.basescan.org/tx/0x0399fef697b88d51ea4182afacbba51d482013e7deb87da5b2369787ffe6b111) |

Item 7's real `simulate:true` request returned HTTP 400, `wouldRevert:true`, selector `0x30f065ef`
decoded as `MarketAlreadyEnabled()`. Item 8 returned HTTP 400, `wouldRevert:true`, selector
`0xb466ddbf` decoded as `RootAlreadySet()`. Neither item produced a commit or target write, and both
carry zero gas.

## Dependencies, DAG and onchain state

The declared edges are `0→1`, `1→2`, `0→3`, `4→5`, `0→9`, `9→10` and `4→11`. Execution released in
three deterministic waves: `[0,4,6]`, `[1,3,5,9,11]`, then `[2,10]`. Every dependency-bearing
`ITEM_SUBMITTED` event recorded the real check-and-execute result:

```json
{
  "met": true,
  "observedValue": "true",
  "targetValue": "true",
  "operator": "eq"
}
```

The dependency used by the atomic guard matched the single declared prerequisite for each of items
1, 2, 3, 5, 9, 10 and 11. The app-side gate released no dependent before its prerequisite was
`LANDED`; each dependent target executed exactly once.

Post-run read-only RPC evidence found registry state `2` (`Sealed`), `committedCount == 10`, true
commitments at indices 0–6 and 9–11, and false commitments for vetoed indices 7 and 8. Markets
33080701 through 33080707 were all enabled.

The live browser attempt rendered twelve React Flow nodes and seven directed edges. A waiting edge
was dashed and animated while its target was deferred, then the edge became ready after the
prerequisite landed. The same attempt refreshed during execution and replayed the timeline from the
database before continuing its open SSE stream.

## Budget evidence

| Field                                   |       Observed value |
| --------------------------------------- | -------------------: |
| Budget                                  |    `120.000000 USDC` |
| Frozen ETH/USD                          |        `3400.000000` |
| Real receipt gas consumed, notional USD | `0.0137003181313466` |
| Persisted six-decimal gas spend         |           `0.013700` |
| Payment spend                           |           `0.000000` |
| Org-wallet debit recorded by the meter  |           `0.000000` |

All ten successful target execution records reported `sponsored:true`. The gas units and receipt
fees are real; the USD conversion is notional and the zero debit is specific to these sponsored
records, not a claim that KeeperHub sponsorship is permanent.

## Manifest evidence

- Local canonical artifact: `/tmp/convoy-gate2-manifest.json`
- Size: 63,783 bytes
- SHA-256: `0xe1294cefc61b9141279499c5bb2ab84af23c751c61b790d3380eb400296dc8ca`
- Overall verdict: `amber`; all twelve rows amber
- KeeperHub status and ledger attempts agree for every item
- Registry source unavailable because the provider permits only ten-block log ranges and the
  exporter requested the complete open-to-seal range

The separate storage reads above corroborate the registry result but are not relabelled as manifest
green. The raw registry error embeds the configured RPC credential, so neither the raw artifact nor
the original manifest screenshot is safe to publish (G-42).

## Browser evidence

The live attempt produced local screenshots of the waiting DAG and post-refresh timeline. That
attempt later failed because the test counted page-wide list items and expected the wrong terminal
label; the application had already supplied the intended live evidence.

After correcting only those selectors, the terminal-only run passed:

```text
1 passed (34.4s)
```

It verified 12 run rows, 10 landed rows, two vetoed rows with both decoded reasons, 12 DAG nodes,
seven ready edges and 12 amber manifest rows. Clipboard permission was denied, but the manifest API
loaded and rendered. The original manifest screenshot contains the credential described by G-42 and
is not evidence for distribution. The spec now masks registry-error cells in future screenshots.

No claim is made that one corrected Playwright invocation passed continuously from live start through
seal. The live DAG/refresh phases and the passing terminal DAG/manifest phase are separate evidence.

## Entrypoint and phase caveat

The task card's `POST /api/runs` route returns 501 and `tests/fixtures/batch-12item.json` is absent.
The gate used `services/worker/scripts/gate2.mjs` to write the twelve validated items and invoke the
existing `runBatch` driver. `phasePlan` used its documented deterministic declared-edge fallback.
`phaseCritique` made real KeeperHub simulations, but no LLM Critic port was wired; the two real
simulation reverts were independently sufficient vetoes. Execution, deferral, check-and-execute,
accounting and sealing used the production orchestrator paths.

This proves the direct orchestrator path, not API-to-queue submission. G-43 links that missing start
path to the already-open BullMQ integration gap G-33 and defers it to CVY-015.

## Verification

The test record keeps the failures and the successful isolation runs separate:

| Command                                                             | Exact result                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm --filter @convoy/kh-client test`                              | PASS — 8 files, 130 tests                                                           |
| First `pnpm -r test`                                                | FAIL — local Postgres was absent at `localhost:5432`; 25 DB tests could not connect |
| `pnpm -r test` against the stale shared GATE2 DB                    | FAIL — DB 34/35; the first schema query timed out at 5 seconds                      |
| `pnpm --filter @convoy/db test` against the same stale process      | FAIL — DB 34/35; the same first schema query timed out                              |
| First `pnpm --filter @convoy/worker test` against the stale process | FAIL — worker 94/95; the first DB create reported the server unreachable            |
| `pnpm --filter @convoy/db test` after clean isolated DB restart     | PASS — 2 files, 35 tests                                                            |
| `pnpm --filter @convoy/worker test` after clean isolated DB restart | PASS — 8 files, 95 tests                                                            |
| `pnpm --filter @convoy/web test`                                    | PASS — 6 files, 81 tests                                                            |
| `pnpm -r typecheck`                                                 | PASS — db, kh-client, worker and web                                                |
| `pnpm run typecheck:scripts`                                        | PASS                                                                                |
| `pnpm -r lint`                                                      | PASS — db, kh-client, worker and web                                                |
| `pnpm --filter @convoy/db build`                                    | PASS                                                                                |
| `pnpm --filter @convoy/kh-client build`                             | PASS                                                                                |
| `pnpm --filter @convoy/worker build`                                | PASS                                                                                |
| Isolated `next build` against the copied current web source         | PASS — compiled, typechecked, collected page data and generated 7/7 static pages    |
| `pnpm exec eslint apps/web/e2e/demo.spec.ts --max-warnings 0`       | PASS                                                                                |
| `node --check services/worker/scripts/gate2.mjs`                    | PASS                                                                                |
| `git diff --check`                                                  | PASS — no output                                                                    |
| Four invariant grep guards from `.convoy/checklists/review.md`      | PASS — no output from all four                                                      |

The exact `pnpm -r build` invocation in the isolated copy failed before any package build because
pnpm could not open its store metadata through the copied workspace and then attempted a blocked
registry fetch. The installed Next binary was therefore invoked directly against the copied source;
the other three package builds ran normally in the repository. This kept the concurrent UI dev
server's shared `.next` directory untouched and avoided reproducing G-39.

G-32 remains open. A fresh isolated database made both affected suites green, but the earlier
timeout and connection failure are still gate results, not erased reruns.

## Gate disposition

- **PASS**, constrained to the existing serial-fanout option for the full demo.
- Preserve the honest amber manifest; do not claim three-source green.
- Apply no cut: the React Flow DAG and three-source reconciliation remain.
- Keep G-40 through G-43 open for scoped follow-up.
- Stop here. No post-gate milestone is part of this session; the next critical-path work is CVY-015.
