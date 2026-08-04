// RUN/ITEM state machine and phase orchestration.
//
// Guards (frozen, docs/ARCHITECTURE.md §5(i)):
//   COMMITTED requires a prior SIMULATED and a Critic APPROVE.
//   SUBMITTED -> LANDED requires status `completed` AND a non-null transactionHash.
//   RETRYING only on a KeeperHub transient code, capped, then FAILED.
//   A config-revert (full message, no code) is terminal — never retried.
// Every transition is transactional and emits exactly one events row.
//
// INTERIM (D-029): there is no Planner (CVY-010) and no LLM Critic (CVY-011)
// yet. The plan is hardcoded from the seeded item order, and the APPROVE guard
// is satisfied by the deterministic kh-client simulate alone. The LLM Critic
// layers ON TOP of this gate at CVY-011; it does not replace it.

import {
  Prisma,
  unsafeRawClient as prisma,
  bytesToHex,
  type EventType,
  type ItemState,
  type RunStatus,
} from '@convoy/db';
import {
  KhClient,
  KhError,
  getExecutionStatus,
  pollUntilTerminal,
  simulateContractCall,
  writeContractCall,
} from '@convoy/kh-client';

import { DISTRIBUTOR_ABI, REGISTRY_ABI, decodeRevertSelector } from './abis.js';
import { canAfford, gasUsdc, planExhaustion, type BudgetState } from './budget.js';
import { readReceiptGas } from './receipt.js';

export const MAX_ONCHAIN_RETRIES = 2;

const REGISTRY_FNS = new Set(['openRun', 'commitAction', 'sealRun']);

export interface OrchestratorDeps {
  readonly kh: KhClient;
  readonly registryAddr: string;
  readonly log?: (m: string) => void;
}

function hexBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

/**
 * Namespace the idempotency key by phase.
 *
 * The frozen key is `<runId>:<idx>:<attempt>`, which assumes one write per item.
 * A run actually makes **2 + 2K** writes: `openRun`, K× `commitAction`, K× the
 * item's own write, and `sealRun`. Without a phase namespace `openRun` and item
 * 0's write both key to `<run>:0:0`, and KeeperHub correctly rejects the second
 * as `idempotency_conflict` — measured, not theorised (gap G-29).
 *
 * The phase is folded into the runId component so the frozen three-part shape is
 * preserved exactly. `-` and not `:`, which `buildIdempotencyKey` rejects.
 */
function keyRun(runId: string, phase: 'o' | 'c' | 'x' | 's'): string {
  return `${runId.slice(0, 8)}-${phase}`;
}

function abiFor(functionName: string): readonly unknown[] {
  return (REGISTRY_FNS.has(functionName)
    ? REGISTRY_ABI
    : DISTRIBUTOR_ABI) as unknown as readonly unknown[];
}

// ---------------------------------------------------------------------------
// Transitions — one DB transaction, exactly one events row.
// ---------------------------------------------------------------------------

export async function setRunStatus(
  runId: string,
  status: RunStatus,
  type: EventType,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: { status, ...(status.startsWith('SEALED') ? { sealedAt: new Date() } : {}) },
    }),
    prisma.event.create({ data: { runId, itemIdx: null, type, payload } }),
  ]);
}

/**
 * Move one item, transactionally, emitting exactly one event.
 *
 * `expect` is the guard: the update applies only if the item is still in the
 * state the caller believed. A concurrent worker that already advanced it makes
 * this a no-op rather than a double transition — which matters because EXECUTE
 * fans out (DEC-002) and a stalled job can be re-picked (G-26).
 */
export async function transitionItem(args: {
  runId: string;
  itemIdx: number;
  expect: readonly ItemState[];
  to: ItemState;
  type: EventType;
  payload: Prisma.InputJsonValue;
  data?: Prisma.ItemUpdateInput;
}): Promise<boolean> {
  const { runId, itemIdx, expect, to, type, payload } = args;
  return await prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { runId_idx: { runId, idx: itemIdx } } });
    if (item === null) return false;
    if (!expect.includes(item.state as ItemState)) return false;
    await tx.item.update({
      where: { runId_idx: { runId, idx: itemIdx } },
      data: { state: to, ...args.data },
    });
    await tx.event.create({ data: { runId, itemIdx, type, payload } });
    return true;
  });
}

