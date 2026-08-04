/**
 * Budget meter — CVY-007.
 *
 * The anchor test ties the arithmetic to a balance change on chain: the
 * CVY-003 transaction's fee, recomputed from its recorded fields, must equal
 * the wei that actually left the sponsoring relay. A meter that only agrees
 * with itself is decoration.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@convoy/db';

import {
  BUDGET_LOW_FRACTION,
  applyGas,
  canAfford,
  composeGasFeeWei,
  gasUsdc,
  isExhausted,
  isLow,
  planExhaustion,
  remaining,
  remainingFraction,
  type BudgetState,
} from '../src/budget.js';

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

function state(budget: string, gas = '0', pay = '0'): BudgetState {
  return { budgetUsdc: D(budget), spentGasUsdc: D(gas), spentPayUsdc: D(pay) };
}

// ---------------------------------------------------------------------------
// The anchor: real numbers from the real first transaction.
// ---------------------------------------------------------------------------

/** Measured on chain 2026-08-04: wei that left the relay for the CVY-003 tx. */
const CVY003_RELAY_DELTA_WEI = '422453372102';
const CVY003_L1_FEE_WEI = '12053372102';

describe('anchored to the CVY-003 transaction', () => {
  const tape = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../packages/kh-client/test/vcr/cvy-003.openRun.firstTx.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as { status: { gasUsedWei: string; gasPriceWei: string } };

  it("KeeperHub's gasUsedWei is gas UNITS, not wei (gap G-28)", () => {
    // 68400 is the receipt's gasUsed. If it were wei, the whole fee would be
    // 0.0000000000000684 ETH — three orders of magnitude below a single unit of
    // gas at this price. The field name is simply wrong.
    expect(tape.status.gasUsedWei).toBe('68400');
    expect(tape.status.gasPriceWei).toBe('6000000');
  });

  it('the composed fee equals the wei that actually left the relay', () => {
    const fee = composeGasFeeWei({
      gasUsedUnits: tape.status.gasUsedWei,
      gasPriceWei: tape.status.gasPriceWei,
      l1FeeWei: CVY003_L1_FEE_WEI,
    });
    // 68400 * 6000000 + 12053372102 = 422453372102, to the wei.
    expect(fee.weiTotal.toString()).toBe(CVY003_RELAY_DELTA_WEI);
    expect(fee.weiL2.toString()).toBe('410400000000');
    expect(fee.l1FeeIncluded).toBe(true);
  });

  it('omitting the L1 fee understates the total, and says so', () => {
    const fee = composeGasFeeWei({
      gasUsedUnits: tape.status.gasUsedWei,
      gasPriceWei: tape.status.gasPriceWei,
    });
    expect(fee.l1FeeIncluded).toBe(false);
    expect(fee.weiTotal.lessThan(D(CVY003_RELAY_DELTA_WEI))).toBe(true);
    // ~2.9% on this transaction — far too large to drop silently.
    expect(fee.weiTotal.toString()).toBe('410400000000');
  });

  it('feeding gas UNITS into the formula understates cost by ~6.2 million times', () => {
    // This is the bug the rename exists to make unreachable.
    const wrong = gasUsdc(tape.status.gasUsedWei, '3400');
    const right = gasUsdc(CVY003_RELAY_DELTA_WEI, '3400');
    expect(right.div(wrong).toNumber()).toBeGreaterThan(6_000_000);
    expect(right.toFixed(9)).toBe('0.001436341');
  });
});

// ---------------------------------------------------------------------------

describe('the pinned formula', () => {
  it('is (wei / 1e18) * runEthUsd', () => {
    expect(gasUsdc('1000000000000000000', '3400').toString()).toBe('3400');
    expect(gasUsdc('500000000000000000', '3400').toString()).toBe('1700');
  });

  it('uses the run-frozen rate, so two runs price the same gas differently', () => {
    const wei = CVY003_RELAY_DELTA_WEI;
    expect(gasUsdc(wei, '3400').equals(gasUsdc(wei, '4000'))).toBe(false);
  });

  it('never uses floating point on the wei path', () => {
    const wei = '123456789012345678901';
    expect(gasUsdc(wei, '3400').toString()).toBe('419753.08264197530826');
    expect(Number(wei).toString()).not.toBe(wei);
  });
});

