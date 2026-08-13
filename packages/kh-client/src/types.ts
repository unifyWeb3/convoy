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
  /**
   * The 4-byte custom-error selector, extracted from `revertReason`.
   *
   * Measured 2026-08-04 (gap G-20): the API does not name custom errors — it
   * says `execution reverted (unknown custom error)` — but it *does* carry the
   * raw revert data, e.g. `data="0x1c8b6259"`, which is `RootNotSet()`. The
   * selector is therefore fully recoverable, and a consumer holding the ABI can
   * map it back to the error name. Surfaced here so every consumer does not
   * re-parse a diagnostic blob.
   */
  readonly revertSelector?: string;
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
 * What KeeperHub's `gasUsedWei` field carries on THIS execution.
 *
 * The field is polymorphic and the discriminator is `sponsored` (gap G-31),
 * measured against chain receipts on three transactions:
 *
 * | `sponsored` | `gasUsedWei` is        | verified against                       |
 * | ----------- | ---------------------- | -------------------------------------- |
 * | `true`      | gas **UNITS**          | `receipt.gasUsed` exactly              |
 * | `false`     | the **L2 fee in wei**  | `gasUsed × effectiveGasPrice` exactly  |
 *
 * A consumer that assumes either reading is wrong roughly six million times on
 * the other branch. Hence the two mutually-exclusive fields below: whichever one
 * is populated is safe to use as its name says, and neither is guessed.
 */
export type ReportedGasMeaning = 'units' | 'weiL2' | 'ambiguous';

interface ReportedGasFields {
  /**
   * Gas units — populated **only** when `sponsored === true`, where the field
   * provably equals `receipt.gasUsed`.
   */
  readonly gasUsedUnits?: string;
  /**
   * L2 fee in wei — populated **only** when `sponsored === false`, where the
   * field provably equals `gasUsed × effectiveGasPrice`. Excludes the L1 data
   * fee, which KeeperHub never reports at all (gap G-28).
   */
  readonly gasFeeWeiL2?: string;
  /** KeeperHub's `gasUsedWei` verbatim, for the audit drawer. */
  readonly gasReportedRaw?: string;
  /** How `gasReportedRaw` was interpreted. `ambiguous` when `sponsored` is absent. */
  readonly gasReportedMeaning?: ReportedGasMeaning;
  /** Wei per gas unit, from KeeperHub's `gasPriceWei`. */
  readonly gasPriceWei?: string;
  /**
   * Did KeeperHub's ERC-4337 paymaster pay, or the org Turnkey wallet?
   *
   * `false` means the wallet was debited (DEC-008). Read from the top-level
   * field: `result.sponsored` is **absent** on unsponsored records, while
   * `result.executedCall.sponsored` agrees with the top level on all three
   * measured executions.
   */
  readonly sponsored?: boolean;
}

/**
 * Result of a write. Writes execute SYNCHRONOUSLY (gap G-02): the POST returns
 * 202 with a status that is often already terminal, so the status poll must be
 * short-circuited rather than always run.
 */
export interface WriteResult extends ReportedGasFields {
  readonly executionId: string;
  readonly status: ExecutionStatus | string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  /** KeeperHub's own internal retry count; Convoy observes it only. */
  readonly retryCount?: number;
  /** True when the POST response is already terminal and no poll is needed. */
  readonly terminal: boolean;
  readonly httpStatus: number;
  readonly raw: unknown;
}

/** Result of `GET /api/execute/{id}/status`. */
export interface StatusResult extends ReportedGasFields {
  readonly executionId: string;
  readonly status: ExecutionStatus | string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  /** KeeperHub's own internal retry count; Convoy observes it only. */
  readonly retryCount?: number;
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