async function recordAttempt(
  itemId: string,
  attemptNo: number,
  kind: 'SIMULATE' | 'COMMIT' | 'EXECUTE',
  fields: Record<string, unknown>,
): Promise<void> {
  await prisma.attempt.create({
    data: { itemId, attemptNo, kind, ...fields } as Prisma.AttemptUncheckedCreateInput,
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** RECEIVED → OPENING → PLANNING. Lands `openRun` onchain. */
export async function phaseOpen(
  deps: OrchestratorDeps,
  runId: string,
  runIdOnchain: string,
): Promise<string> {
  const log = deps.log ?? ((): void => {});
  await setRunStatus(runId, 'OPENING', 'RUN_RECEIVED', { runIdOnchain });

  const write = await writeContractCall(
    deps.kh,
    {
      contractAddress: deps.registryAddr,
      functionName: 'openRun',
      functionArgs: [runIdOnchain],
      abi: REGISTRY_ABI as unknown as readonly unknown[],
    },
    { runId: keyRun(runId, 'o'), idx: 0, attempt: 0 },
  );
  const final = await pollUntilTerminal(deps.kh, write);

  if (final.status !== 'completed' || final.transactionHash === undefined) {
    await setRunStatus(runId, 'FAILED_FATAL', 'RUN_SEALED_PARTIAL', {
      reason: 'openRun did not land',
      status: final.status,
    });
    throw new Error(`openRun did not land for run ${runId}`);
  }

  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: { runIdOnchain: hexBytes(runIdOnchain), status: 'PLANNING' },
    }),
    prisma.event.create({
      data: {
        runId,
        itemIdx: null,
        type: 'RUN_OPENED',
        payload: { txHash: final.transactionHash, txLink: final.transactionLink ?? null },
      },
    }),
  ]);
  log(`RUN_OPENED ${final.transactionHash}`);
  return final.transactionHash;
}

/**
 * PLANNING → CRITIQUING.
 *
 * **The worker does not call the Planner** (D-030). The Planner lives in
 * `apps/web/lib/planner` per the frozen file layout, and the worker compiles
 * with `rootDir: src` — a direct import fails with TS6059, measured. So the
 * boundary is the ledger, not a module: whoever creates the run writes the
 * validated plan to `runs.plan`, and this phase consumes it.
 *
 * That is also the honest dependency direction. The worker must not need an LLM
 * to execute a run; if it did, an unavailable model would stop execution rather
 * than degrading it.
 *
 * With no stored plan, the deterministic topological order from the declared
 * `dependsOn` edges is used — the same path as `--ablate-planner`.
 */
