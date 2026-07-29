# Release playbook

Covers contract deployment, web deployment, worker deployment, and rollback. Every step here matches
`docs/DEPLOYMENT.md`; this file is the operational sequence.

## 0. Preconditions

```bash
pnpm tsx scripts/verify-env.ts        # PASS/FAIL matrix — no unexplained FAIL
pnpm -r lint && pnpm -r typecheck && pnpm -r build && pnpm -r test
cd packages/contracts && forge fmt --check && forge build && forge test && cd -
```

`docs/IMPLEMENTATION_STATUS.md` shows the release milestone as the highest unfinished one, and
`docs/KNOWN_GAPS.md` contains no OPEN gap that blocks it.

## 1. Contracts — testnet first (Base Sepolia 84532)

```bash
cd packages/contracts
forge script script/Deploy.s.sol --rpc-url base-sepolia --broadcast --verify --chain base-sepolia
```

Record the addresses. Run `scripts/first-tx.ts` against Sepolia to prove the whole KeeperHub write
path before touching mainnet.

## 2. Contracts — mainnet (Base 8453)

```bash
cd packages/contracts
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify --chain base
```

- Verification uses the **single Etherscan API V2 key** (`ETHERSCAN_API_KEY`). Legacy per-chain V1
  keys have been deprecated since 2025-08-15 and are no longer accepted.
- `DEPLOYER_PRIVATE_KEY` is used **here only**, by `forge script`. It never enters app or worker
  runtime.
- Record the verified addresses into `.env` (`CONVOY_REGISTRY_ADDR`, `MOCK_DISTRIBUTOR_ADDR`), the
  Vercel dashboard, `docs/DEPLOYMENT.md`, and the README artifact table.

## 3. KeeperHub verification

- Confirm the org wallet: `get_wallet_integration` via MCP (or `/mcp` in Claude Code) returns a
  configured wallet — **not** a 422.
- Run one `simulate:true` call and confirm `{wouldRevert, gasEstimate}` comes back.
- Run one real write and confirm `transactionHash` + `transactionLink` from the status endpoint.

## 4. Web — Vercel

- **Git integration only. Never deploy with the Vercel CLI.**
- One project, Root Directory `apps/web`, environment variables set in the dashboard.
- Push to `main` triggers production. A preview deployment is produced for every PR; `e2e.yml` runs
  Playwright against it on `deployment_status == success`.

## 5. Worker — off Vercel

Vercel cannot host a long-lived process. Deploy `services/worker` to a small always-on host
(Railway/Fly), or run it locally for the demo. It needs `DATABASE_URL`, `REDIS_URL`,
`KEEPERHUB_API_KEY`, `BASE_RPC_URL`, and `CONVOY_ETH_USD`. Confirm graceful shutdown: `SIGTERM`
drains in-flight jobs via `worker.close()`.

## 6. Database

Forward-only migrations: `pnpm --filter @convoy/db db:migrate` (`migrate deploy` in production).
Take a snapshot before the demo.

## 7. Rollback

| Layer     | Rollback                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------- |
| Contracts | Immutable. Deploy a **fresh instance** and update `CONVOY_REGISTRY_ADDR`. Never migrate state. |
| Web       | Vercel → "Promote previous deployment".                                                        |
| Worker    | Redeploy the previous image/commit; in-flight items are recovered by `reconcile.ts`.           |
| Database  | Forward-only. Restore the pre-demo snapshot if a migration is destructive.                     |

## 8. Final demo release

Deploy on the morning of the demo, run one real morning batch whose hashes are already on Basescan
(demo backup path a), then **freeze the environment**. No configuration changes after the rehearsal.
