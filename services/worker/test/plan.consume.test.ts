/**
 * `phasePlan` consuming a stored Planner plan.
 *
 * This is the CVY-010 boundary (D-030): the Planner writes `runs.plan`, the
 * worker reads it. The load-bearing rule is that **the Planner may add
 * constraints and may never remove one the operator declared** — CVY-010
 * measured that the model omits transitively-redundant edges, and
 * `releaseDeferred` reads `item.dependsOn`, so an overwrite would let an LLM
 * silently drop a safety constraint.
 *
 * The pure edge helpers are tested directly; `phasePlan` itself is exercised
 * against the real database, because what it does IS a database transition.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeRawClient as prisma } from '@convoy/db';
import { encodeAbiParameters, keccak256 } from 'viem';

import {
  edgesFromItems,
  findCycleEdges,
  phasePlan,
  readStoredPlan,
  unionEdges,
} from '../src/orchestrator.js';

const TARGET = '0xD45c61797d7283caf8A31D91A5Bd6465A45AD561';

function payloadHash(fn: string, args: string[], idx: number): Buffer {
  // Same encoding as the seed and `run3.mjs`. `phasePlan` never reads this
  // value — it exists so the row is well-formed — but using the real scheme
  // keeps the fixture indistinguishable from a production row.
  const hex = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
      [
        TARGET as `0x${string}`,
        fn,
        encodeAbiParameters([{ type: 'string' }], [JSON.stringify(args)]),
        BigInt(idx),
      ],
    ),
  );
  return Buffer.from(hex.slice(2), 'hex');
}

let runId: string;

/** A fresh 3-item run: item 1 declares a dependency on item 0. */
async function makeRun(plan: unknown): Promise<string> {
  const run = await prisma.run.create({
    data: {
      status: 'PLANNING',
      budgetUsdc: '10.000000',
      runEthUsd: '3400.000000',
      ...(plan === undefined ? {} : { plan: plan as never }),
      items: {
        create: [0, 1, 2].map((idx) => ({
          idx,
          targetAddr: Buffer.from(TARGET.slice(2), 'hex'),
          functionName: 'enableMarket',
          functionArgs: [String(900 + idx)],
          payloadHash: payloadHash('enableMarket', [String(900 + idx)], idx),
          evidence: `item ${idx}`,
          state: 'PENDING',
          dependsOn: idx === 1 ? [0] : [],
        })),
      },
    },
  });
  return run.id;
}

afterAll(async () => {
  if (runId !== undefined) await prisma.run.deleteMany({ where: { id: runId } });
});

describe('edge helpers', () => {
  it('reads declared edges off the items', () => {
    expect(
      edgesFromItems([
        { idx: 1, dependsOn: [0] },
        { idx: 2, dependsOn: [] },
      ]),
    ).toEqual([{ idx: 1, dependsOn: 0 }]);
  });

  it('unions without duplicating, and drops self-edges', () => {
    const out = unionEdges(
      [{ idx: 1, dependsOn: 0 }],
      [
        { idx: 1, dependsOn: 0 },
        { idx: 2, dependsOn: 1 },
        { idx: 3, dependsOn: 3 },
      ],
    );
    expect(out).toEqual([
      { idx: 1, dependsOn: 0 },
      { idx: 2, dependsOn: 1 },
    ]);
  });

  it('catches a cycle formed only BY the union', () => {
    // Each set is individually acyclic; together they are not. This is the case
    // the union has to defend against, and it is why the check exists.
    const a = [{ idx: 1, dependsOn: 0 }];
    const b = [{ idx: 0, dependsOn: 1 }];
    expect(findCycleEdges(a)).toBeUndefined();
    expect(findCycleEdges(b)).toBeUndefined();
    expect(findCycleEdges(unionEdges(a, b))).toBeDefined();
  });
});

describe('readStoredPlan — jsonb can hold anything', () => {
  it('accepts a well-formed plan', () => {
    const p = readStoredPlan({
      source: 'planner',
      order: [0, 1],
      deferrals: [{ idx: 1, dependsOn: 0 }],
      gasBudgetPerItem: [{ idx: 0, gasBudgetUsdc: '1.000000' }],
      excludedIdx: [2],
      warnings: ['w'],
    });
    expect(p?.deferrals).toEqual([{ idx: 1, dependsOn: 0 }]);
    expect(p?.excludedIdx).toEqual([2]);
  });

  it('treats null, arrays and primitives as absent rather than throwing', () => {
    for (const v of [null, undefined, [], 'plan', 42]) expect(readStoredPlan(v)).toBeUndefined();
  });

  it('treats a plan from an older build as absent', () => {
    // A missing `deferrals` is not a plan with no deferrals — it is a shape this
    // build does not understand, and guessing would be worse than degrading.
    expect(readStoredPlan({ source: 'planner', order: [0] })).toBeUndefined();
  });

  it('filters malformed rows instead of trusting the array', () => {
    const p = readStoredPlan({
      source: 'planner',
      order: [0, 'x', 1.5, 1],
      deferrals: [{ idx: 1, dependsOn: 0 }, { idx: 'a', dependsOn: 0 }, null],
      gasBudgetPerItem: [{ idx: 0, gasBudgetUsdc: 1 }],
      excludedIdx: ['no'],
      warnings: [1, 'ok'],
    });
    expect(p?.order).toEqual([0, 1]);
    expect(p?.deferrals).toEqual([{ idx: 1, dependsOn: 0 }]);
    expect(p?.gasBudgetPerItem).toEqual([]); // a number is not a decimal string
    expect(p?.excludedIdx).toEqual([]);
    expect(p?.warnings).toEqual(['ok']);
  });
});

