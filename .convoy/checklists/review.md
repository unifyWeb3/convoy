# Milestone review checklist

The block below is the frozen checklist from the Implementation Blueprint §3. Every box must be YES.

```markdown
# Milestone review checklist (all YES)

- [ ] Scope = exactly one CVY milestone; no extra features.
- [ ] pnpm -r build passes; pnpm -r test passes; forge test passes (if contracts touched).
- [ ] forge fmt --check + lint + typecheck clean.
- [ ] No raw fetch to app.keeperhub.com outside packages/kh-client.
- [ ] Every state transition transactional and emits one events row.
- [ ] No nonce set anywhere; no key held anywhere; no staged failure anywhere.
- [ ] KH proof attached if integration touched (simulate JSON or tx hash + Basescan link).
- [ ] Architecture invariants intact (§16); kill-list items not resurrected (§17).
- [ ] WORKLOG appended; IMPLEMENTATION_STATUS updated; KNOWN_GAPS updated if friction.
- [ ] Demo scenario still runs (or explicitly N/A pre-CVY-010).
- [ ] Milestone report generated. Session STOPS here.
```

## How to check the mechanical ones

```bash
# no KeeperHub fetch outside the client package
grep -rn "app\.keeperhub\.com" apps packages services scripts \
  --include=*.ts --include=*.tsx | grep -v "^packages/kh-client/"

# no nonce set in client or worker payloads
grep -rn "nonce[[:space:]]*:" packages/kh-client/src services/worker/src apps/web/lib

# private key referenced only under packages/contracts/script
grep -rln "PRIVATE_KEY" apps packages services scripts | grep -v "^packages/contracts/script/"

# no staged failures in non-test code
grep -rnE "mockRevert|fakeTxHash|throw new Error\(\"fake" apps packages services scripts \
  --include=*.ts --include=*.tsx | grep -vE "(test|spec|__tests__|fixtures)"
```

Each command must return **no output**. These are the same guards `.github/workflows/ci.yml` runs.

## Kill-list check (architecture §13 / blueprint §17)

Confirm none of these was resurrected: KeeperHub Workflow Builder graphs per run · Safe/multisig
execution · cross-chain/CCIP · MPP/Tempo second rail · protocol plugins · marketplace listing ·
multi-tenant auth · gas-sponsorship reliance · a self-built relayer or nonce manager · an ML
dependency extractor.

## Reject the milestone if

- Any command in step 4 of the milestone prompt was skipped or its output summarised rather than
  pasted.
- A KeeperHub-touching change ships without a real simulate payload or a real transaction hash.
- Friction was resolved by redesigning instead of by recording a gap and using its fallback.
- The session continued into the next milestone.
