// Budget meter — gas → USDC accounting.
//
// The pinned formula (blueprint A5, ARCHITECTURE §5(g)):
//
//     gas_used_usdc = (gasUsedWei / 1e18) * runEthUsd
//
// with `runEthUsd` frozen into the run at open, so the arithmetic is
// reproducible from the manifest alone (gap G-04).
//
// TWO THINGS ABOUT THAT FORMULA, BOTH MEASURED (gap G-28, gap G-18):
//
// 1. `gasUsedWei` in the formula means **wei**. KeeperHub's response field of
//    the same name carries the receipt's `gasUsed` — gas UNITS. Feeding units
//    into the formula understates cost by ~6.2 million times. The client now
//    surfaces `gasUsedUnits` + `gasPriceWei` so the mistake is not reachable;
//    this module composes the real wei before applying the formula.
//
// 2. Sponsorship is PARTIAL, so "what was consumed" and "what the wallet paid"
//    are two different numbers and this module never conflates them (DEC-008,
//    DEC-010):
//
//      consumed  — gasUsed x gasPrice (+ l1Fee), ALWAYS recorded. This is what
//                  the budget meter tracks and what BUDGET_LOW / exhaustion
//                  fire on, so the demo mechanic is unaffected by who paid.
//      debited   — the same figure ONLY when the execution record says
//                  `sponsored:false`; zero when the paymaster covered it.
//
//    KeeperHub runs an ERC-4337 paymaster covering ~$1/month on a free account.
//    While it holds, `sponsored:true` and the wallet's balance does not move;
//    once exhausted every write is charged to the org Turnkey wallet. That is
//    the mechanism behind the mid-run payer switch measured in DEC-006.
//
//    The USD figure remains notional at a frozen price on a testnet (G-18).

import { Prisma } from '@convoy/db';

/** A run's budget position at a point in time. */
export interface BudgetState {
  readonly budgetUsdc: Prisma.Decimal;
  readonly spentGasUsdc: Prisma.Decimal;
  /** Reserved for the x402 leg. Always zero until CVY-017 (gaps G-06, G-17). */
  readonly spentPayUsdc: Prisma.Decimal;
}

export const BUDGET_LOW_FRACTION = 0.2;

const WEI_PER_ETH = new Prisma.Decimal('1e18');

function dec(v: Prisma.Decimal | string | bigint | number): Prisma.Decimal {
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v.toString());
}

/**
 * Compose the real fee in wei from what KeeperHub returns plus the receipt's L1
 * component.
 *
 * Base is an OP-stack L2, so the fee has two parts: `units * gasPriceWei`
 * (L2 execution) and `l1Fee` (data availability). **KeeperHub's status response
 * carries only the first.** On the CVY-003 transaction the L1 part was
 * 12,053,372,102 of 422,453,372,102 wei — about 2.9%, far too large to drop.
 *
 * `l1Fee` therefore comes from an `eth_getTransactionReceipt` read via
 * `BASE_RPC_URL` (gap G-28). It is optional here so the meter still produces a
 * figure when the receipt has not been read yet — but that figure is **L2 only**
 * and `l1FeeIncluded` says so, rather than quietly under-reporting.
 */
export interface GasFee {
  readonly weiTotal: Prisma.Decimal;
  readonly weiL2: Prisma.Decimal;
  readonly weiL1: Prisma.Decimal;
  readonly l1FeeIncluded: boolean;
}

export function composeGasFeeWei(input: {
  gasUsedUnits: Prisma.Decimal | string | bigint;
  gasPriceWei: Prisma.Decimal | string | bigint;
  l1FeeWei?: Prisma.Decimal | string | bigint;
}): GasFee {
  const weiL2 = dec(input.gasUsedUnits).mul(dec(input.gasPriceWei));
  const included = input.l1FeeWei !== undefined;
  const weiL1 = included ? dec(input.l1FeeWei as string) : new Prisma.Decimal(0);
  return { weiTotal: weiL2.add(weiL1), weiL2, weiL1, l1FeeIncluded: included };
}

/** The pinned formula. `weiTotal` must be real wei, never gas units. */
export function gasUsdc(
  weiTotal: Prisma.Decimal | string | bigint,
  runEthUsd: Prisma.Decimal | string,
): Prisma.Decimal {
  return dec(weiTotal).div(WEI_PER_ETH).mul(dec(runEthUsd));
}

export function totalSpent(state: BudgetState): Prisma.Decimal {
  return state.spentGasUsdc.add(state.spentPayUsdc);
}

export function remaining(state: BudgetState): Prisma.Decimal {
  const left = state.budgetUsdc.sub(totalSpent(state));
  return left.isNegative() ? new Prisma.Decimal(0) : left;
}

/** Fraction of budget left, in [0,1]. Zero budget reads as exhausted. */
export function remainingFraction(state: BudgetState): number {
  if (state.budgetUsdc.lessThanOrEqualTo(0)) return 0;
  return remaining(state).div(state.budgetUsdc).toNumber();
}

