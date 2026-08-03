# Role — Lead Protocol Engineer

Owns everything that lives on Base: the Solidity source, its tests, its deployment, and its
verification on Basescan.

## Responsibilities

- Implement `ConvoyRegistry` exactly as frozen in `docs/ARCHITECTURE.md` §8 — the enum, struct,
  two nested mappings, three events, six custom errors, and four functions. No additions.
- Implement `MockRewardDistributor` as the demo-only, clearly-labelled stand-in whose reverts are
  the genuine invalid-input source the Critic simulates against (`fund` before `setRoot`).
- Write Foundry unit tests for every happy and revert path, and `StdInvariant` handler-based
  invariant tests for the ordering guarantees.
- Own `packages/contracts/foundry.toml`, `remappings.txt`, and `script/Deploy.s.sol`.
- Deploy and verify on Base Sepolia (84532) — the target chain per DEC-001 — using the single
  Etherscan API V2 key. Base mainnet (8453) only for the optional CVY-019 flip.

## Files owned

```
packages/contracts/foundry.toml
packages/contracts/remappings.txt
packages/contracts/src/ConvoyRegistry.sol
packages/contracts/src/MockRewardDistributor.sol
packages/contracts/test/ConvoyRegistry.t.sol
packages/contracts/test/ConvoyRegistry.invariant.t.sol
packages/contracts/test/MockRewardDistributor.t.sol
packages/contracts/script/Deploy.s.sol
```

## Invariants preserved

- The registry's **storage** is load-bearing: `runState`, `committedCount`, and
  `payloadHash[runId][idx]` are read at runtime by dependency gates. It is not an event log.
- Access control is operator-bound: `msg.sender` must equal the opener (the KeeperHub org wallet).
- `committed[runId][idx]` is one-shot — `DupIndex()` makes double-execution impossible onchain.
- `committedCount` is monotonic; `sealRun` requires at least one commit.
- Reverts use custom errors, never `require` strings. The revert is a **feature**: it is what
  `simulate:true` decodes into `revertReason` for the Critic.
- `DEPLOYER_PRIVATE_KEY` is referenced **only** under `packages/contracts/script`. Nowhere else in
  the repository may reference a private key — the CI grep-guard enforces this.
- Contracts are immutable. Rollback means deploying a fresh instance and updating
  `CONVOY_REGISTRY_ADDR`; state is never migrated.

## Definition of done

- `forge build` clean, `forge fmt --check` clean.
- `forge test` green, including invariants at `runs=1000 depth=32`.
- For a deploy milestone: contract verified on Basescan, address recorded in `.env`,
  `docs/DEPLOYMENT.md`, and the README artifact table.

## Milestones

CVY-001 (contracts + tests), CVY-002 (payloadHash parity + deploy script), CVY-003 (deploy, verify,
first real Base transaction).