describe('remaining and thresholds', () => {
  it('remaining subtracts both legs', () => {
    expect(remaining(state('100', '10', '5')).toString()).toBe('85');
  });

  it('never reports negative remaining', () => {
    expect(remaining(state('10', '25')).toString()).toBe('0');
  });

  it('amber at exactly 20% remaining', () => {
    expect(BUDGET_LOW_FRACTION).toBe(0.2);
    expect(isLow(state('100', '79'))).toBe(false);
    expect(isLow(state('100', '80'))).toBe(true); // 20.0% left — inclusive
    expect(isLow(state('100', '81'))).toBe(true);
  });

  it('a zero budget reads as exhausted rather than dividing by zero', () => {
    expect(remainingFraction(state('0'))).toBe(0);
    expect(isExhausted(state('0'))).toBe(true);
  });

  it('the pay leg counts even though it is unused until CVY-017', () => {
    // G-17: x402 has no Base Sepolia path, so this stays zero — but the column
    // and the arithmetic are present so CVY-017 is a value change, not a rewrite.
    expect(remaining(state('100', '0', '30')).toString()).toBe('70');
  });
});

describe('applyGas', () => {
  it('drains the meter by the real gas cost', () => {
    const fee = composeGasFeeWei({
      gasUsedUnits: '68400',
      gasPriceWei: '6000000',
      l1FeeWei: CVY003_L1_FEE_WEI,
    });
    const u = applyGas(state('1'), fee, '3400');
    expect(u.gasUsdc.toFixed(9)).toBe('0.001436341');
    expect(u.next.spentGasUsdc.toFixed(9)).toBe('0.001436341');
    expect(u.exhausted).toBe(false);
  });

  it('reports the LOW crossing once, not on every later update', () => {
    // BUDGET_LOW is an event; emitting it repeatedly would spam the timeline
    // and train the operator to ignore it.
    const fee = composeGasFeeWei({ gasUsedUnits: '1', gasPriceWei: '1e18' }); // 1 ETH
    let s = state('10'); // 10 USDC budget, 1 ETH @ $3.4 => 3.4 USDC per step
    const crossings: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      const u = applyGas(s, fee, '3.4');
      crossings.push(u.crossedLow);
      s = u.next;
    }
    // 3.4 -> 6.6 left (66%), 6.8 -> 3.2 left (32%), 10.2 -> 0 left (exhausted)
    expect(crossings).toEqual([false, false, true]);
  });

  it('flags exhaustion when spend meets or passes the budget', () => {
    const fee = composeGasFeeWei({ gasUsedUnits: '1', gasPriceWei: '1e18' });
    const u = applyGas(state('3.4'), fee, '3.4');
    expect(u.exhausted).toBe(true);
    expect(remaining(u.next).toString()).toBe('0');
  });
});

describe('canAfford — the deterministic half of VETO(over_budget)', () => {
  it('approves an allocation that fits', () => {
    expect(canAfford(state('100', '10'), { itemIdx: 3, gasBudgetUsdc: D('5') }).verdict).toBe(
      'affordable',
    );
  });

  it('vetoes an allocation larger than what is left', () => {
    const v = canAfford(state('100', '96'), { itemIdx: 3, gasBudgetUsdc: D('5') });
    expect(v.verdict).toBe('over_budget');
    expect(v.reason).toContain('exceeds');
  });

  it('reports exhausted separately from over_budget — different outcomes', () => {
    // over_budget is a VETO (terminal, zero gas). exhausted is SKIPPED. Collapsing
    // them would mislabel every item after the budget runs out.
    expect(canAfford(state('10', '10'), { itemIdx: 0, gasBudgetUsdc: D('1') }).verdict).toBe(
      'exhausted',
    );
  });

  it('does NOT veto an item that simply has no allocation', () => {
    // A missing number is not evidence of over-spend. CVY-011's bar is zero
    // false vetoes on valid items.
    const v = canAfford(state('100'), { itemIdx: 1, gasBudgetUsdc: null });
    expect(v.verdict).toBe('affordable');
    expect(v.reason).toMatch(/not a budget veto/);
  });
});

describe('exhaustion ends the run rather than crashing it', () => {
  it('marks every unfinished item SKIPPED and seals partial', () => {
    const o = planExhaustion(state('10', '10'), [7, 5, 9]);
    expect(o.skippedIdx).toEqual([5, 7, 9]);
    expect(o.runStatus).toBe('SEALED_PARTIAL');
    expect(o.reason).toContain('SKIPPED');
  });

  it('seals OK when everything finished and nothing was skipped', () => {
    const o = planExhaustion(state('10', '1'), []);
    expect(o.skippedIdx).toEqual([]);
    expect(o.runStatus).toBe('SEALED_OK');
  });

  it('seals partial for unfinished items even when budget remains', () => {
    const o = planExhaustion(state('100', '1'), [4]);
    expect(o.skippedIdx).toEqual([]);
    expect(o.runStatus).toBe('SEALED_PARTIAL');
  });
});