export async function phasePlan(runId: string): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });

  const stored = readStoredPlan(run.plan);
  const deferralsByIdx = new Map<number, number[]>();
  if (stored !== undefined) {
    for (const d of stored.deferrals) {
      const list = deferralsByIdx.get(d.idx);
      if (list === undefined) deferralsByIdx.set(d.idx, [d.dependsOn]);
      else list.push(d.dependsOn);
    }
  } else {
    for (const item of items) {
      if (item.dependsOn.length > 0) deferralsByIdx.set(item.idx, [...item.dependsOn]);
    }
  }

  const excluded = new Set(stored?.excludedIdx ?? []);
  const plan = stored ?? {
    source: 'fallback-topological',
    order: items.map((i) => i.idx),
    deferrals: [...deferralsByIdx.entries()].flatMap(([idx, deps]) =>
      deps.map((dependsOn) => ({ idx, dependsOn })),
    ),
    warnings: ['no stored plan; deterministic order from declared dependsOn edges'],
    excludedIdx: [],
  };

  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: { plan: plan as unknown as Prisma.InputJsonValue, status: 'CRITIQUING' },
    }),
    prisma.event.create({
      data: {
        runId,
        itemIdx: null,
        type: 'PLAN_READY',
        payload: plan as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  // Persist the Planner's dependency extraction onto the items, so the deferral
  // gate and the DAG view read one source of truth rather than two.
  if (stored !== undefined) {
    for (const item of items) {
      const deps = deferralsByIdx.get(item.idx) ?? [];
      const allocation = stored.gasBudgetPerItem.find((g) => g.idx === item.idx);
      await prisma.item.update({
        where: { runId_idx: { runId, idx: item.idx } },
        data: {
          dependsOn: deps,
          ...(allocation === undefined
            ? {}
            : { gasBudgetUsdc: new Prisma.Decimal(allocation.gasBudgetUsdc) }),
        },
      });
    }
  }

  for (const item of items) {
    // An excluded item never reaches the Critic as a normal candidate: its
    // target was not whitelisted for this run, which is an automatic
    // VETO(evidence_mismatch) and never an execution.
    if (excluded.has(item.idx)) {
      await transitionItem({
        runId,
        itemIdx: item.idx,
        expect: ['PENDING'],
        to: 'VETOED',
        type: 'ITEM_VETOED',
        payload: {
          reason: 'evidence_mismatch',
          detail: 'target not in the run whitelist',
          gasSpent: 0,
        },
        data: { vetoReason: 'evidence_mismatch' },
      });
      continue;
    }
    const deferred = (deferralsByIdx.get(item.idx) ?? []).length > 0;
    await transitionItem({
      runId,
      itemIdx: item.idx,
      expect: ['PENDING'],
      to: deferred ? 'DEFERRED' : 'PLANNED',
      type: deferred ? 'ITEM_DEFERRED' : 'PLAN_READY',
      payload: deferred ? { dependsOn: deferralsByIdx.get(item.idx) ?? [] } : { idx: item.idx },
    });
  }
}

/** Shape of `runs.plan` as the Planner writes it. Duplicated, not imported (D-030). */
interface StoredPlanShape {
  readonly source: string;
  readonly order: readonly number[];
  readonly deferrals: readonly { idx: number; dependsOn: number }[];
  readonly gasBudgetPerItem: readonly { idx: number; gasBudgetUsdc: string }[];
  readonly excludedIdx: readonly number[];
  readonly warnings: readonly string[];
}

/**
 * Read a stored plan, defensively.
 *
 * `runs.plan` is jsonb: it can hold anything, including a plan written by an
 * older build. Anything that does not match the expected shape is treated as
 * absent, which degrades to the deterministic order rather than throwing
 * mid-run.
 */
function readStoredPlan(value: unknown): StoredPlanShape | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p['source'] !== 'string') return undefined;
  if (!Array.isArray(p['order']) || !Array.isArray(p['deferrals'])) return undefined;

  const deferrals = (p['deferrals'] as unknown[]).filter(
    (d): d is { idx: number; dependsOn: number } =>
      d !== null &&
      typeof d === 'object' &&
      Number.isInteger((d as { idx?: unknown }).idx) &&
      Number.isInteger((d as { dependsOn?: unknown }).dependsOn),
  );
  const gasBudgetPerItem = (
    Array.isArray(p['gasBudgetPerItem']) ? p['gasBudgetPerItem'] : []
  ).filter(
    (g): g is { idx: number; gasBudgetUsdc: string } =>
      g !== null &&
      typeof g === 'object' &&
      Number.isInteger((g as { idx?: unknown }).idx) &&
      typeof (g as { gasBudgetUsdc?: unknown }).gasBudgetUsdc === 'string',
  );

  return {
    source: p['source'],
    order: (p['order'] as unknown[]).filter((i): i is number => Number.isInteger(i)),
    deferrals,
    gasBudgetPerItem,
    excludedIdx: (Array.isArray(p['excludedIdx']) ? p['excludedIdx'] : []).filter(
      (i): i is number => Number.isInteger(i),
    ),
    warnings: (Array.isArray(p['warnings']) ? p['warnings'] : []).filter(
      (w): w is string => typeof w === 'string',
    ),
  };
}

