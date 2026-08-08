// RUN/ITEM state machine and phase orchestration.
//
// Guards (frozen, docs/ARCHITECTURE.md §5(i)):
//   COMMITTED requires a prior SIMULATED and a Critic APPROVE.
//   SUBMITTED -> LANDED requires status `completed` AND a non-null transactionHash.
//   RETRYING only on a KeeperHub transient code, capped, then FAILED.
//   A config-revert (full message, no code) is terminal — never retried.
// Every transition is transactional and emits exactly one events row.
//
// THE APPROVE GUARD, as of CVY-011. D-029's interim note said the guard was the
// deterministic kh-client simulate alone, and that the LLM Critic would layer ON
// TOP of it rather than replace it. That is what happened, and the ordering
// still reads that way: simulate first, then the arithmetic, then the Critic —
// each one able only to ADD a veto. The model cannot approve past a revert, and
// it cannot approve past the budget projection.

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
  foldRunIdForPhase,
  pollUntilTerminal,
  simulateContractCall,
  writeContractCall,
  type CheckAndExecuteCondition,
  type WriteResult,
} from '@convoy/kh-client';

import { DISTRIBUTOR_ABI, REGISTRY_ABI, decodeRevertSelector } from './abis.js';
import {
  canAfford,
  gasUsdc,
  planExhaustion,
  projectItemCost,
  type BudgetState,
  type CostProjection,
} from './budget.js';
import { readGasPriceWei, readReceiptGas } from './receipt.js';
import { executeWithDependencyGate, selectOnchainDependency } from './gates/checkAndExecute.js';
import {
  classifyExecutionStatus,
  getOrCreateAttempt,
  latestAttempt,
  persistExecutionId,
  persistObservation,
  persistSubmissionError,
  pollPersistedExecution,
  type PersistedAttempt,
} from './reconcile.js';

export const MAX_ONCHAIN_RETRIES = 2;

/**
 * The cycle is capped at ONE (CVY-011). Not a tuning knob: a Critic that can
 * ask for another plan indefinitely is a run that never seals, and an item the
 * Planner could not fix on the second look is not going to be fixed on the
 * ninth.
 */
export const MAX_REPLAN_CYCLES = 1;

const REGISTRY_FNS = new Set(['openRun', 'commitAction', 'sealRun']);

// ---------------------------------------------------------------------------
// The Critic port (CVY-011)
// ---------------------------------------------------------------------------
//
// THE WORKER DOES NOT IMPORT THE CRITIC, for the same reason it does not import
// the Planner (D-030): the Critic lives in `apps/web/lib/critic` per the frozen
// file layout, and the worker compiles with `rootDir: src`. So the worker
// declares the SHAPE it needs and the composition root supplies it — the port
// below is structurally identical to what `critiqueAction` returns.
//
// The direction of that dependency is also the honest one. A worker that
// required an LLM to execute a run would stop when the provider did. With no
// Critic wired, `deps.critic` is undefined and the gate is the simulator alone —
// the documented CVY-011 fallback — reported as `criticConsulted:false` rather
// than as an approval that nobody granted.

export type CriticVetoReason =
  'would_revert' | 'over_budget' | 'unmet_dependency' | 'evidence_mismatch';

/** What the deterministic half established, before the model is consulted. */
export interface CriticFacts {
  readonly wouldRevert: boolean;
  readonly revertReason?: string;
  readonly budget: 'affordable' | 'over_budget' | 'unknown';
  readonly budgetDetail?: string;
  readonly targetWhitelisted: boolean;
}

/** One action put to the Critic. Symbolic target name — never an address. */
export interface CriticAction {
  readonly idx: number;
  readonly target: string;
  readonly functionName: string;
  readonly functionArgs: readonly unknown[];
  readonly evidence: string;
  readonly plannerRationale?: string;
  readonly dependsOn?: readonly { idx: number; landed: boolean }[];
  readonly gasBudgetUsdc?: string;
  readonly simulator: {
    readonly wouldRevert: boolean;
    readonly revertReason?: string;
    readonly gasEstimate?: string;
    readonly budget?: 'affordable' | 'over_budget' | 'unknown';
    readonly budgetDetail?: string;
  };
}

export interface CriticOutcome {
  readonly approved: boolean;
  readonly reason?: CriticVetoReason;
  readonly decidedBy: string;
  readonly detail: string;
  readonly overrides: readonly string[];
  readonly criticConsulted: boolean;
}

export type CriticPort = (action: CriticAction, facts: CriticFacts) => Promise<CriticOutcome>;

/** What the worker asks for when the Critic vetoed something. */
export interface ReplanRequest {
  readonly runId: string;
  readonly vetoed: readonly { idx: number; reason: string; detail: string }[];
}

export interface ReplanOutcome {
  /** Revised per-item allocations, applied before the second critique. */
  readonly gasBudgetPerItem?: readonly { idx: number; gasBudgetUsdc: string }[];
  /** Which items are worth a second look. Anything absent stays vetoed. */
  readonly retryIdx: readonly number[];
  readonly note: string;
}

export type ReplanPort = (request: ReplanRequest) => Promise<ReplanOutcome | undefined>;

