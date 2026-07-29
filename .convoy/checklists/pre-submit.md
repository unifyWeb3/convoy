# Pre-submission checklist (CVY-019)

Deadline: **Aug 13 2026 12:00 UTC+2**. Target submission: **Aug 12** — a day early.
"Incomplete submissions cannot be judged."

## The three hard requirements

- [ ] **Public GitHub source** — repository is public, builds from a clean clone, README is current.
- [ ] **Demo video ≤3 minutes** showing the agent executing onchain **through KeeperHub**.
- [ ] **A link to a transaction the agent executed via KeeperHub** — a real Basescan link, live and
      clickable.

## Clean-clone verification

```bash
git clone <repo> /tmp/convoy-clean && cd /tmp/convoy-clean
cp .env.example .env   # fill in
./scripts/bootstrap.sh
pnpm tsx scripts/verify-env.ts
```

- [ ] Bootstrap succeeds from scratch on a fresh machine.
- [ ] `verify-env` matrix is all PASS.
- [ ] No secret is committed anywhere: `git log -p | grep -iE "kh_live|sk-|0x[0-9a-f]{64}"` finds
      nothing real.

## Judging axes (execution is weighted heavily)

- [ ] **Executes onchain via KeeperHub** — working transactions, not mockups. Every claim in the
      honesty table links to a real Basescan transaction or an export line.
- [ ] **KeeperHub surfaces used** — direct-execution REST, MCP (`kh_` Bearer), CLI backup path,
      audit trail, and x402 (or its documented cut).
- [ ] **Reliability and observability** — the timeline shows real state transitions, real retry
      chips from genuine transient codes, and real gas; crash-resume is proven by the
      kill-worker-no-duplicate-tx test.
- [ ] **Originality and usefulness** — the ablation numbers are in the README and reproducible with
      one command.
- [ ] **Integration quality / DX** — a clean kh-client boundary, task cards, and playbooks.

## Honesty

- [ ] Every honesty-table row has a real artifact, or is marked as cut/pending — no unbacked claims.
- [ ] `MockRewardDistributor` is clearly labelled as a demo stand-in.
- [ ] Any cut feature (x402, DAG view, onchain gate, approval gate, 3-way manifest) is **disclosed**.
- [ ] No fabricated hash, staged failure, or injected fault exists anywhere in the repository or the
      video.
- [ ] The ETH price used for gas→USDC (`runEthUsd`) is disclosed in the manifest.

## Final state

- [ ] `docs/IMPLEMENTATION_STATUS.md` reflects the true final state, including anything cut.
- [ ] `docs/KNOWN_GAPS.md` is current; no OPEN gap is silently unresolved.
- [ ] All four demo backup paths were rehearsed (`.convoy/playbooks/demo.md`).
- [ ] Playwright `demo.spec.ts` is green against the production deployment.
- [ ] A real morning run's hashes are already on Basescan as backup path a.

## Stackable bounty (buffer D16–D17)

- [ ] Onboarding-UX bounty deliverable shipped: a starter template plus a zero-to-first-tx teardown
      PR. A project can place top-three **and** win a bounty.

## Submit

- [ ] BUIDL submitted on DoraHacks with source link, video link, and transaction link.
- [ ] Submission confirmed received, well before Aug 13 12:00 UTC+2.
