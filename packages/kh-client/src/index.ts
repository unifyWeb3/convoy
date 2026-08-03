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
// Convoy never sets a nonce and never holds a private key.

export { KhClient, DEFAULT_RETRY } from './client.js';
export type {
  KhClientOptions,
  KhResponse,
  RequestOptions,
  RetryPolicy,
  VcrTape,
} from './client.js';

export {
  CONTRACT_CALL_PATH,
  buildContractCallBody,
  simulateContractCall,
  writeContractCall,
} from './contractCall.js';

export { CHECK_AND_EXECUTE_PATH, checkAndExecute } from './checkAndExecute.js';
export type { CheckAndExecuteParams } from './checkAndExecute.js';

export {
  POLL_HINT_HEADER,
  getExecutionStatus,
  parsePollHint,
  pollUntilTerminal,
  statusPath,
} from './status.js';
export type { PollOptions } from './status.js';

export {
  KhError,
  classifyHttpError,
  classifyTransportError,
  extractMessage,
  parseRetryAfter,
} from './errors.js';
export type { ClassifyInput, KhErrorClass, KhErrorInit } from './errors.js';

export { IDEMPOTENCY_HEADER, buildIdempotencyKey, parseIdempotencyKey } from './idempotency.js';

export {
  SUPPORTED_CHAIN_IDS,
  TERMINAL_STATUSES,
  isSupportedChainId,
  isTerminalStatus,
} from './types.js';
export type {
  AttemptRef,
  ChainId,
  ContractCallParams,
  ContractCallWireBody,
  ExecutionStatus,
  KhMode,
  SimulateResult,
  StatusResult,
  WriteResult,
} from './types.js';

// The payload commitment helper landed at CVY-002 and is re-exported here so
// consumers (the orchestrator, the manifest reconciler) import it from the
// package entry point rather than reaching into `src/`.
export { encodeArgs, payloadHash } from './payloadHash.js';
export type { AbiArgValue, PayloadHashInput } from './payloadHash.js';
