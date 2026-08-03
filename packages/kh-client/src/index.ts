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
// The KeeperHub client surface itself is a scaffold — implemented in CVY-004.
// The payload commitment helper landed at CVY-002 and is re-exported here so
// consumers (the orchestrator, the manifest reconciler) import it from the
// package entry point rather than reaching into `src/`.
export { encodeArgs, payloadHash } from './payloadHash.js';
export type { AbiArgValue, PayloadHashInput } from './payloadHash.js';
