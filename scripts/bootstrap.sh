#!/usr/bin/env bash
set -euo pipefail
# CONVOY fresh-environment bootstrap (WSL2/Ubuntu, Node 22)
node -v | grep -q "v22" || { echo "Node 22 required (nvm install 22)"; exit 1; }
corepack enable && corepack prepare pnpm@latest --activate
command -v forge >/dev/null || { curl -L https://foundry.paradigm.xyz | bash && foundryup; }
[ -f .env ] || { cp .env.example .env; echo "Fill .env, then re-run"; exit 1; }
pnpm install
( cd packages/contracts && forge install && forge build && forge test )
pnpm --filter @convoy/db db:generate
pnpm --filter @convoy/db db:migrate
pnpm --filter @convoy/db db:seed
pnpm -r build
pnpm -r test
pnpm tsx scripts/verify-env.ts
echo "Bootstrap complete. Next: pnpm tsx scripts/first-tx.ts (land the first Base tx)."