export interface CritiqueVerdict {
  readonly idx: number;
  readonly approved: boolean;
  readonly reason: string;
}

/**
 * Simulate one item and record the verdict. Zero gas: no signing, no broadcast.
 *
 * The APPROVE guard is **simulator-only** at this milestone (D-029). A
 * `wouldRevert:true` is a genuine precondition failure decoded from the
 * contract's own custom error — never a staged one.
 */
export async function critiqueItem(
  deps: OrchestratorDeps,
  runId: string,
  itemIdx: number,
  budget: BudgetState,
): Promise<CritiqueVerdict> {
  const item = await prisma.item.findUniqueOrThrow({
    where: { runId_idx: { runId, idx: itemIdx } },
  });

  const sim = await simulateContractCall(deps.kh, {
    contractAddress: bytesToHex(item.targetAddr),
    functionName: item.functionName,
    functionArgs: item.functionArgs as readonly unknown[],
    abi: abiFor(item.functionName),
  });

  const decoded = decodeRevertSelector(sim.revertSelector);
  await recordAttempt(item.id, 0, 'SIMULATE', {
    wouldRevert: sim.wouldRevert,
    revertReason: decoded ?? sim.revertReason ?? null,
    khStatus: String(sim.httpStatus),
  });

  if (sim.wouldRevert) {
    await transitionItem({
      runId,
      itemIdx,
      expect: ['PLANNED', 'DEFERRED', 'SIMULATED'],
      to: 'VETOED',
      type: 'ITEM_VETOED',
      payload: {
        reason: 'would_revert',
        revert: decoded ?? sim.revertReason ?? null,
        selector: sim.revertSelector ?? null,
        gasSpent: 0,
      },
      data: { vetoReason: 'would_revert' },
    });
    return { idx: itemIdx, approved: false, reason: `would_revert: ${decoded ?? 'unknown'}` };
  }

  const afford = canAfford(budget, {
    itemIdx,
    gasBudgetUsdc: item.gasBudgetUsdc === null ? null : new Prisma.Decimal(item.gasBudgetUsdc),
  });
  if (afford.verdict === 'over_budget') {
    await transitionItem({
      runId,
      itemIdx,
      expect: ['PLANNED', 'DEFERRED', 'SIMULATED'],
      to: 'VETOED',
      type: 'ITEM_VETOED',
      payload: { reason: 'over_budget', detail: afford.reason, gasSpent: 0 },
      data: { vetoReason: 'over_budget' },
    });
    return { idx: itemIdx, approved: false, reason: afford.reason };
  }

  await transitionItem({
    runId,
    itemIdx,
    expect: ['PLANNED', 'DEFERRED'],
    to: 'SIMULATED',
    type: 'ITEM_SIMULATED',
    payload: { gasEstimate: sim.gasEstimate ?? null, wouldRevert: false },
  });
  return { idx: itemIdx, approved: true, reason: `gasEstimate ${sim.gasEstimate ?? '?'}` };
}

function isTransient(e: unknown): boolean {
  return e instanceof KhError && e.classification === 'transient';
}

export interface ExecuteOutcome {
  readonly idx: number;
  readonly landed: boolean;
  readonly txHash?: string;
  /** Real total fee in wei, composed from the chain receipt (L2 + L1). */
  readonly feeWeiTotal?: bigint;
  /** True when the receipt was read; false when only KeeperHub's figures were available. */
  readonly feeFromReceipt: boolean;
  /** Whether the L1 data component is included in `feeWeiTotal` (gap G-28). */
  readonly l1FeeIncluded: boolean;
  /** Did the paymaster pay, or the org wallet? Null when the record did not say. */
  readonly sponsored: boolean | null;
  readonly gasUsedUnits?: string;
  readonly gasPriceWei?: string;
  readonly retries: number;
}