export function isExhausted(state: BudgetState): boolean {
  return remaining(state).lessThanOrEqualTo(0);
}

/** True at or below 20% remaining — the amber threshold. */
export function isLow(state: BudgetState): boolean {
  return remainingFraction(state) <= BUDGET_LOW_FRACTION;
}

/**
 * Should this item be attempted?
 *
 * `over_budget` is one of the Critic's four frozen veto reasons (§5(d)); this
 * function supplies the deterministic half of that judgement at CVY-011. The
 * Critic may still veto for evidence reasons a projection cannot see.
 */
export interface Allocation {
  readonly itemIdx: number;
  /** Per-item gas budget from the Planner. Null = no allocation was assigned. */
  readonly gasBudgetUsdc: Prisma.Decimal | null;
}

export type AffordVerdict =
  | { readonly verdict: 'affordable'; readonly reason: string }
  | { readonly verdict: 'over_budget'; readonly reason: string }
  | { readonly verdict: 'exhausted'; readonly reason: string };

export function canAfford(state: BudgetState, allocation: Allocation): AffordVerdict {
  const left = remaining(state);
  if (left.lessThanOrEqualTo(0)) {
    return {
      verdict: 'exhausted',
      reason: `budget exhausted (${state.budgetUsdc.toFixed(6)} USDC spent); item ${allocation.itemIdx} is SKIPPED`,
    };
  }
  if (allocation.gasBudgetUsdc === null) {
    // No allocation is not a veto — the Planner simply did not assign one.
    // Treating "unknown" as "over budget" would veto valid items for a missing
    // number, which is exactly the false veto CVY-011 must never produce.
    return { verdict: 'affordable', reason: 'no per-item allocation; not a budget veto' };
  }
  if (allocation.gasBudgetUsdc.greaterThan(left)) {
    return {
      verdict: 'over_budget',
      reason:
        `item ${allocation.itemIdx} allocation ${allocation.gasBudgetUsdc.toFixed(6)} USDC ` +
        `exceeds ${left.toFixed(6)} USDC remaining`,
    };
  }
  return {
    verdict: 'affordable',
    reason: `${allocation.gasBudgetUsdc.toFixed(6)} of ${left.toFixed(6)} USDC remaining`,
  };
}

// ---------------------------------------------------------------------------
// The Critic's deterministic half (CVY-011)
// ---------------------------------------------------------------------------

/**
 * Project what an item will cost, from the simulate estimate.
 *
 * TWO DIFFERENT `over_budget` QUESTIONS EXIST, and conflating them is how a
 * valid item gets vetoed for the wrong number:
 *
 *   `canAfford`      — can the RUN still pay for this item at all? Allocation
 *                      against what is left in the meter. USDC vs USDC.
 *   `projectItemCost` — does this item cost more than the slice the PLAN gave
 *                      it? The simulate's gas estimate against that slice. This
 *                      is the one CVY-011 names: "compare the simulate
 *                      gasEstimate against the plan's per-item allocation".
 *
 * Both are arithmetic and neither is the model's to decide. They can disagree —
 * a cheap item with a huge allocation on an empty meter fails the first and
 * passes the second — and they are meant to: either one firing is a real veto,
 * because either one means the run cannot honour the plan as written.
 *
 * THE PROJECTION IS L2-ONLY. At simulate time there is no receipt, so there is
 * no `l1Fee` to add — the estimate covers execution gas alone and the real cost
 * runs about 2.9% higher (gap G-28, measured on the CVY-003 transaction). That
 * error is left in rather than padded out, because it errs toward APPROVE, and
 * the acceptance bar that matters is zero false vetoes. A padded projection
 * would trade a hard bar for a soft one.
 *
 * `unknown` is returned wherever a figure is missing, and unknown is NEVER a
 * veto — same rule as `canAfford`'s null allocation, for the same reason.
 */
export type ProjectionVerdict = 'affordable' | 'over_budget' | 'unknown';

export interface CostProjection {
  readonly verdict: ProjectionVerdict;
  /** L2 execution cost in USDC at the run's frozen rate. Null when unknown. */
  readonly projectedUsdc: Prisma.Decimal | null;
  readonly detail: string;
}

export function projectItemCost(input: {
  readonly itemIdx: number;
  /** Gas UNITS from `simulate:true`. Never wei — see the header of this file. */
  readonly gasEstimateUnits?: string | undefined;
  readonly gasPriceWei?: Prisma.Decimal | string | bigint | undefined;
  readonly allocationUsdc: Prisma.Decimal | null;
  readonly runEthUsd: Prisma.Decimal | string;
}): CostProjection {
  if (input.allocationUsdc === null) {
    return {
      verdict: 'unknown',
      projectedUsdc: null,
      detail: `item ${input.itemIdx} has no per-item allocation; nothing to compare against`,
    };
  }
  if (input.gasEstimateUnits === undefined || input.gasPriceWei === undefined) {
    return {
      verdict: 'unknown',
      projectedUsdc: null,
      detail:
        `item ${input.itemIdx}: ` +
        (input.gasEstimateUnits === undefined
          ? 'the simulate returned no gas estimate'
          : 'no gas price was available'),
    };
  }

  const weiL2 = dec(input.gasEstimateUnits).mul(dec(input.gasPriceWei));
  const projectedUsdc = gasUsdc(weiL2, input.runEthUsd);
  const over = projectedUsdc.greaterThan(input.allocationUsdc);
  return {
    verdict: over ? 'over_budget' : 'affordable',
    projectedUsdc,
    detail:
      `item ${input.itemIdx}: ${input.gasEstimateUnits} gas projects to ` +
      `${projectedUsdc.toFixed(6)} USDC (L2 only) against a ` +
      `${input.allocationUsdc.toFixed(6)} USDC allocation`,
  };
}