export interface OrchestratorDeps {
  readonly kh: KhClient;
  readonly registryAddr: string;
  readonly log?: (m: string) => void;
  /** The LLM Critic. Absent = simulator-only gate, the documented fallback. */
  readonly critic?: CriticPort;
  /** One re-plan cycle after a veto. Absent = vetoes are final on the first pass. */
  readonly replan?: ReplanPort;
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
  // Preserve the established phase-folded component. The frozen three-part
  // shape is retained while the phase distinguishes open/commit/execute/seal
  // writes (G-29).
  return foldRunIdForPhase(runId, phase);
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
  const existing = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (
    ['PLANNING', 'CRITIQUING', 'EXECUTING', 'SEALING', 'SEALED_OK', 'SEALED_PARTIAL'].includes(
      existing.status,
    )
  ) {
    const opened = await prisma.event.findFirst({
      where: { runId, type: 'RUN_OPENED' },
      orderBy: { id: 'asc' },
    });
    const txHash =
      opened?.payload !== null && typeof opened?.payload === 'object'
        ? (opened.payload as { txHash?: unknown }).txHash
        : undefined;
    if (typeof txHash === 'string') return txHash;
  }
  if (existing.runIdOnchain === null) {
    await prisma.run.update({
      where: { id: runId },
      data: { runIdOnchain: hexBytes(runIdOnchain) },
    });
  } else {
    runIdOnchain = bytesToHex(existing.runIdOnchain);
  }
  if (existing.status !== 'OPENING') {
    await setRunStatus(runId, 'OPENING', 'RUN_RECEIVED', { runIdOnchain });
  }

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
      data: { status: 'PLANNING' },
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

  // THE DECLARED EDGES ARE AUTHORITATIVE. The Planner may ADD constraints it
  // read out of the evidence; it may never remove one the operator declared.
  //
  // This is not hypothetical. CVY-010 measured that the model omits
  // transitively-redundant edges — given `2 after 1 after 0` it records those
  // two and drops `2 after 0`. Harmless when the rest of the extraction is
  // right; not harmless if it drops an edge nothing else implies, because
  // `releaseDeferred` reads `item.dependsOn` and the constraint would simply be
  // gone. Overwriting would let the LLM lose safety constraints silently, in the
  // one direction that matters.
  const declared = edgesFromItems(items);
  const plannerEdges = stored?.deferrals ?? [];
  const union = unionEdges(declared, plannerEdges);

  // Two individually-acyclic edge sets CAN union into a cycle (declared `1←0`
  // plus planner `0←1`). A cycle would deadlock the deferral gate silently, so
  // the union is checked and the declared set — the operator's — wins.
  const conflict = findCycleEdges(union);
  const effective = conflict === undefined ? union : declared;
  const effectiveWarnings =
    conflict === undefined
      ? []
      : [
          `planner deferrals conflict with the declared edges (cycle ${conflict.join(' → ')}); ` +
            'using the declared edges only',
        ];

  const deferralsByIdx = new Map<number, number[]>();
  for (const e of effective) {
    const list = deferralsByIdx.get(e.idx);
    if (list === undefined) deferralsByIdx.set(e.idx, [e.dependsOn]);
    else list.push(e.dependsOn);
  }

  const excluded = new Set(stored?.excludedIdx ?? []);

