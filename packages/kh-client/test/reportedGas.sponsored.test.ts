/**
 * `gasUsedWei` means two different things depending on `sponsored` (gap G-31).
 *
 * The numbers below are not invented. They are the exact triples measured
 * against Base Sepolia receipts by `services/worker/scripts/gasfield.mjs` on
 * 2026-08-04 — one sponsored execution and two the org Turnkey wallet paid for
 * itself. A hand-written example could agree with the implementation and still
 * be wrong about the API; these cannot.
 */
import { describe, expect, it } from 'vitest';

import { decodeReportedGas, extractSponsored } from '../src/reportedGas.js';

// tx 0x5e88cfb2… — relay-sent, paymaster paid. receipt.gasUsed == 66226.
const SPONSORED = {
  status: 'completed',
  transactionHash: '0x5e88cfb28cb7097f99c50bc2a0eae601b282119530a9ee6fdf3e72d3db8f17a7',
  sponsored: true,
  gasUsedWei: '66226',
  gasPriceWei: '6000000',
  result: { sponsored: true, executedCall: { sponsored: true } },
};

// tx 0x2d737fa8… — org-wallet-sent, wallet paid. receipt.gasUsed == 45903 and
// 45903 * 6000000 == 275418000000, which is what the field carries.
const UNSPONSORED = {
  status: 'completed',
  transactionHash: '0x2d737fa88fa64fd1722b5d5d105b70230227682fa71c191d1b200a853ab5d107',
  sponsored: false,
  gasUsedWei: '275418000000',
  gasPriceWei: '6000000',
  // NOTE: `result.sponsored` is ABSENT here — measured. Only the top level and
  // `result.executedCall` carry the flag on an unsponsored record.
  result: { executedCall: { sponsored: false } },
};

describe('decodeReportedGas', () => {
  it('reads a sponsored record as gas UNITS', () => {
    const g = decodeReportedGas(SPONSORED);
    expect(g.sponsored).toBe(true);
    expect(g.gasReportedMeaning).toBe('units');
    expect(g.gasUsedUnits).toBe('66226');
    expect(g.gasFeeWeiL2).toBeUndefined();
  });

  it('reads an unsponsored record as the L2 fee in WEI', () => {
    const g = decodeReportedGas(UNSPONSORED);
    expect(g.sponsored).toBe(false);
    expect(g.gasReportedMeaning).toBe('weiL2');
    expect(g.gasFeeWeiL2).toBe('275418000000');
    // The load-bearing assertion. Before G-31 this field was `gasUsedUnits`
    // unconditionally, so an unsponsored record fed 275418000000 into a
    // units × price multiplication — overstating the fee 6,000,000×.
    expect(g.gasUsedUnits).toBeUndefined();
  });

  it('refuses to guess when `sponsored` is absent', () => {
    // Ambiguity is reported, never resolved by assumption. A consumer that gets
    // neither typed field falls back to the chain receipt, which is correct.
    const g = decodeReportedGas({ gasUsedWei: '66226', gasPriceWei: '6000000' });
    expect(g.gasReportedMeaning).toBe('ambiguous');
    expect(g.gasUsedUnits).toBeUndefined();
    expect(g.gasFeeWeiL2).toBeUndefined();
    expect(g.gasReportedRaw).toBe('66226');
    expect(g.sponsored).toBeUndefined();
  });

  it('always keeps the raw field for the audit drawer', () => {
    expect(decodeReportedGas(SPONSORED).gasReportedRaw).toBe('66226');
    expect(decodeReportedGas(UNSPONSORED).gasReportedRaw).toBe('275418000000');
  });

  it('is empty rather than zero when the field is missing entirely', () => {
    const g = decodeReportedGas({ status: 'pending' });
    expect(g.gasReportedRaw).toBeUndefined();
    expect(g.gasReportedMeaning).toBeUndefined();
  });
});

describe('extractSponsored', () => {
  it('prefers the top-level flag', () => {
    expect(extractSponsored(SPONSORED)).toBe(true);
    expect(extractSponsored(UNSPONSORED)).toBe(false);
  });

  it('falls back through result.sponsored to result.executedCall.sponsored', () => {
    expect(extractSponsored({ result: { sponsored: true } })).toBe(true);
    expect(extractSponsored({ result: { executedCall: { sponsored: false } } })).toBe(false);
  });

  it('distinguishes a missing flag from false', () => {
    // `undefined` and `false` must not collapse: one means "the wallet paid",
    // the other means "we do not know who paid".
    expect(extractSponsored({ status: 'completed' })).toBeUndefined();
    expect(extractSponsored({ sponsored: false })).toBe(false);
  });

  it('ignores a non-boolean flag rather than coercing it', () => {
    expect(extractSponsored({ sponsored: 'true' })).toBeUndefined();
  });
});