/**
 * The two figures for one landed attempt. **Never conflated** (DEC-010).
 *
 * `consumedUsdc` is what the transaction cost the network to execute; it is
 * always recorded and it is what the meter drains. `debitedUsdc` is what left
 * the org Turnkey wallet — the same number when `sponsored === false`, and zero
 * when KeeperHub's paymaster paid.
 *
 * `sponsored: null` means the execution record did not say. The debited figure
 * is then `null` rather than zero: "we don't know" and "nothing was charged" are
 * different claims, and only one of them is honest here.
 */
export interface GasCharge {
  readonly consumedUsdc: Prisma.Decimal;
  readonly debitedUsdc: Prisma.Decimal | null;
  readonly sponsored: boolean | null;
}

export function chargeFor(
  fee: GasFee,
  runEthUsd: Prisma.Decimal | string,
  sponsored: boolean | null | undefined,
): GasCharge {
  const consumedUsdc = gasUsdc(fee.weiTotal, runEthUsd);
  const s = sponsored ?? null;
  return {
    consumedUsdc,
    debitedUsdc: s === null ? null : s ? new Prisma.Decimal(0) : consumedUsdc,
    sponsored: s,
  };
}

/** Applying one landed attempt's real gas to the meter. */
export interface MeterUpdate {
  readonly next: BudgetState;
  /** Gas consumed, in USDC. What the meter drains. */
  readonly gasUsdc: Prisma.Decimal;
  /** What the org wallet actually paid. Null when sponsorship is unknown. */
  readonly debitedUsdc: Prisma.Decimal | null;
  readonly sponsored: boolean | null;
  /** Emit BUDGET_LOW only on the crossing, not on every subsequent update. */
  readonly crossedLow: boolean;
  readonly exhausted: boolean;
}

/**
 * Drain the meter by what was CONSUMED, regardless of who paid.
 *
 * Deliberate: if the meter only counted unsponsored writes, the budget mechanic
 * would silently stop working the moment the paymaster was covering things —
 * BUDGET_LOW would never fire and exhaustion would never arrive. The budget is a
 * policy limit on consumption. What the wallet paid is tracked beside it, not
 * instead of it.
 */
export function applyGas(
  state: BudgetState,
  fee: GasFee,
  runEthUsd: Prisma.Decimal | string,
  sponsored?: boolean | null,
): MeterUpdate {
  const charge = chargeFor(fee, runEthUsd, sponsored);
  const next: BudgetState = { ...state, spentGasUsdc: state.spentGasUsdc.add(charge.consumedUsdc) };
  return {
    next,
    gasUsdc: charge.consumedUsdc,
    debitedUsdc: charge.debitedUsdc,
    sponsored: charge.sponsored,
    crossedLow: !isLow(state) && isLow(next),
    exhausted: isExhausted(next),
  };
}

/**
 * Which items are SKIPPED when the budget runs out, and how the run ends.
 *
 * `SEALED_PARTIAL` rather than `SEALED_OK`: the run did what it could and the
 * manifest says so. Ending early is a designed outcome, not a crash — the
 * frozen §5(i) machine lists `SKIPPED(budget-exhausted)` as a terminal item
 * state precisely for this.
 */
export interface ExhaustionOutcome {
  readonly skippedIdx: readonly number[];
  readonly runStatus: 'SEALED_OK' | 'SEALED_PARTIAL';
  readonly reason: string;
}

export function planExhaustion(
  state: BudgetState,
  unfinishedIdx: readonly number[],
): ExhaustionOutcome {
  if (!isExhausted(state) || unfinishedIdx.length === 0) {
    return {
      skippedIdx: [],
      runStatus: unfinishedIdx.length === 0 ? 'SEALED_OK' : 'SEALED_PARTIAL',
      reason:
        unfinishedIdx.length === 0
          ? 'every item reached a terminal state'
          : `${unfinishedIdx.length} item(s) unfinished`,
    };
  }
  return {
    skippedIdx: [...unfinishedIdx].sort((a, b) => a - b),
    runStatus: 'SEALED_PARTIAL',
    reason:
      `budget exhausted with ${unfinishedIdx.length} item(s) unattempted; ` +
      'marked SKIPPED and the run sealed partial',
  };
}