  // What is stored is what was EFFECTIVE, not what the Planner proposed. A plan
  // whose edges were overridden must not be recorded as if it had been used.
  const plan = {
    source: stored?.source ?? 'fallback-topological',
    order: stored?.order ?? items.map((i) => i.idx),
    deferrals: effective,
    ...(stored === undefined
      ? {}
      : {
          gasBudgetPerItem: stored.gasBudgetPerItem,
          plannerDeferrals: plannerEdges,
          declaredDeferrals: declared,
        }),
    warnings: [
      ...(stored?.warnings ?? [
        'no stored plan; deterministic order from declared dependsOn edges',
      ]),
      ...effectiveWarnings,
    ],
    excludedIdx: stored?.excludedIdx ?? [],
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

  // Persist the effective edges onto the items, so the deferral gate and the DAG
  // view read one source of truth rather than two.
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

export interface PlanEdge {
  readonly idx: number;
  readonly dependsOn: number;
}

/** Declared edges, straight off the items. */
export function edgesFromItems(
  items: readonly { idx: number; dependsOn: readonly number[] }[],
): PlanEdge[] {
  return items.flatMap((i) => i.dependsOn.map((dependsOn) => ({ idx: i.idx, dependsOn })));
}

/** Union, de-duplicated, deterministically ordered. */
export function unionEdges(a: readonly PlanEdge[], b: readonly PlanEdge[]): PlanEdge[] {
  const seen = new Set<string>();
  const out: PlanEdge[] = [];
  for (const e of [...a, ...b]) {
    const key = `${e.idx}<-${e.dependsOn}`;
    if (seen.has(key) || e.idx === e.dependsOn) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((x, y) => x.idx - y.idx || x.dependsOn - y.dependsOn);
}

/**
 * Find a cycle in an edge set, naming it.
 *
 * Duplicated from the Planner rather than imported, for the reason in D-030 —
 * the worker cannot reach `apps/web/lib`. Small, pure, and covered by its own
 * tests on both sides.
 */
export function findCycleEdges(edges: readonly PlanEdge[]): number[] | undefined {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    const list = adj.get(e.idx);
    if (list === undefined) adj.set(e.idx, [e.dependsOn]);
    else list.push(e.dependsOn);
  }
  const VISITING = 1;
  const DONE = 2;
  const mark = new Map<number, number>();
  const stack: number[] = [];

  function visit(node: number): number[] | undefined {
    const state = mark.get(node);
    if (state === DONE) return undefined;
    if (state === VISITING) return [...stack.slice(stack.indexOf(node)), node];
    mark.set(node, VISITING);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    mark.set(node, DONE);
    return undefined;
  }

  for (const node of [...adj.keys()]) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** Shape of `runs.plan` as the Planner writes it. Duplicated, not imported (D-030). */
export interface StoredPlanShape {
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
export function readStoredPlan(value: unknown): StoredPlanShape | undefined {
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
  /** Which authority decided. `default` means the deterministic gate alone. */
  readonly decidedBy?: string;
  /** True when a model verdict was obtained and reconciled. */
  readonly criticConsulted?: boolean;
  /** Every point at which the model was overruled. Recorded, never dropped. */
  readonly overrides?: readonly string[];
  readonly vetoReason?: CriticVetoReason;
}

export interface CritiqueOptions {
  /** Read once per run rather than per item. Absent = projection is `unknown`. */
  readonly gasPriceWei?: bigint;
}

/**
 * Simulate one item, then critique it. Zero gas: no signing, no broadcast, no
 * audit row on the KeeperHub side.
 *
 * ORDER IS LOAD-BEARING, and it is the order the card requires. The simulate
 * runs FIRST, so the Critic is handed a fact rather than asked to guess one, and
 * so `over_budget` can be arithmetic on a real gas estimate. It also means the
 * corroboration override — "a Critic APPROVE on an action the simulator says
 * would revert is overridden to VETO" — is structural here rather than
 * reconciled: an item the simulator rejects returns before the model is
 * consulted at all, which is the same outcome for no tokens. The override is
 * still implemented and unit-tested in `apps/web/lib/critic/corroborate.ts`,
 * where the eval exercises it with both verdicts in hand.
 *
 * The deterministic gate keeps its authority in full (D-029 unchanged): a
 * `wouldRevert:true` is a genuine precondition failure decoded from the
 * contract's own custom error, never a staged one, and the model cannot talk it
 * away. What the Critic ADDS is the judgement neither the simulator nor the
 * arithmetic can make — whether the call is the one the evidence asked for.
 */
export async function critiqueItem(
  deps: OrchestratorDeps,
  runId: string,
  itemIdx: number,
  budget: BudgetState,
  options: CritiqueOptions = {},
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
        decidedBy: 'simulator',
        criticConsulted: false,
        gasSpent: 0,
      },
      data: { vetoReason: 'would_revert' },
    });
    return {
      idx: itemIdx,
      approved: false,
      reason: `would_revert: ${decoded ?? 'unknown'}`,
      decidedBy: 'simulator',
      criticConsulted: false,
      vetoReason: 'would_revert',
    };
  }

  const allocation = item.gasBudgetUsdc === null ? null : new Prisma.Decimal(item.gasBudgetUsdc);

  // Can the RUN still pay for a slice this size? (CVY-007, meter-side.)
  const afford = canAfford(budget, { itemIdx, gasBudgetUsdc: allocation });
  if (afford.verdict === 'over_budget') {
    await transitionItem({
      runId,
      itemIdx,
      expect: ['PLANNED', 'DEFERRED', 'SIMULATED'],
      to: 'VETOED',
      type: 'ITEM_VETOED',
      payload: {
        reason: 'over_budget',
        detail: afford.reason,
        decidedBy: 'arithmetic',
        criticConsulted: false,
        gasSpent: 0,
      },
      data: { vetoReason: 'over_budget' },
    });
    return {
      idx: itemIdx,
      approved: false,
      reason: afford.reason,
      decidedBy: 'arithmetic',
      criticConsulted: false,
      vetoReason: 'over_budget',
    };
  }

  // Does THIS ITEM cost more than the slice the plan gave it? The card's
  // `over_budget`: the simulate estimate against the per-item allocation.
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const projection = projectItemCost({
    itemIdx,
    gasEstimateUnits: sim.gasEstimate,
    gasPriceWei: options.gasPriceWei,
    allocationUsdc: allocation,
    runEthUsd: new Prisma.Decimal(run.runEthUsd),
  });
  if (projection.verdict === 'over_budget') {
    await transitionItem({
      runId,
      itemIdx,
      expect: ['PLANNED', 'DEFERRED', 'SIMULATED'],
      to: 'VETOED',
      type: 'ITEM_VETOED',
      payload: {
        reason: 'over_budget',
        detail: projection.detail,
        decidedBy: 'arithmetic',
        criticConsulted: false,
        gasSpent: 0,
      },
      data: { vetoReason: 'over_budget' },
    });
    return {
      idx: itemIdx,
      approved: false,
      reason: projection.detail,
      decidedBy: 'arithmetic',
      criticConsulted: false,
      vetoReason: 'over_budget',
    };
  }

  // The deterministic gate is satisfied. Now the judgement it cannot make.
  const critique = await runCritic(deps, run, item, sim, projection);
  if (!critique.approved) {
    await transitionItem({
      runId,
      itemIdx,
      expect: ['PLANNED', 'DEFERRED', 'SIMULATED'],
      to: 'VETOED',
      type: 'ITEM_VETOED',
      payload: {
        reason: critique.reason ?? 'evidence_mismatch',
        detail: critique.detail,
        decidedBy: critique.decidedBy,
        criticConsulted: critique.criticConsulted,
        overrides: [...critique.overrides],
        gasSpent: 0,
      },
      data: { vetoReason: critique.reason ?? 'evidence_mismatch' },
    });
    return {
      idx: itemIdx,
      approved: false,
      reason: `${critique.reason ?? 'evidence_mismatch'}: ${critique.detail}`,
      decidedBy: critique.decidedBy,
      criticConsulted: critique.criticConsulted,
      overrides: critique.overrides,
      ...(critique.reason === undefined ? {} : { vetoReason: critique.reason }),
    };
  }

