# Role — Staff Architect

Owns the execution state machine, the orchestrator, and the boundary that keeps every KeeperHub
detail inside one package.

## Responsibilities

- Implement the RUN and ITEM state machines exactly as frozen in `docs/ARCHITECTURE.md` §5(i):
  ```
  RUN:  RECEIVED → OPENING → PLANNING → CRITIQUING → EXECUTING → SEALING → { SEALED_OK | SEALED_PARTIAL }
        any → ABORTED (cooperative) ; OPENING/SEALING may → FAILED_FATAL (401/422)
  ITEM: PENDING → SIMULATED → VETOED | (COMMITTED → SUBMITTED → { LANDED | RETRYING → SUBMITTED | FAILED })
        → DEFERRED → (dependency LANDED) → SIMULATED …
  ```
- Enforce the guards: `COMMITTED` requires a prior `SIMULATED` **and** a Critic APPROVE;
  `SUBMITTED→LANDED` requires KeeperHub status `completed` **and** a non-null `transactionHash`;
  `RETRYING` only on a KeeperHub transient code, capped, then `FAILED`.
- Own the kh-client boundary: `packages/kh-client` is the only module that may reach
  `app.keeperhub.com`. All API drift (G-01/G-02/G-03) is absorbed there behind stable types.
- Own the BullMQ topology: one queue, idempotent handlers keyed `(runId, itemIdx, phase)`,
  `jobId = runId:phase:itemIdx`, concurrency 1 per run, graceful `SIGTERM → worker.close()`.
- Own crash-resume: `reconcile.ts` re-derives every non-terminal item from KeeperHub status
  before acting.

## Files owned

```
packages/kh-client/src/*
services/worker/src/{index,queue,orchestrator,reconcile}.ts
services/worker/src/handlers/{plan,critique,execute,seal}.ts
```

## Invariants preserved

- Convoy retries **only its own faults** (LLM timeout, DB blip, network). Onchain retries belong to
  KeeperHub and are only observed and recorded.
- Convoy **never sets a nonce** and **never holds a key**. There is no relayer in this codebase.
- Every state transition is transactional (`prisma.$transaction`) and emits exactly **one** `events`
  row — live logs, audit trail, and manifest are one truth.
- Every write carries `Idempotency-Key: <runId>:<idx>:<attempt>`; simulate calls are exempt.
  A `409 idempotency_in_progress` is retried after backoff; `409 idempotency_conflict` is a bug and
  fails the item.
- `config-revert` (a full message with no error code) is terminal for the item — never retried.
- Reconcile before acting. Never re-broadcast without the original idempotency key.

## Definition of done

- The full state machine drives a batch `RECEIVED → SEALED` with real transaction hashes.
- Guard tests pass: `guards.committedRequiresApprove`, `guards.landedRequiresTxHash`,
  `retry.transientOnly`.
- Kill-worker test passes with no duplicate transaction hash on resume.

## Milestones

CVY-004 (kh-client), CVY-006 (queue + worker), CVY-008 (orchestrator + state machine),
CVY-015 (idempotency + crash-resume).
