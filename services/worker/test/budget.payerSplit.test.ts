/**
 * Gas CONSUMED and wei DEBITED FROM THE WALLET are two different numbers, and
 * the meter must never conflate them (DEC-008, DEC-010).
 *
 * The distinction is not academic: KeeperHub's paymaster covers ~$1/month on a
 * free account, and when it lapses mid-run the payer switches without anything
 * else changing. DEC-006 measured exactly that — 11 writes sponsored, one paid
 * by the org Turnkey wallet, in a single 12-item batch.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@convoy/db';

import { applyGas, chargeFor, composeGasFeeWei, type BudgetState } from '../src/budget.js';

const ETH_USD = '3400.000000';

function state(budget: string, spent = '0'): BudgetState {
  return {
    budgetUsdc: new Prisma.Decimal(budget),
    spentGasUsdc: new Prisma.Decimal(spent),
    spentPayUsdc: new Prisma.Decimal(0),
  };
}

// The real fee of tx 0x2d737fa8…: 45903 units × 6000000 wei + 6874353887 L1.
const REAL_FEE = composeGasFeeWei({
  gasUsedUnits: '45903',
  gasPriceWei: '6000000',
  l1FeeWei: '6874353887',
});

describe('chargeFor', () => {
  it('a sponsored write consumes gas but debits the wallet nothing', () => {
    const c = chargeFor(REAL_FEE, ETH_USD, true);
    expect(c.consumedUsdc.greaterThan(0)).toBe(true);
    expect(c.debitedUsdc?.isZero()).toBe(true);
    expect(c.sponsored).toBe(true);
  });

  it('an unsponsored write debits exactly what it consumed', () => {
    const c = chargeFor(REAL_FEE, ETH_USD, false);
    expect(c.debitedUsdc?.equals(c.consumedUsdc)).toBe(true);
    expect(c.sponsored).toBe(false);
  });

  it('unknown sponsorship yields a NULL debit, not a zero one', () => {
    // "Nothing was charged" and "we do not know what was charged" are different
    // claims. Reporting the second as the first understates real spend.
    const c = chargeFor(REAL_FEE, ETH_USD, undefined);
    expect(c.debitedUsdc).toBeNull();
    expect(c.sponsored).toBeNull();
    expect(c.consumedUsdc.greaterThan(0)).toBe(true);
  });

  it('matches the measured wei total for the transaction the wallet paid', () => {
    // DEC-006 measured the balance delta at 282,292,353,887 wei exactly.
    expect(REAL_FEE.weiTotal.toFixed(0)).toBe('282292353887');
    expect(REAL_FEE.l1FeeIncluded).toBe(true);
  });
});

describe('applyGas', () => {
  it('drains the budget by CONSUMPTION even when the paymaster paid', () => {
    // If the meter only counted unsponsored writes, BUDGET_LOW would never fire
    // while sponsorship held and the demo mechanic would silently stop working.
    const before = state('0.001');
    const after = applyGas(before, REAL_FEE, ETH_USD, true);
    expect(after.next.spentGasUsdc.greaterThan(before.spentGasUsdc)).toBe(true);
    expect(after.debitedUsdc?.isZero()).toBe(true);
  });

  it('reports consumption and debit as separate figures on one update', () => {
    const after = applyGas(state('1.0'), REAL_FEE, ETH_USD, false);
    expect(after.gasUsdc.equals(after.debitedUsdc as Prisma.Decimal)).toBe(true);
    expect(after.sponsored).toBe(false);
  });

  it('crosses BUDGET_LOW on consumption, once', () => {
    // One fee is ~0.00095978 USDC at the frozen rate, so a 0.0011 budget lands
    // just under the 20% line on the first write and stays there on the second.
    const s = state('0.0011');
    const first = applyGas(s, REAL_FEE, ETH_USD, true);
    expect(first.crossedLow).toBe(true);
    const second = applyGas(first.next, REAL_FEE, ETH_USD, true);
    expect(second.crossedLow).toBe(false);
  });

  it('a run mixing both payers spends more than it debits', () => {
    // The shape of DEC-006's batch: mostly sponsored, one that was not.
    let s = state('10');
    let debited = new Prisma.Decimal(0);
    for (const sponsored of [true, true, true, true, false]) {
      const u = applyGas(s, REAL_FEE, ETH_USD, sponsored);
      s = u.next;
      debited = debited.add(u.debitedUsdc ?? 0);
    }
    expect(s.spentGasUsdc.greaterThan(debited)).toBe(true);
    // Exactly one of five writes hit the wallet.
    expect(debited.equals(s.spentGasUsdc.div(5))).toBe(true);
  });
});