/**
 * Compose the real fee for a landed transaction.
 *
 * Receipt first — it is chain truth and it carries the L1 data fee KeeperHub
 * omits. KeeperHub's own figures are the fallback, and only usable when
 * `sponsored` disambiguated them (gap G-31): `gasUsedUnits` is populated on a
 * sponsored record, `gasFeeWeiL2` on an unsponsored one, and neither on an
 * ambiguous one — where the honest answer is no figure at all.
 */
async function composeFee(
  txHash: string,
  kh: { gasUsedUnits?: string; gasFeeWeiL2?: string; gasPriceWei?: string },
): Promise<{ weiTotal?: bigint; fromReceipt: boolean; l1FeeIncluded: boolean }> {
  const receipt = await readReceiptGas(txHash);
  if (receipt !== undefined) {
    return { weiTotal: receipt.totalWei, fromReceipt: true, l1FeeIncluded: receipt.l1FeePresent };
  }
  if (kh.gasFeeWeiL2 !== undefined) {
    return { weiTotal: BigInt(kh.gasFeeWeiL2), fromReceipt: false, l1FeeIncluded: false };
  }
  if (kh.gasUsedUnits !== undefined && kh.gasPriceWei !== undefined) {
    return {
      weiTotal: BigInt(kh.gasUsedUnits) * BigInt(kh.gasPriceWei),
      fromReceipt: false,
      l1FeeIncluded: false,
    };
  }
  return { fromReceipt: false, l1FeeIncluded: false };
}

/**
 * COMMITTED → SUBMITTED → LANDED for one item.
 *
 * `commitAction` first — the onchain commitment that this idx carries exactly
 * this payload — then the item's own write. Both through the org wallet; Convoy
 * sets no nonce and performs no onchain retry of its own.
 */
