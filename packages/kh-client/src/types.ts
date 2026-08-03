// @convoy/kh-client — types
//
// Shapes are modelled on responses OBSERVED against the live API on 2026-08-03
// (tapes in test/vcr/), not on the documented shapes. Where the two differ the
// observation wins and the drift is recorded in docs/KNOWN_GAPS.md.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

/** Chains Convoy will talk to. 84532 is the target (DEC-001); 8453 is the optional CVY-019 flip. */
export const SUPPORTED_CHAIN_IDS = ['84532', '8453'] as const;
export type ChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export function isSupportedChainId(v: string): v is ChainId {
  return (SUPPORTED_CHAIN_IDS as readonly string[]).includes(v);
}

/** Integration mode. `vcr` replays recorded tapes so UI work runs offline. */
export type KhMode = 'live' | 'vcr';

/**
 * A direct-execution contract call.
 *
 * Vocabulary is REST direct-execution: contractAddress / functionName /
 * functionArgs / abi. NEVER `abiFunction`. NEVER `call_workflow` for a write —
 * it returns unsigned calldata to the caller and bypasses nonce management,
 * simulation, retries and multi-RPC failover.
 *
 * A nonce field is deliberately absent and must never be added: ordering belongs
 * to KeeperHub's single-sequential-nonce manager. A CI grep-guard enforces this.
 */
export interface ContractCallParams {
  readonly contractAddress: string;
  readonly functionName: string;
  /** Decoded argument values. Serialised to a JSON-array STRING on the wire. */
  readonly functionArgs: readonly unknown[];
  /** ABI fragments. Serialised to a JSON string on the wire. */
  readonly abi?: readonly unknown[];
  /** Wei, as a string. Never a number — uint256 does not fit in a double. */
  readonly value?: string;
  readonly gasLimitMultiplier?: number;
}

/** The literal JSON body sent to KeeperHub. Exported so tests can assert on it. */
export interface ContractCallWireBody {
  readonly chainId: string;
  /** Deprecated upstream but still accepted; sent alongside chainId per gap G-01. */
  readonly network: string;
  readonly contractAddress: string;
  readonly functionName: string;
  /** A JSON-array STRING, e.g. `'["0xabc…","1"]'` — not an array. */
  readonly functionArgs: string;
  readonly abi?: string;
  readonly value?: string;
  readonly gasLimitMultiplier?: number;
  /** Strict boolean. Present only on simulate calls. */
  readonly simulate?: true;
}

/**
 * Result of a `simulate:true` call.
 *
 * A simulate that finds a revert is a SUCCESSFUL simulate. The API reports it as
 * **HTTP 400** with `wouldRevert:true` and `success:false` — see
 * test/vcr/simulate.wouldRevert.true.json. Treating that 400 as an API error
 * would turn the Critic's entire veto mechanism into a hard failure, so this
 * type has no error variant: `wouldRevert` is the answer, not the exception.
 */
export interface SimulateResult {
  readonly wouldRevert: boolean;
  /** Present when `wouldRevert` is false. Gas units as a decimal string. */
  readonly gasEstimate?: string;
  /** Present when `wouldRevert` is true. See gap G-20 on decode quality. */
  readonly revertReason?: string;
  readonly from?: string;
  readonly to?: string;
  readonly value?: string;
  readonly simulatedReturnValue?: unknown;
  /** HTTP status the answer arrived on: 200 for pass, 400 for revert. */
  readonly httpStatus: number;
  /** The verbatim decoded body, for the audit drawer. */
  readonly raw: unknown;
}

/** Terminal-ness of an execution, normalised across POST and GET shapes. */
export type ExecutionStatus = 'completed' | 'failed' | 'pending' | 'running' | 'simulated';

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['completed', 'failed'];

export function isTerminalStatus(s: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/**
 * Result of a write. Writes execute SYNCHRONOUSLY (gap G-02): the POST returns
 * 202 with a status that is often already terminal, so the status poll must be
 * short-circuited rather than always run.
 */
export interface WriteResult {
  readonly executionId: string;
  readonly status: ExecutionStatus | string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  readonly gasUsedWei?: string;
  /** True when the POST response is already terminal and no poll is needed. */
  readonly terminal: boolean;
  readonly httpStatus: number;
  readonly raw: unknown;
}

/** Result of `GET /api/execute/{id}/status`. */
export interface StatusResult {
  readonly executionId: string;
  readonly status: ExecutionStatus | string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  readonly gasUsedWei?: string;
  readonly terminal: boolean;
  /**
   * From the `X-Poll-Interval-Hint` header. **0 means terminal** — stop polling.
   * Undefined when the header is absent.
   */
  readonly pollIntervalHintMs?: number;
  readonly raw: unknown;
}

/** Identifies one execution attempt for idempotency purposes. */
export interface AttemptRef {
  readonly runId: string;
  readonly idx: number;
  readonly attempt: number;
}