  await transitionItem({
    runId,
    itemIdx,
    expect: ['PLANNED', 'DEFERRED'],
    to: 'SIMULATED',
    type: 'ITEM_SIMULATED',
    payload: {
      gasEstimate: sim.gasEstimate ?? null,
      wouldRevert: false,
      projectedUsdc: projection.projectedUsdc === null ? null : projection.projectedUsdc.toFixed(6),
      decidedBy: critique.decidedBy,
      criticConsulted: critique.criticConsulted,
      overrides: [...critique.overrides],
      detail: critique.detail,
    },
  });
  return {
    idx: itemIdx,
    approved: true,
    reason: `gasEstimate ${sim.gasEstimate ?? '?'} — ${critique.detail}`,
    decidedBy: critique.decidedBy,
    criticConsulted: critique.criticConsulted,
    overrides: critique.overrides,
  };
}

/**
 * Consult the Critic, or report honestly that there was none.
 *
 * A THROWN CRITIC IS NOT A VETO. The port reaches a network; if it fails, the
 * item falls back to the deterministic gate's verdict — which at this point is
 * already an approve — rather than being rejected for an infrastructure fault.
 * Vetoing on an exception would make a provider outage look like a batch full of
 * bad items, which is the most expensive way to be wrong here.
 */
async function runCritic(
  deps: OrchestratorDeps,
  run: { runEthUsd: Prisma.Decimal | string; plan: unknown },
  item: {
    idx: number;
    targetAddr: Uint8Array;
    functionName: string;
    functionArgs: unknown;
    evidence: string;
    gasBudgetUsdc: Prisma.Decimal | null;
    dependsOn: number[];
    runId: string;
  },
  sim: { gasEstimate?: string },
  projection: CostProjection,
): Promise<CriticOutcome & { readonly detail: string }> {
  if (deps.critic === undefined) {
    return {
      approved: true,
      decidedBy: 'default',
      detail: 'simulator-only gate; no Critic was wired',
      overrides: [],
      criticConsulted: false,
    };
  }

  const stored = readStoredPlan(run.plan);
  const rationale = readRationale(run.plan, item.idx);
  const deps_ = await prisma.item.findMany({
    where: { runId: item.runId, idx: { in: item.dependsOn } },
    select: { idx: true, state: true },
  });

  const action: CriticAction = {
    idx: item.idx,
    // Symbolic name, never an address — the Critic's vocabulary matches the
    // Planner's (schema.ts), so an injected target is inexpressible on both
    // sides of the LLM boundary rather than only on one.
    target: targetName(deps, bytesToHex(item.targetAddr)),
    functionName: item.functionName,
    functionArgs: item.functionArgs as readonly unknown[],
    evidence: item.evidence,
    ...(rationale === undefined ? {} : { plannerRationale: rationale }),
    dependsOn: deps_.map((d) => ({ idx: d.idx, landed: d.state === 'LANDED' })),
    ...(item.gasBudgetUsdc === null
      ? {}
      : { gasBudgetUsdc: new Prisma.Decimal(item.gasBudgetUsdc).toFixed(6) }),
    simulator: {
      wouldRevert: false,
      ...(sim.gasEstimate === undefined ? {} : { gasEstimate: sim.gasEstimate }),
      budget: projection.verdict,
      budgetDetail: projection.detail,
    },
  };

  const facts: CriticFacts = {
    wouldRevert: false,
    budget: projection.verdict,
    budgetDetail: projection.detail,
    // An item whose target was not whitelisted never reaches CRITIQUING: it is
    // vetoed at PLANNING from `plan.excludedIdx` (see phasePlan). Reaching here
    // therefore means whitelisted, and this states that rather than re-deriving
    // a whitelist the worker does not hold.
    targetWhitelisted: !(stored?.excludedIdx ?? []).includes(item.idx),
  };

  try {
    const outcome = await deps.critic(action, facts);
    return { ...outcome, detail: outcome.detail };
  } catch (e) {
    return {
      approved: true,
      decidedBy: 'default',
      detail: `Critic unavailable (${e instanceof Error ? e.message : String(e)}); simulator-only gate`,
      overrides: [],
      criticConsulted: false,
    };
  }
}

/** The Planner's one-line reason for this item, if a plan recorded one. */
function readRationale(plan: unknown, idx: number): string | undefined {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
  const rows = (plan as Record<string, unknown>)['rationalePerItem'];
  if (!Array.isArray(rows)) return undefined;
  for (const r of rows) {
    if (r !== null && typeof r === 'object' && (r as { idx?: unknown }).idx === idx) {
      const text = (r as { rationale?: unknown }).rationale;
      if (typeof text === 'string' && text !== '') return text;
    }
  }
  return undefined;
}

/** Address → symbolic contract name. Anything unrecognised is named as such. */
function targetName(deps: OrchestratorDeps, addr: string): string {
  if (addr.toLowerCase() === deps.registryAddr.toLowerCase()) return 'ConvoyRegistry';
  const distributor = process.env['MOCK_DISTRIBUTOR_ADDR'];
  if (distributor !== undefined && addr.toLowerCase() === distributor.toLowerCase()) {
    return 'RewardDistributor';
  }
  return 'UnknownContract';
}

