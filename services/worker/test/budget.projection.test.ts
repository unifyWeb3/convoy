/**
 * The Critic's `over_budget` verdict is ARITHMETIC, not judgement (CVY-011).
 *
 * These pin the two properties that make it safe to let a number veto a real
 * release: that it compares the right two quantities, and that a missing input
 * produces `unknown` rather than a confident veto. The second is the one that
 * protects the hard acceptance bar — 5/5 valid items passed, zero false vetoes.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@convoy/db';

import { canAfford, projectItemCost, type BudgetState } from '../src/budget.js';

const ETH_USD = '3400.000000';

// The measured shape of a real item: 45,903 gas at the 6,000,000 wei price
// observed on Base Sepolia. 45903 × 6e6 / 1e18 × 3400 = 0.000936... USDC.
const UNITS = '45903';
const PRICE = '6000000';

function alloc(usdc: string): Prisma.Decimal {
  return new Prisma.Decimal(usdc);
}

describe('projectItemCost', () => {
  it('projects gas units into USDC through the pinned formula', () => {
    const p = projectItemCost({
      itemIdx: 1,
      gasEstimateUnits: UNITS,
      gasPriceWei: PRICE,
      allocationUsdc: alloc('1.000000'),
      runEthUsd: ETH_USD,
    });

    expect(p.verdict).toBe('affordable');
    // 45903 * 6000000 = 275_418_000_000 wei -> /1e18 -> *3400
    expect(p.projectedUsdc?.toFixed(9)).toBe('0.000936421');
  });

  it('vetoes when the projection exceeds the allocation', () => {
    const p = projectItemCost({
      itemIdx: 2,
      gasEstimateUnits: UNITS,
      gasPriceWei: PRICE,
      allocationUsdc: alloc('0.000001'),
      runEthUsd: ETH_USD,
    });

    expect(p.verdict).toBe('over_budget');
    expect(p.detail).toContain('0.000001 USDC allocation');
  });

  it('treats an exactly-equal projection as affordable', () => {
    // The boundary is `greaterThan`, not `greaterThanOrEqual`: spending exactly
    // what was allocated is honouring the plan, not breaching it.
    const p = projectItemCost({
      itemIdx: 3,
      gasEstimateUnits: '1000000',
      gasPriceWei: '1000000000',
      allocationUsdc: alloc('3.400000'),
      runEthUsd: ETH_USD,
    });

    expect(p.projectedUsdc?.toFixed(6)).toBe('3.400000');
    expect(p.verdict).toBe('affordable');
  });

  it('returns unknown — never over_budget — with no allocation', () => {
    const p = projectItemCost({
      itemIdx: 4,
      gasEstimateUnits: UNITS,
      gasPriceWei: PRICE,
      allocationUsdc: null,
      runEthUsd: ETH_USD,
    });

    expect(p.verdict).toBe('unknown');
    expect(p.projectedUsdc).toBeNull();
  });

  it('returns unknown when the simulate gave no gas estimate', () => {
    const p = projectItemCost({
      itemIdx: 5,
      gasPriceWei: PRICE,
      allocationUsdc: alloc('1.000000'),
      runEthUsd: ETH_USD,
    });

    expect(p.verdict).toBe('unknown');
    expect(p.detail).toContain('no gas estimate');
  });

  it('returns unknown when the gas price could not be read', () => {
    const p = projectItemCost({
      itemIdx: 6,
      gasEstimateUnits: UNITS,
      allocationUsdc: alloc('1.000000'),
      runEthUsd: ETH_USD,
    });

    expect(p.verdict).toBe('unknown');
    expect(p.detail).toContain('no gas price');
  });

  it('is a different question from canAfford, and the two can legitimately disagree', () => {
    // A tiny item with a generous allocation, on a meter with almost nothing
    // left. The projection says the item fits its slice; the meter says the run
    // cannot honour a slice that size. Both are true, and both are vetoes.
    const state: BudgetState = {
      budgetUsdc: new Prisma.Decimal('25.000000'),
      spentGasUsdc: new Prisma.Decimal('24.900000'),
      spentPayUsdc: new Prisma.Decimal(0),
    };

    const projection = projectItemCost({
      itemIdx: 7,
      gasEstimateUnits: UNITS,
      gasPriceWei: PRICE,
      allocationUsdc: alloc('5.000000'),
      runEthUsd: ETH_USD,
    });
    const afford = canAfford(state, { itemIdx: 7, gasBudgetUsdc: alloc('5.000000') });

    expect(projection.verdict).toBe('affordable');
    expect(afford.verdict).toBe('over_budget');
  });

  it('is L2-only, and therefore understates — the direction that protects the bar', () => {
    // The real fee carries an OP-stack L1 data component the estimate cannot
    // know at simulate time (gap G-28). On the CVY-003 transaction that was
    // 6_874_353_887 wei of 282_292_353_887 — about 2.4%. The projection is left
    // short rather than padded, because padding buys a false veto.
    const projected = projectItemCost({
      itemIdx: 8,
      gasEstimateUnits: UNITS,
      gasPriceWei: PRICE,
      allocationUsdc: alloc('1.000000'),
      runEthUsd: ETH_USD,
    }).projectedUsdc;

    const withL1 = new Prisma.Decimal('282292353887').div('1e18').mul(ETH_USD);
    expect(projected?.lessThan(withL1)).toBe(true);
  });
});
