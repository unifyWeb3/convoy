# Coding standards

The first block is the frozen excerpt from the Implementation Blueprint §3. It is authoritative.

```markdown
- TypeScript strict. No `any` in exported signatures. Zod-validate all external input (LLM, KH, HTTP body).
- All KeeperHub access goes through packages/kh-client. No raw fetch to app.keeperhub.com elsewhere.
- State transitions are transactional (prisma.$transaction) and emit exactly one events row.
- Idempotent handlers keyed (runId, itemIdx, phase): reconcile-before-act; safe to re-run.
- viem chain pinned to baseSepolia (84532, DEC-001) via a dedicated RPC. Never eth_getLogs on a
  public RPC.
- Money: numeric(20,6) in DB; bigint/string for wei; never float wei.
- Solidity 0.8.24, custom errors (no require strings), operator-bound access control.
- Conventional commits: feat/fix/test/docs/chore(scope): subject. One milestone per PR.
```

## Applying the standards

### TypeScript

- `strict: true` plus `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax` — inherited from `tsconfig.base.json`. Do not weaken these per package.
- Exported functions declare explicit return types. `any` is banned in any exported signature;
  prefer `unknown` plus a zod parse at the boundary.
- Every value crossing a trust boundary is zod-validated **at the boundary**: HTTP request bodies,
  KeeperHub responses, LLM output, and environment variables.
- Errors are typed. The kh-client exports a discriminated error union; callers switch on it rather
  than inspecting HTTP status codes themselves.

### KeeperHub boundary

- `packages/kh-client` is the **only** module permitted to reach `app.keeperhub.com`. A CI
  grep-guard fails the build on any other occurrence.
- All KeeperHub drift is absorbed inside that package and recorded in `docs/KNOWN_GAPS.md`:
  send both `chainId` and `network` (G-01); treat a terminal POST response as terminal and
  short-circuit the poll (G-02); classify 403 (daily cap) and 422 (wallet not configured) as
  fatal-to-run (G-03).
- Use the REST vocabulary only: `contractAddress`, `functionName`, `functionArgs`, `abi`.
  **Never** `abiFunction` — that belongs to the MCP _workflow_ vocabulary, which Convoy does not use.
- **Never** call `call_workflow` for a write. It returns unsigned calldata for the caller to submit,
  which bypasses the entire reliability stack Convoy depends on.
- Every write carries `Idempotency-Key: <runId>:<idx>:<attempt>`. Simulate calls are exempt.

### State and persistence

- A transition writes its state change and its `events` row inside one `prisma.$transaction`.
  Exactly one event row per transition — the timeline, the audit trail, and the manifest must
  never disagree.
- `events` is append-only. Never update or delete an event row.
- Handlers are idempotent and keyed `(runId, itemIdx, phase)`. Re-running a handler must be safe;
  reconcile against KeeperHub status before acting.

### Money and units

- Database money columns are `numeric(20,6)` mapped to Prisma `Decimal`.
- Wei is `bigint` in memory and `string` on the wire. **Never** a JavaScript float.
- The only gas→USDC conversion is the pinned formula:
  `gas_used_usdc = (Number(gasUsedWei) / 1e18) * runEthUsd`, with `runEthUsd` frozen at run open.

### Solidity

- `pragma solidity 0.8.24`, custom errors only (no `require` strings), operator-bound access
  control, slot-packed structs.
- Reverts are a product feature: they are what `simulate:true` decodes into `revertReason`.
- `forge fmt --check` must be clean before commit.

### Banned in non-test code

- Setting a nonce anywhere (`nonce:` in a client or worker payload).
- Referencing `PRIVATE_KEY` outside `packages/contracts/script`.
- Staged failures: `mockRevert`, hard-coded fake transaction-hash literals, or
  `throw new Error("fake...")`.
- `// TODO(impl)` in an exported symbol — ship the feature or record a documented cut.

All four are enforced by grep-guards in `.github/workflows/ci.yml`.

### Commits

Conventional commits, one milestone per commit/PR:
`feat(kh-client): add simulate + status polling` · `test(contracts): invariant for idx monotonicity`
Scopes: `contracts`, `kh-client`, `db`, `worker`, `web`, `scripts`, `ci`, `docs`, `convoy`.