export interface CritiquePhaseResult {
  readonly ready: readonly number[];
  readonly vetoed: readonly CritiqueVerdict[];
  /** Items that stayed vetoed through the one permitted re-plan cycle. */
  readonly failedIdx: readonly number[];
  readonly replanCycles: number;
  readonly notes: readonly string[];
}

/**
 * CRITIQUING for the whole run, with AT MOST ONE re-plan cycle.
 *
 * The cap is the acceptance criterion and it is enforced by a constant, not by a
 * convention: `MAX_REPLAN_CYCLES` bounds the loop whatever the Planner or the
 * Critic asks for. An item that is still vetoed after its second look is
 * terminal — `FAILED`, with the closed-enum veto reason kept on the row — and
 * the run seals PARTIAL. That is a designed outcome, not a crash.
 *
 * Without a `replan` port there is no cycle at all and a veto is final on the
 * first pass, which is exactly the pre-CVY-011 behaviour.
 *
 * The gas price is read ONCE for the whole phase. Per item it would be N RPC
 * round trips inside the demo's tightest beat, and a price that drifts between
 * items would make two identical actions get different budget verdicts.
 */
export async function phaseCritique(
  deps: OrchestratorDeps,
  runId: string,
  budget: BudgetState,
  options: CritiqueOptions = {},
): Promise<CritiquePhaseResult> {
  const log = deps.log ?? ((): void => {});
  const notes: string[] = [];

  const gasPriceWei = options.gasPriceWei ?? (await readGasPriceWei());
  if (gasPriceWei === undefined) {
    // Not a veto, and said out loud. The projection degrades to `unknown` and
    // `over_budget` simply cannot fire this run; silently skipping the check
    // would leave nothing in the record to explain why.
    notes.push('gas price unavailable — the per-item budget projection is unknown for this run');
    log('  critique: no gas price; per-item budget projection disabled');
  }
  const itemOptions: CritiqueOptions = gasPriceWei === undefined ? {} : { gasPriceWei };

  const critiqueSet = async (indices: readonly number[]): Promise<CritiqueVerdict[]> => {
    const out: CritiqueVerdict[] = [];
    for (const idx of indices) {
      const v = await critiqueItem(deps, runId, idx, budget, itemOptions);
      log(
        `  critique idx=${idx} ${v.approved ? 'APPROVE' : 'VETO'} ` +
          `[${v.decidedBy ?? 'default'}${v.criticConsulted === true ? '' : ', no critic'}] — ${v.reason}`,
      );
      for (const o of v.overrides ?? []) log(`    override: ${o}`);
      out.push(v);
    }
    return out;
  };

  const planned = await prisma.item.findMany({
    where: { runId, state: 'PLANNED' },
    orderBy: { idx: 'asc' },
    select: { idx: true },
  });
  const first = await critiqueSet(planned.map((p) => p.idx));

  const ready = first.filter((v) => v.approved).map((v) => v.idx);
  let vetoed = first.filter((v) => !v.approved);
  const failedIdx: number[] = [];
  let cycles = 0;

  if (vetoed.length > 0 && deps.replan !== undefined) {
    const outcome = await deps.replan({
      runId,
      vetoed: vetoed.map((v) => ({
        idx: v.idx,
        reason: v.vetoReason ?? 'evidence_mismatch',
        detail: v.reason,
      })),
    });

    if (outcome === undefined) {
      notes.push('re-plan declined; the first-pass vetoes stand');
    } else {
      cycles = MAX_REPLAN_CYCLES;
      notes.push(`re-plan cycle 1/${MAX_REPLAN_CYCLES}: ${outcome.note}`);

      for (const g of outcome.gasBudgetPerItem ?? []) {
        await prisma.item.update({
          where: { runId_idx: { runId, idx: g.idx } },
          data: { gasBudgetUsdc: new Prisma.Decimal(g.gasBudgetUsdc) },
        });
      }

      // Only items the re-plan actually asked to revisit. A vetoed item the
      // Planner did not touch has not been re-planned, so calling it
      // "persistently vetoed" would overstate what was tried.
      const vetoedIdx = new Set(vetoed.map((v) => v.idx));
      const retry = outcome.retryIdx.filter((i) => vetoedIdx.has(i));
      const reopened: number[] = [];
      for (const idx of retry) {
        const moved = await transitionItem({
          runId,
          itemIdx: idx,
          expect: ['VETOED'],
          to: 'PLANNED',
          type: 'PLAN_READY',
          payload: { idx, replanCycle: 1, note: outcome.note },
          data: { vetoReason: null },
        });
        if (moved) reopened.push(idx);
      }

      const second = await critiqueSet(reopened);
      const stillVetoed = second.filter((v) => !v.approved);
      ready.push(...second.filter((v) => v.approved).map((v) => v.idx));

      for (const v of stillVetoed) {
        await transitionItem({
          runId,
          itemIdx: v.idx,
          expect: ['VETOED'],
          to: 'FAILED',
          type: 'ITEM_FAILED',
          payload: {
            reason: v.vetoReason ?? 'evidence_mismatch',
            detail: v.reason,
            replanCycles: MAX_REPLAN_CYCLES,
            note: 'persistently vetoed after the one permitted re-plan cycle',
            gasSpent: 0,
          },
        });
        failedIdx.push(v.idx);
      }

      const reopenedSet = new Set(reopened);
      vetoed = [...vetoed.filter((v) => !reopenedSet.has(v.idx)), ...stillVetoed];
    }
  }

  ready.sort((a, b) => a - b);
  return { ready, vetoed, failedIdx, replanCycles: cycles, notes };
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
  requestedAttempt = 0,
): Promise<ExecuteOutcome> {
  const log = deps.log ?? ((): void => {});
  let item = await prisma.item.findUniqueOrThrow({
    where: { runId_idx: { runId, idx: itemIdx } },
  });

  if (item.state === 'LANDED') {
    const prior = await latestAttempt(item.id, 'EXECUTE');
    return {
      idx: itemIdx,
      landed: true,
      ...(prior?.txHash === null || prior?.txHash === undefined
        ? {}
        : { txHash: bytesToHex(prior.txHash) }),
      feeFromReceipt: false,
      l1FeeIncluded: false,
      ...(prior?.gasUsedWei === null || prior?.gasUsedWei === undefined
        ? {}
        : { feeWeiTotal: BigInt(prior.gasUsedWei.toString()) }),
      sponsored: prior?.sponsored ?? null,
      retries: prior?.attemptNo ?? 0,
    };
  }
  if (['VETOED', 'FAILED', 'SKIPPED'].includes(item.state)) {
    return {
      idx: itemIdx,
      landed: false,
      feeFromReceipt: false,
      l1FeeIncluded: false,
      sponsored: null,
      retries: 0,
    };
  }

  // COMMIT is itself a KeeperHub write. Persist its attempt before submission,
  // and on restart poll its execution id (or reissue the same key when the id
  // was not durably recorded yet).
  if (item.state === 'SIMULATED') {
    let commitAttempt = await latestAttempt(item.id, 'COMMIT');
    let commitNo = commitAttempt?.attemptNo ?? 0;
    for (;;) {
      if (commitAttempt?.khStatus === 'failed' && commitAttempt.errorCode !== null) {
        if (commitNo >= MAX_ONCHAIN_RETRIES) {
          await transitionItem({
            runId,
            itemIdx,
            expect: ['SIMULATED'],
            to: 'FAILED',
            type: 'ITEM_FAILED',
            payload: {
              reason: 'commitAction transient retry cap reached',
              code: commitAttempt.errorCode,
            },
          });
          return failedOutcome(itemIdx, commitNo);
        }
        commitNo += 1;
        commitAttempt = undefined;
      }
      const durable = commitAttempt ?? (await getOrCreateAttempt(item.id, commitNo, 'COMMIT'));
      try {
        let current = durable;
        if (current.executionId === null) {
          const write = await writeContractCall(
            deps.kh,
            {
              contractAddress: deps.registryAddr,
              functionName: 'commitAction',
              functionArgs: [runIdOnchain, String(itemIdx), bytesToHex(item.payloadHash)],
              abi: REGISTRY_ABI as unknown as readonly unknown[],
            },
            { runId: keyRun(runId, 'c'), idx: itemIdx, attempt: commitNo },
          );
          current = await persistExecutionId(current.id, write);
        }
        const final = await pollPersistedExecution(deps.kh, current);
        const observation = classifyExecutionStatus(final);
        await persistObservation(current.id, observation);
        if (observation.outcome === 'landed') {
          await transitionItem({
            runId,
            itemIdx,
            expect: ['SIMULATED'],
            to: 'COMMITTED',
            type: 'ITEM_COMMITTED',
            payload: { txHash: observation.txHash, executionId: final.executionId },
          });
          break;
        }
        if (observation.outcome === 'retry' && commitNo < MAX_ONCHAIN_RETRIES) {
          commitNo += 1;
          commitAttempt = undefined;
          continue;
        }
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SIMULATED'],
          to: 'FAILED',
          type: 'ITEM_FAILED',
          payload:
            observation.outcome === 'failed' && observation.status.status === 'completed'
              ? {
                  reason: 'commitAction did not land; target write blocked',
                  status: observation.status.status,
                  txHash: null,
                }
              : {
                  reason:
                    observation.outcome === 'retry'
                      ? 'commitAction transient retry cap reached'
                      : observation.reason,
                  code: observation.outcome === 'retry' ? observation.code : null,
                },
        });
        return failedOutcome(itemIdx, commitNo);
      } catch (error) {
        if (
          error instanceof KhError &&
          error.classification === 'transient' &&
          error.code !== undefined
        ) {
          await persistSubmissionError(durable.id, {
            status: 'failed',
            code: error.code,
            reason: error.message,
          });
          if (commitNo < MAX_ONCHAIN_RETRIES) {
            commitNo += 1;
            commitAttempt = undefined;
            continue;
          }
          await failSubmission(runId, itemIdx, durable, error, ['SIMULATED']);
          return failedOutcome(itemIdx, commitNo);
        }
        if (isUncertainSubmission(error)) throw error;
        await failSubmission(runId, itemIdx, durable, error, ['SIMULATED']);
        return failedOutcome(itemIdx, commitNo);
      }
    }
    item = await prisma.item.findUniqueOrThrow({
      where: { runId_idx: { runId, idx: itemIdx } },
    });
  }

  // GUARD: the target write is reachable only after the real commit landed.
  if (!['COMMITTED', 'SUBMITTED', 'RETRYING'].includes(item.state)) {
    log(`item ${itemIdx}: COMMIT guard blocked — state ${item.state}, not SIMULATED`);
    return failedOutcome(itemIdx, 0);
  }

  const dependencyIdx = selectOnchainDependency(item.dependsOn);
  const action = {
    contractAddress: bytesToHex(item.targetAddr),
    functionName: item.functionName,
    functionArgs: item.functionArgs as readonly unknown[],
    abi: abiFor(item.functionName),
  };

  let attempt = await latestAttempt(item.id, 'EXECUTE');
  let attemptNo = attempt?.attemptNo ?? requestedAttempt;
  for (;;) {
    if (attempt?.khStatus === 'failed' && attempt.errorCode !== null) {
      if (attemptNo >= MAX_ONCHAIN_RETRIES) {
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SUBMITTED', 'COMMITTED', 'RETRYING'],
          to: 'FAILED',
          type: 'ITEM_FAILED',
          payload: { reason: 'transient retry cap reached', code: attempt.errorCode },
        });
        return failedOutcome(itemIdx, attemptNo);
      }
      attemptNo += 1;
      attempt = undefined;
    }

    const durable = attempt ?? (await getOrCreateAttempt(item.id, attemptNo, 'EXECUTE'));
    try {
      let current = durable;
      let condition: CheckAndExecuteCondition | undefined;
      if (current.executionId === null) {
        let write: WriteResult;
        if (dependencyIdx === undefined) {
          write = await writeContractCall(deps.kh, action, {
            runId: keyRun(runId, 'x'),
            idx: itemIdx,
            attempt: attemptNo,
          });
        } else {
          const gated = await executeWithDependencyGate({
            kh: deps.kh,
            registryAddr: deps.registryAddr,
            runIdOnchain,
            dependencyIdx,
            action,
            ref: { runId: keyRun(runId, 'x'), idx: itemIdx, attempt: attemptNo },
          });
          condition = gated.condition;
          if (!gated.executed || gated.executionId === undefined) {
            const reason = gated.condition.met
              ? 'KeeperHub condition passed but the action was not executed'
              : 'onchain dependency condition unmet';
            await persistSubmissionError(current.id, {
              status: gated.condition.met ? 'condition-met-action-not-executed' : 'condition-unmet',
              reason: JSON.stringify(gated.condition),
            });
            await transitionItem({
              runId,
              itemIdx,
              expect: ['COMMITTED', 'RETRYING'],
              to: 'FAILED',
              type: 'ITEM_FAILED',
              payload: { reason, dependencyIdx, condition: { ...gated.condition } },
            });
            return failedOutcome(itemIdx, attemptNo);
          }
          write = {
            ...gated,
            executionId: gated.executionId,
            status: gated.status ?? 'pending',
          };
        }
        current = await persistExecutionId(current.id, write);
        await transitionItem({
          runId,
          itemIdx,
          expect: ['COMMITTED', 'RETRYING'],
          to: 'SUBMITTED',
          type: 'ITEM_SUBMITTED',
          payload: {
            executionId: write.executionId,
            attempt: attemptNo,
            ...(dependencyIdx === undefined || condition === undefined
              ? {}
              : { dependencyIdx, condition: { ...condition } }),
          },
        });
      }

      // Reconcile-before-act: a durable execution id always wins over submit.
      const final = await pollPersistedExecution(deps.kh, current);
      const observation = classifyExecutionStatus(final);

      // `GET /status` is the record that carries `sponsored`; the write POST
      // often does not. Payer attribution therefore comes from the detail read,
      // falling back to the write only if the detail omitted it.
      const sponsored = final.sponsored ?? null;
      const fee =
        final.transactionHash === undefined
          ? { fromReceipt: false, l1FeeIncluded: false, weiTotal: undefined }
          : await composeFee(final.transactionHash, {
              ...(final.gasUsedUnits !== undefined ? { gasUsedUnits: final.gasUsedUnits } : {}),
              ...(final.gasFeeWeiL2 !== undefined ? { gasFeeWeiL2: final.gasFeeWeiL2 } : {}),
              ...(final.gasPriceWei !== undefined ? { gasPriceWei: final.gasPriceWei } : {}),
            });
      const consumedUsdc =
        fee.weiTotal === undefined
          ? null
          : gasUsdc(new Prisma.Decimal(fee.weiTotal.toString()), runEthUsd);

      await persistObservation(current.id, observation, {
        gasUsedWei: fee.weiTotal === undefined ? null : new Prisma.Decimal(fee.weiTotal.toString()),
        gasUsedUsdc: consumedUsdc,
        sponsored,
      });

      if (observation.outcome === 'landed') {
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SUBMITTED', 'COMMITTED', 'RETRYING'],
          to: 'LANDED',
          type: 'ITEM_LANDED',
          payload: {
            txHash: observation.txHash,
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
          txHash: observation.txHash,
          ...(fee.weiTotal === undefined ? {} : { feeWeiTotal: fee.weiTotal }),
          feeFromReceipt: fee.fromReceipt,
          l1FeeIncluded: fee.l1FeeIncluded,
          sponsored,
          ...(final.gasUsedUnits === undefined ? {} : { gasUsedUnits: final.gasUsedUnits }),
          ...(final.gasPriceWei === undefined ? {} : { gasPriceWei: final.gasPriceWei }),
          retries: attemptNo,
        };
      }

      if (observation.outcome === 'retry' && attemptNo < MAX_ONCHAIN_RETRIES) {
        await transitionItem({
          runId,
          itemIdx,
          expect: ['SUBMITTED', 'COMMITTED'],
          to: 'RETRYING',
          type: 'ITEM_RETRY',
          payload: { attempt: attemptNo + 1, code: observation.code, observed: true },
        });
        attemptNo += 1;
        attempt = undefined;
        continue;
      }

      await transitionItem({
        runId,
        itemIdx,
        expect: ['SUBMITTED', 'COMMITTED', 'RETRYING'],
        to: 'FAILED',
        type: 'ITEM_FAILED',
        payload: {
          reason:
            observation.outcome === 'retry' ? 'transient retry cap reached' : observation.reason,
          code: observation.outcome === 'retry' ? observation.code : null,
        },
      });
      return failedOutcome(itemIdx, attemptNo, sponsored);
    } catch (error) {
      if (
        error instanceof KhError &&
        error.classification === 'transient' &&
        error.code !== undefined
      ) {
        await persistSubmissionError(durable.id, {
          status: 'failed',
          code: error.code,
          reason: error.message,
        });
        if (attemptNo < MAX_ONCHAIN_RETRIES) {
          await transitionItem({
            runId,
            itemIdx,
            expect: ['SUBMITTED', 'COMMITTED', 'RETRYING'],
            to: 'RETRYING',
            type: 'ITEM_RETRY',
            payload: { attempt: attemptNo + 1, code: error.code, observed: true },
          });
          attemptNo += 1;
          attempt = undefined;
          continue;
        }
        await failSubmission(runId, itemIdx, durable, error, [
          'SUBMITTED',
          'COMMITTED',
          'RETRYING',
        ]);
        return failedOutcome(itemIdx, attemptNo);
      }
      if (isUncertainSubmission(error)) throw error;
      await failSubmission(runId, itemIdx, durable, error, ['SUBMITTED', 'COMMITTED', 'RETRYING']);
      return failedOutcome(itemIdx, attemptNo);
    }
  }
}

