import { describe, expect, it } from 'vitest';

import fixtureJson from './fixtures/ablation.batch.json';
import {
  computeMetrics,
  parseArgs,
  prepareModeFixture,
  validateFixture,
  type LedgerSnapshot,
} from '../scripts/ablation.js';

const fixture = validateFixture(fixtureJson);

describe('CVY-016 ablation harness', () => {
  it('parses the three modes and rejects conflicting flags', () => {
    expect(parseArgs([]).mode).toBe('baseline');
    expect(parseArgs(['--ablate-planner']).mode).toBe('planner');
    expect(parseArgs(['--ablate-critic']).mode).toBe('critic');
    expect(parseArgs(['--execute', '--resume-run', 'run-1']).resumeRun).toBe('run-1');
    expect(parseArgs(['--snapshot', 'run.json', '--baseline-snapshot', 'base.json']).snapshot).toBe(
      'run.json',
    );
    expect(() => parseArgs(['--ablate-planner', '--ablate-critic'])).toThrow(/one ablation mode/);
  });

  it('validates Base Sepolia, contiguous indices, dependencies and cycles', () => {
    expect(fixture.chainId).toBe('84532');
    expect(() => validateFixture({ ...fixtureJson, chainId: '8453' })).toThrow(/84532/);
    expect(() =>
      validateFixture({ ...fixtureJson, items: [{ ...fixtureJson.items[0], idx: 2 }] }),
    ).toThrow(/contiguous/);
    expect(() =>
      validateFixture({
        ...fixtureJson,
        items: fixtureJson.items.map((item) =>
          item.idx === 0 ? { ...item, dependsOn: [0] } : item,
        ),
      }),
    ).toThrow(/cannot depend/);
  });

  it('uses input order with no edges for planner ablation', () => {
    const prepared = prepareModeFixture(fixture, 'planner');
    expect(prepared.plan.source).toBe('ablation-planner');
    expect(prepared.plan.order).toEqual(fixture.items.map((item) => item.idx));
    expect(prepared.plan.deferrals).toEqual([]);
    expect(prepared.items.every((item) => item.dependsOn.length === 0)).toBe(true);
  });

  it('preserves the plan but bypasses only the gate for critic ablation', () => {
    const prepared = prepareModeFixture(fixture, 'critic');
    expect(prepared.plan.deferrals.length).toBeGreaterThan(0);
    expect(prepared.plan.order).not.toEqual(fixture.items.map((item) => item.idx));
    expect(prepared.gate).toBe('bypassed');
  });

  it('computes metrics from ledger evidence, not expected fixture numbers', () => {
    const snapshot: LedgerSnapshot = {
      budgetUsdc: '10',
      spentGasUsdc: '0.750000',
      spentPayUsdc: '0.250000',
      items: [
        { idx: 0, state: 'LANDED', dependsOn: [] },
        { idx: 1, state: 'FAILED', dependsOn: [0], intendedInvalid: true },
        { idx: 2, state: 'DEFERRED', dependsOn: [1] },
      ],
      attempts: [
        { itemIdx: 0, kind: 'EXECUTE', status: 'completed', txHash: '0x01', gasUsedUsdc: '0.1' },
        { itemIdx: 1, kind: 'EXECUTE', status: 'failed', gasUsedUsdc: '0.2' },
        { itemIdx: 2, kind: 'SIMULATE', status: 'failed', gasUsedUsdc: null },
      ],
    };
    const metrics = computeMetrics(snapshot, {
      ...snapshot,
      spentGasUsdc: '0.500000',
      spentPayUsdc: '0.100000',
    });
    expect(metrics.landedItemRate).toBeCloseTo(1 / 2);
    expect(metrics.failedOrRevertedItems).toBe(1);
    expect(metrics.wastedGasEvents).toBe(1);
    expect(metrics.wastedGasUsdc).toBe('0.200000');
    expect(metrics.budgetSpentUsdc).toBe('0.750000');
    expect(metrics.budgetDifferenceUsdc).toBe('0.250000');
    expect(metrics.invalidSubmissions).toBe(1);
    expect(metrics.starvedDependents).toBe(1);
  });
});
