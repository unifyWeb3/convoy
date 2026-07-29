# Repository conventions

## Layout

```
apps/web            @convoy/web      Next.js 14 App Router — UI + API routes
services/worker     @convoy/worker   Node 22 BullMQ worker — runs OFF Vercel
packages/kh-client  @convoy/kh-client  the ONLY module that touches KeeperHub
packages/db         @convoy/db       Prisma schema, migrations, seed, client singleton
packages/contracts  (Foundry)        Solidity — not a pnpm workspace consumer
scripts/            bootstrap, verify-env, first-tx, ablation
tests/fixtures/     Planner/Critic eval fixtures and VCR tapes
docs/               frozen reports + living tracking documents
.convoy/            the AI operating system (this directory)
```

## Package rules

- Package names are always `@convoy/<name>`. Internal dependencies use `workspace:*`.
- Dependency direction is one-way and must not cycle:
  `web → {kh-client, db}`, `worker → {kh-client, db}`, `kh-client → (nothing internal)`,
  `db → (nothing internal)`.
- Every TypeScript package exposes the same four scripts: `build`, `typecheck`, `lint`, `test`.
  `pnpm -r <script>` must work across the whole workspace.
- `packages/contracts` is Foundry-only. It is driven by `forge`, not by pnpm scripts.

## Naming

- Milestones: `CVY-NNN`, zero-padded, one task card per milestone in `.convoy/tasks/CVY-NNN.md`.
- Gaps: `G-NN` in `docs/KNOWN_GAPS.md`.
- Decisions: `D-NNN` in `docs/DECISIONS.md`.
- Branches: `cvy-NNN-short-slug`. One milestone per branch and per PR.
- TypeScript files are `camelCase.ts`; React components are `PascalCase.tsx`; Solidity files match
  their contract name.

## Documents that must be updated every milestone

1. `docs/WORKLOG.md` — **append only**, never rewrite history.
2. `docs/IMPLEMENTATION_STATUS.md` — the live truth for the next milestone.
3. `docs/KNOWN_GAPS.md` — on any friction. Record the gap; do not redesign around it.
4. `docs/DECISIONS.md` — on any decision, as `D-NNN <date>: decision, rationale`.
5. `docs/TESTING.md` — when tests are added.
6. `docs/DEPLOYMENT.md` — when deployment or rollback changes.

## Frozen documents

`docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_BLUEPRINT.md`, and `docs/PRODUCT_DISCOVERY.md` are
**frozen**. Do not summarise, reformat, reinterpret, or edit them. If the architecture and the
blueprint appear to conflict, **the architecture wins** and the friction is logged in
`docs/KNOWN_GAPS.md` — never resolved by redesigning.

## Secrets

- Real secrets live only in `.env` (gitignored) and in the Vercel dashboard. `.env.example` carries
  every variable with a **safe** example value and a purpose comment.
- Convoy's runtime holds no private key. `DEPLOYER_PRIVATE_KEY` exists for `forge script` only and
  may be referenced only under `packages/contracts/script`.
- The `kh_` Bearer key is server-side only and is never shipped to the browser.

## Verification order (before any commit)

```
format → lint → typecheck → build → tests → KeeperHub proof (if integration touched)
```

The KeeperHub proof is a real simulate JSON payload or a real transaction hash with its Basescan
link. Never a fabricated hash.