function failedOutcome(
  idx: number,
  retries: number,
  sponsored: boolean | null = null,
): ExecuteOutcome {
  return {
    idx,
    landed: false,
    feeFromReceipt: false,
    l1FeeIncluded: false,
    sponsored,
    retries,
  };
}

/**
 * A transient submission error is ambiguous: KeeperHub may have accepted it.
 * Do not advance the attempt number. Let BullMQ retry the same persisted row
 * and therefore the same idempotency key.
 */
function isUncertainSubmission(error: unknown): boolean {
  // A non-KeeperHub error may have happened after the POST was accepted (for
  // example while persisting its execution id). Leave the durable attempt in
  // place and let the queue retry it; marking it FAILED could invite a second
  // broadcast on a later manual recovery.
  return !(error instanceof KhError) || error.classification === 'transient';
}

async function failSubmission(
  runId: string,
  itemIdx: number,
  attempt: PersistedAttempt,
  error: unknown,
  expect: readonly ItemState[],
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const kh = error instanceof KhError ? error : undefined;
  await persistSubmissionError(attempt.id, {
    status: kh?.httpStatus === 409 ? 'idempotency_conflict' : 'submission_failed',
    ...(kh?.code === undefined ? {} : { code: kh.code }),
    reason: message,
  });
  await transitionItem({
    runId,
    itemIdx,
    expect,
    to: 'FAILED',
    type: 'ITEM_FAILED',
    payload: {
      reason: message,
      classification: kh?.classification ?? 'unknown',
      idempotencyConflict: kh?.httpStatus === 409,
    },
  });
}

