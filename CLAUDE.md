# CONVOY — Claude Code entrypoint
Convoy is an autonomous onchain release operator: plan a batch of interdependent onchain ops
(LLM Planner), critique each against a real KeeperHub simulation (LLM Critic), execute survivors
through KeeperHub's org Turnkey wallet, export a replayable manifest. Execution is the product.
Hackathon: KeeperHub Agents Onchain (submit before Aug 13 2026 12:00 UTC+2).

## Golden rules (never break)
1. Product + Architecture reports are FROZEN. Do not redesign, add features, optimize the
   protocol, or add alternatives. Friction → docs/KNOWN_GAPS.md.
2. Convoy holds NO private keys and implements NO relayer. Every chain write is a KeeperHub call.
3. Convoy NEVER sets a nonce. Onchain retries are KeeperHub's; Convoy only OBSERVES them.
4. NEVER stage a failure, inject a gas spike, or fake a retry/hash. Only structurally-real
   sources (real simulate-vetoes, real nonce serialization, real transient codes).
5. One milestone per session. Implement ONLY the highest unfinished CVY-XXX, then STOP.

## Start-of-session ritual
1. Read docs/WORKLOG.md (tail), docs/IMPLEMENTATION_STATUS.md, docs/KNOWN_GAPS.md.
2. Determine the highest unfinished milestone from IMPLEMENTATION_STATUS.md.
3. Open .convoy/tasks/<CVY-ID>.md and follow it exactly. Do not duplicate completed work.

## Commands (pnpm, Node 22, Foundry, Prisma, Next 14)
Build, test, lint, typecheck, format, db, dev and contract commands are root `package.json`
scripts — read them there. Run the ROOT script (`pnpm typecheck`), not the recursive form
(`pnpm -r typecheck`): only the root script also runs `typecheck:scripts`, and that gap is how CI
stayed red for several milestones.
Only the two that are not scripts:
E2E: pnpm --filter @convoy/web exec playwright test
Ablation: pnpm tsx scripts/ablation.ts --ablate-planner|--ablate-critic

## KeeperHub facts (verified — do not invent capabilities)
- POST https://app.keeperhub.com/api/execute/contract-call ; Authorization: Bearer kh_...
  Body: { chainId:"84532", network:"84532", contractAddress, functionName,
          functionArgs:"[...]"(JSON-array string), abi?, value?, gasLimitMultiplier?, simulate? }
- Writes execute SYNCHRONOUSLY → 202 { executionId:"direct_...", status:"completed"|"failed" }.
- simulate:true (strict boolean) → 200 {wouldRevert:false,gasEstimate,...} or 400 {wouldRevert:true,revertReason:"Error(...)"}.
- GET /api/execute/{id}/status → {status,transactionHash,transactionLink,gasUsedWei}; honor X-Poll-Interval-Hint (0=terminal).
- Idempotency-Key: <runId>:<idx>:<attempt> (per-org, 24h; simulate exempt).
- Errors: 401 fatal, 403 daily-cap fatal-to-run, 422 wallet-not-configured fatal-to-run, 429 backoff+Retry-After.
  Coded run errors E-000x/N-000x/P-000x/C-0001-2 transient (retry observed). config-revert (full msg, no code) = item FAILED, no retry.
- PRIMARY CHAIN = Base Sepolia 84532 (DEC-001: dev, rehearsal, demo). Base mainnet 8453 is an
  OPTIONAL final demo target at CVY-019 only — parameterised, never removed. BASE_RPC_URL holds a
  Sepolia endpoint; verify-env pins 0x14a34. x402 has no Sepolia path (G-17); testnet USD is
  notional (G-18). USDC Base mainnet=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
- call_workflow returns UNSIGNED calldata for cross-org writes — Convoy does NOT use it. Direct-exec only.
- Convoy uses REST vocabulary (contractAddress/functionName/functionArgs/abi). NEVER abiFunction.

## Invariants (verify every commit)
Repo builds; every milestone ends deployable; no partial features; no duplicated KH functionality;
no staged failures; Convoy never sets a nonce; Convoy never holds a key.

## Detailed docs (progressive disclosure)
Lifecycle & rules: docs/AI_WORKFLOW.md | Task cards: .convoy/tasks/CVY-*.md
Recovery: .convoy/playbooks/recovery.md | Tests: docs/TESTING.md | Deploy: docs/DEPLOYMENT.md