export async function executeItem(
  deps: OrchestratorDeps,
  runId: string,
  itemIdx: number,
  runIdOnchain: string,
  runEthUsd: Prisma.Decimal | string,
): Promise<ExecuteOutcome> {
  const log = deps.log ?? ((): void => {});
  const item = await prisma.item.findUniqueOrThrow({
    where: { runId_idx: { runId, idx: itemIdx } },
  });

  // GUARD: COMMITTED requires a prior SIMULATED (+ an APPROVE, from CVY-011).
  if (item.state !== 'SIMULATED') {
    log(`item ${itemIdx}: COMMIT guard blocked — state ${item.state}, not SIMULATED`);
    return {
      idx: itemIdx,
      landed: false,
      feeFromReceipt: false,
      l1FeeIncluded: false,
      sponsored: null,
      retries: 0,
    };
  }

  const commit = await writeContractCall(
    deps.kh,
    {
      contractAddress: deps.registryAddr,
      functionName: 'commitAction',
      functionArgs: [runIdOnchain, String(itemIdx), bytesToHex(item.payloadHash)],
      abi: REGISTRY_ABI as unknown as readonly unknown[],
    },
    { runId: keyRun(runId, 'c'), idx: itemIdx, attempt: 0 },
  );
  const commitFinal = await pollUntilTerminal(deps.kh, commit);
  await recordAttempt(item.id, 0, 'COMMIT', {
    executionId: commit.executionId,
    txHash:
      commitFinal.transactionHash === undefined ? null : hexBytes(commitFinal.transactionHash),
    txLink: commitFinal.transactionLink ?? null,
    khStatus: commitFinal.status,
  });
  await transitionItem({
    runId,
    itemIdx,
    expect: ['SIMULATED'],
    to: 'COMMITTED',
    type: 'ITEM_COMMITTED',
    payload: { txHash: commitFinal.transactionHash ?? null },
  });

  let retries = 0;
  for (;;) {
    try {
      const write = await writeContractCall(
        deps.kh,
        {
          contractAddress: bytesToHex(item.targetAddr),
          functionName: item.functionName,
          functionArgs: item.functionArgs as readonly unknown[],
          abi: abiFor(item.functionName),
        },
        { runId: keyRun(runId, 'x'), idx: itemIdx, attempt: retries },
      );
      await transitionItem({
        runId,
        itemIdx,
        expect: ['COMMITTED', 'RETRYING'],
        to: 'SUBMITTED',
        type: 'ITEM_SUBMITTED',
        payload: { executionId: write.executionId, attempt: retries },
      });

      // GUARD (G-23): the terminal POST does NOT carry the hash. LANDED requires
      // `completed` AND a non-null transactionHash from GET /status.
      const final = await pollUntilTerminal(deps.kh, write);
      const detail = await getExecutionStatus(deps.kh, write.executionId);

      // `GET /status` is the record that carries `sponsored`; the write POST
      // often does not. Payer attribution therefore comes from the detail read,
      // falling back to the write only if the detail omitted it.
      const sponsored = detail.sponsored ?? final.sponsored ?? null;
      const fee =
        final.transactionHash === undefined
          ? { fromReceipt: false, l1FeeIncluded: false, weiTotal: undefined }
          : await composeFee(final.transactionHash, {
              ...(detail.gasUsedUnits !== undefined ? { gasUsedUnits: detail.gasUsedUnits } : {}),
              ...(detail.gasFeeWeiL2 !== undefined ? { gasFeeWeiL2: detail.gasFeeWeiL2 } : {}),
              ...(detail.gasPriceWei !== undefined ? { gasPriceWei: detail.gasPriceWei } : {}),
            });
      const consumedUsdc =
        fee.weiTotal === undefined
          ? null
          : gasUsdc(new Prisma.Decimal(fee.weiTotal.toString()), runEthUsd);

      await recordAttempt(item.id, retries, 'EXECUTE', {
        executionId: write.executionId,
        txHash: final.transactionHash === undefined ? null : hexBytes(final.transactionHash),
        txLink: final.transactionLink ?? null,
        khStatus: final.status,
        // Real total wei (L2 + L1) from the receipt — NOT KeeperHub's
        // sponsorship-dependent `gasUsedWei` (gaps G-28, G-31).
        gasUsedWei: fee.weiTotal === undefined ? null : new Prisma.Decimal(fee.weiTotal.toString()),
        gasUsedUsdc: consumedUsdc,
        sponsored,
      });

      if (final.status === 'completed' && final.transactionHash !== undefined) {
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SUBMITTED'],
          to: 'LANDED',
          type: 'ITEM_LANDED',
          payload: {
            txHash: final.transactionHash,
            txLink: final.transactionLink ?? null,
            feeWeiTotal: fee.weiTotal === undefined ? null : fee.weiTotal.toString(),
            feeFromReceipt: fee.fromReceipt,
            l1FeeIncluded: fee.l1FeeIncluded,
            sponsored,
            gasUsdcConsumed: consumedUsdc === null ? null : consumedUsdc.toFixed(6),
            walletDebitedUsdc:
              sponsored === null || consumedUsdc === null
                ? null
                : sponsored
                  ? '0.000000'
                  : consumedUsdc.toFixed(6),
          },
        });
        return {
          idx: itemIdx,
          landed: true,
          txHash: final.transactionHash,
          ...(fee.weiTotal === undefined ? {} : { feeWeiTotal: fee.weiTotal }),
          feeFromReceipt: fee.fromReceipt,
          l1FeeIncluded: fee.l1FeeIncluded,
          sponsored,
          ...(detail.gasUsedUnits === undefined ? {} : { gasUsedUnits: detail.gasUsedUnits }),
          ...(detail.gasPriceWei === undefined ? {} : { gasPriceWei: detail.gasPriceWei }),
          retries,
        };
      }

      // completed-without-hash, or failed. Not LANDED — never claim otherwise.
      await transitionItem({
        runId,
        itemIdx,
        expect: ['SUBMITTED'],
        to: 'FAILED',
        type: 'ITEM_FAILED',
        payload: { reason: `status ${final.status}, hash ${final.transactionHash ?? 'null'}` },
      });
      return {
        idx: itemIdx,
        landed: false,
        feeFromReceipt: false,
        l1FeeIncluded: false,
        sponsored,
        retries,
      };
    } catch (e) {
      // RETRYING only on a transient code, capped. A config-revert never retries.
      if (isTransient(e) && retries < MAX_ONCHAIN_RETRIES) {
        retries += 1;
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SUBMITTED', 'COMMITTED'],
          to: 'RETRYING',
          type: 'ITEM_RETRY',
          payload: { attempt: retries, code: (e as KhError).code ?? null, observed: true },
        });
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      await transitionItem({
        runId,
        itemIdx,
        expect: ['SUBMITTED', 'COMMITTED', 'RETRYING'],
        to: 'FAILED',
        type: 'ITEM_FAILED',
        payload: {
          reason: msg,
          classification: e instanceof KhError ? e.classification : 'unknown',
          retried: retries,
        },
      });
      return {
        idx: itemIdx,
        landed: false,
        feeFromReceipt: false,
        l1FeeIncluded: false,
        sponsored: null,
        retries,
      };
    }
  }
}

