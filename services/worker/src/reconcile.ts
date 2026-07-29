// Crash-resume reconciliation.
//
// On startup, every non-terminal item is re-derived from KeeperHub status BEFORE
// any new call is made. Never re-broadcast without the original
// Idempotency-Key (`runId:idx:attempt`). Never invent a transaction hash. Never
// set a nonce.
//
// Scaffold only. Implemented in CVY-015.
export {};
