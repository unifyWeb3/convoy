// RUN/ITEM state machine and phase orchestration.
//
// Guards (frozen, docs/ARCHITECTURE.md §5(i)):
//   COMMITTED requires a prior SIMULATED and a Critic APPROVE.
//   SUBMITTED -> LANDED requires status `completed` AND a non-null transactionHash.
//   RETRYING only on a KeeperHub transient code, capped, then FAILED.
//   A config-revert (full message, no code) is terminal — never retried.
// Every transition is transactional and emits exactly one events row.
//
// Scaffold only. Implemented in CVY-008.
export {};