/**
 * App-side deferral gate: dependencies reached LANDED, so re-evaluate.
 *
 * This all-dependencies ledger check remains authoritative. CVY-013 adds one
 * atomic registry condition before the released target write; it does not
 * replace this release rule.
 */
export async function releaseDeferred(
  deps: OrchestratorDeps,
  runId: string,
  budget: BudgetState,
): Promise<number[]> {
  const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
  const readyIdx = new Set(deferredItemsReadyForRelease(items));
  const ready = items.filter((item) => readyIdx.has(item.idx));
  if (ready.length === 0) return [];

  // A released item gets the SAME critique a first-wave item got — including the
  // Critic and the budget projection. Anything less would make the deferral gate
  // a way to bypass the gate that matters.
  const gasPriceWei = await readGasPriceWei();
  const options: CritiqueOptions = gasPriceWei === undefined ? {} : { gasPriceWei };

  const released: number[] = [];
  for (const item of ready) {
    const v = await critiqueItem(deps, runId, item.idx, budget, options);
    if (v.approved) released.push(item.idx);
  }
  return released;
}

export function deferredItemsReadyForRelease(
  items: readonly {
    readonly idx: number;
    readonly state: string;
    readonly dependsOn: readonly number[];
  }[],
): number[] {
  const landed = new Set(items.filter((i) => i.state === 'LANDED').map((i) => i.idx));
  return items
    .filter((i) => i.state === 'DEFERRED' && i.dependsOn.every((d) => landed.has(d)))
    .map((item) => item.idx);
}

/** SEALING → SEALED_OK | SEALED_PARTIAL. */
export async function phaseSeal(
  deps: OrchestratorDeps,
  runId: string,
  runIdOnchain: string,
  budget: BudgetState,
): Promise<{ status: RunStatus; txHash?: string }> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== 'SEALING') {
    await setRunStatus(runId, 'SEALING', 'RUN_SEALED', { phase: 'sealing' });
  }

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