describe('phasePlan', () => {
  beforeEach(async () => {
    if (runId !== undefined) await prisma.run.deleteMany({ where: { id: runId } });
  });

  it('falls back to the declared edges when there is no stored plan', async () => {
    runId = await makeRun(undefined);
    await phasePlan(runId);

    const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
    expect(items.map((i) => i.state)).toEqual(['PLANNED', 'DEFERRED', 'PLANNED']);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect((run.plan as { source: string }).source).toBe('fallback-topological');
    expect(run.status).toBe('CRITIQUING');
  });

  it('ADDS a Planner edge the operator did not declare', async () => {
    runId = await makeRun({
      source: 'planner',
      order: [0, 1, 2],
      deferrals: [{ idx: 2, dependsOn: 1 }],
      gasBudgetPerItem: [{ idx: 2, gasBudgetUsdc: '2.500000' }],
      excludedIdx: [],
      warnings: [],
    });
    await phasePlan(runId);

    const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
    expect(items[2]?.dependsOn).toEqual([1]);
    expect(items[2]?.state).toBe('DEFERRED');
    expect(items[2]?.gasBudgetUsdc?.toFixed(6)).toBe('2.500000');
  });

  it('NEVER drops a declared edge the Planner omitted', async () => {
    // The regression this test exists for. The Planner's extraction omits 1←0;
    // the operator declared it. An overwrite would leave item 1 PLANNED and the
    // deferral gate would release it before item 0 had landed.
    runId = await makeRun({
      source: 'planner',
      order: [0, 1, 2],
      deferrals: [{ idx: 2, dependsOn: 0 }],
      gasBudgetPerItem: [],
      excludedIdx: [],
      warnings: [],
    });
    await phasePlan(runId);

    const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
    expect(items[1]?.dependsOn).toEqual([0]);
    expect(items[1]?.state).toBe('DEFERRED');
    expect(items[2]?.dependsOn).toEqual([0]);
  });

  it('keeps the declared edges when the union would form a cycle', async () => {
    runId = await makeRun({
      source: 'planner',
      order: [1, 0, 2],
      deferrals: [{ idx: 0, dependsOn: 1 }], // reverses the declared 1←0
      gasBudgetPerItem: [],
      excludedIdx: [],
      warnings: [],
    });
    await phasePlan(runId);

    const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
    expect(items[0]?.dependsOn).toEqual([]);
    expect(items[1]?.dependsOn).toEqual([0]);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(JSON.stringify((run.plan as { warnings: string[] }).warnings)).toContain('cycle');
  });

  it('VETOES a non-whitelisted item at zero gas instead of planning it', async () => {
    runId = await makeRun({
      source: 'planner',
      order: [0, 1],
      deferrals: [],
      gasBudgetPerItem: [],
      excludedIdx: [2],
      warnings: ['excluded item(s) 2: target not in the run whitelist'],
    });
    await phasePlan(runId);

    const items = await prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } });
    expect(items[2]?.state).toBe('VETOED');
    expect(items[2]?.vetoReason).toBe('evidence_mismatch');
    expect(await prisma.attempt.count({ where: { item: { runId } } })).toBe(0);
  });

  it('records the EFFECTIVE edges, plus what each source proposed', async () => {
    // A plan whose edges were overridden must not be stored as if it had been
    // used — the audit drawer has to be able to show the disagreement.
    runId = await makeRun({
      source: 'planner',
      order: [0, 1, 2],
      deferrals: [{ idx: 2, dependsOn: 1 }],
      gasBudgetPerItem: [],
      excludedIdx: [],
      warnings: [],
    });
    await phasePlan(runId);

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const plan = run.plan as {
      deferrals: { idx: number; dependsOn: number }[];
      plannerDeferrals: { idx: number; dependsOn: number }[];
      declaredDeferrals: { idx: number; dependsOn: number }[];
    };
    expect(plan.deferrals).toEqual([
      { idx: 1, dependsOn: 0 },
      { idx: 2, dependsOn: 1 },
    ]);
    expect(plan.plannerDeferrals).toEqual([{ idx: 2, dependsOn: 1 }]);
    expect(plan.declaredDeferrals).toEqual([{ idx: 1, dependsOn: 0 }]);
  });
});