/**
 * App-side deferral gate: dependencies reached LANDED, so re-evaluate.
 *
 * Cut order #3 turns the onchain `check-and-execute` gate into this app-side
 * gate reading the registry; the deferral logic itself is unchanged.
 */
export async function releaseDeferred(
  deps: OrchestratorDeps,
  runId: string,
  budget: BudgetState,
): Promise<number[]> {
  const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
  const landed = new Set(items.filter((i) => i.state === 'LANDED').map((i) => i.idx));
  const released: number[] = [];

  for (const item of items) {
    if (item.state !== 'DEFERRED') continue;
    if (!item.dependsOn.every((d) => landed.has(d))) continue;
    const v = await critiqueItem(deps, runId, item.idx, budget);
    if (v.approved) released.push(item.idx);
  }
  return released;
}

/** SEALING → SEALED_OK | SEALED_PARTIAL. */
export async function phaseSeal(
  deps: OrchestratorDeps,
  runId: string,
  runIdOnchain: string,
  budget: BudgetState,
): Promise<{ status: RunStatus; txHash?: string }> {
  await setRunStatus(runId, 'SEALING', 'RUN_SEALED', { phase: 'sealing' });

  const items = await prisma.item.findMany({ where: { runId } });
  const unfinished = items
    .filter((i) => !['LANDED', 'VETOED', 'FAILED', 'SKIPPED'].includes(i.state))
    .map((i) => i.idx);

  const outcome = planExhaustion(budget, unfinished);
  for (const idx of outcome.skippedIdx) {
    await transitionItem({
      runId,
      itemIdx: idx,
      expect: ['PENDING', 'PLANNED', 'SIMULATED', 'DEFERRED', 'COMMITTED'],
      to: 'SKIPPED',
      type: 'ITEM_FAILED',
      payload: { reason: 'budget exhausted', skipped: true },
    });
  }

  const write = await writeContractCall(
    deps.kh,
    {
      contractAddress: deps.registryAddr,
      functionName: 'sealRun',
      functionArgs: [runIdOnchain],
      abi: REGISTRY_ABI as unknown as readonly unknown[],
    },
    { runId: keyRun(runId, 's'), idx: 0, attempt: 0 },
  );
  const final = await pollUntilTerminal(deps.kh, write);

  const status: RunStatus = unfinished.length > 0 ? 'SEALED_PARTIAL' : 'SEALED_OK';
  await setRunStatus(runId, status, status === 'SEALED_OK' ? 'RUN_SEALED' : 'RUN_SEALED_PARTIAL', {
    txHash: final.transactionHash ?? null,
    txLink: final.transactionLink ?? null,
    skipped: outcome.skippedIdx,
    reason: outcome.reason,
  });
  return { status, txHash: final.transactionHash };
}
