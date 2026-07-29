// @convoy/kh-client — the single typed client for all KeeperHub direct execution.
//
// This package is the ONLY module in the repository permitted to reach
// app.keeperhub.com. All API drift (KNOWN_GAPS G-01/G-02/G-03) is absorbed here
// behind stable types, so every other package consumes a stable contract.
//
// Vocabulary rule: REST direct-execution only —
// contractAddress / functionName / functionArgs / abi. NEVER abiFunction, and
// NEVER call_workflow for a write (it returns unsigned calldata to the caller
// and bypasses the entire reliability stack).
//
// Scaffold only. Implemented in CVY-004.
export {};
