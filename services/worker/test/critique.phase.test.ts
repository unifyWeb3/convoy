/**
 * CRITIQUING as a phase: the deterministic gate, the Critic on top of it, and
 * the ONE permitted re-plan cycle (CVY-011).
 *
 * `corroborate` is unit-tested where it lives (apps/web/lib/critic). What is
 * tested here is what the worker does with a verdict — which rows move, which
 * events are written, and that the loop is bounded — because those are database
 * transitions and are tested against the real database, like `phasePlan`.
 *
 * The KeeperHub simulate is served from response bodies in the SHAPE the API
 * really returns (`packages/kh-client/test/vcr/simulate.*.json`), through the
 * client's injectable fetch. Nothing here fabricates a failure the product then
 * reports as real: the live measurement is `tests/critic.veto.eval.ts`, which
 * simulates against the deployed contract on 84532.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeRawClient as prisma } from '@convoy/db';
import { KhClient } from '@convoy/kh-client';
import { encodeAbiParameters, keccak256 } from 'viem';

import {
  MAX_REPLAN_CYCLES,
  phaseCritique,
  type CriticAction,
  type CriticFacts,
  type CriticOutcome,
  type OrchestratorDeps,
  type ReplanOutcome,
} from '../src/orchestrator.js';
import type { BudgetState } from '../src/budget.js';
import { Prisma } from '@convoy/db';

const TARGET = '0xD45c61797d7283caf8A31D91A5Bd6465A45AD561';
const REGISTRY = '0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA';
const GAS_PRICE = 6_000_000n;

function payloadHash(fn: string, args: string[], idx: number): Buffer {
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

interface ItemSpec {
  readonly fn: string;
  readonly args: string[];
  readonly evidence: string;
  readonly gasBudgetUsdc?: string;
}

let runId: string;
const created: string[] = [];

async function makeRun(items: readonly ItemSpec[]): Promise<string> {
  const run = await prisma.run.create({
    data: {
      status: 'CRITIQUING',
      budgetUsdc: new Prisma.Decimal('25.000000'),
      runEthUsd: new Prisma.Decimal('3400.000000'),
      items: {
        create: items.map((it, idx) => ({
          idx,
          targetAddr: Buffer.from(TARGET.slice(2), 'hex'),
          functionName: it.fn,
          functionArgs: it.args,
          payloadHash: payloadHash(it.fn, it.args, idx),
          evidence: it.evidence,
          state: 'PLANNED',
          dependsOn: [],
          ...(it.gasBudgetUsdc === undefined
            ? {}
            : { gasBudgetUsdc: new Prisma.Decimal(it.gasBudgetUsdc) }),
        })),
      },
    },
  });
  created.push(run.id);
  return run.id;
}

/**
 * A KeeperHub client whose simulate answers per function name.
 *
 * `wouldRevert:true` really does arrive on HTTP 400 with `success:false` — that
 * is the API's shape, not a convenience here (see kh-client types.ts).
 */
function khWith(reverts: Readonly<Record<string, string>>, gasEstimate = '45903'): KhClient {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { functionName: string };
    const selector = reverts[body.functionName];
    if (selector !== undefined) {
      // The API does not return a selector field. It returns an ethers
      // CALL_EXCEPTION string with the 4 bytes embedded in `data="0x…"`, and
      // `extractRevertSelector` digs them back out (gap G-20, tape
      // simulate.wouldRevert.true.json). Reproducing that shape is the point —
      // a fake with a tidy `revertSelector` field would test a decode path the
      // product does not have.
      return await Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            status: 'simulated',
            wouldRevert: true,
            revertReason:
              `Simulation reverted: execution reverted (action="estimateGas", ` +
              `data="${selector}", reason=null, code=CALL_EXCEPTION, version=6.16.0)`,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return await Promise.resolve(
      new Response(JSON.stringify({ success: true, wouldRevert: false, gasEstimate }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    fetchImpl,
    retry: { maxAttempts: 1 },
  });
}

function budget(): BudgetState {
  return {
    budgetUsdc: new Prisma.Decimal('25.000000'),
    spentGasUsdc: new Prisma.Decimal(0),
    spentPayUsdc: new Prisma.Decimal(0),
  };
}

function deps(kh: KhClient, extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return { kh, registryAddr: REGISTRY, ...extra };
}

/** A Critic that vetoes exactly the named functions, citing evidence. */
function criticVetoing(
  fns: readonly string[],
  reason: 'evidence_mismatch' | 'unmet_dependency' = 'evidence_mismatch',
): (calls: CriticAction[]) => OrchestratorDeps['critic'] {
  return (calls) => async (action, facts) => {
    calls.push(action);
    void (facts satisfies CriticFacts);
    const veto = fns.includes(action.functionName);
    return await Promise.resolve<CriticOutcome>({
      approved: !veto,
      ...(veto ? { reason } : {}),
      decidedBy: 'critic',
      detail: veto ? 'the evidence names a different amount' : 'matches the evidence',
      overrides: [],
      criticConsulted: true,
    });
  };
}

afterAll(async () => {
  await prisma.run.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  runId = '';
});

describe('phaseCritique — the deterministic gate', () => {
  it('vetoes a genuine revert without consulting the Critic at all', async () => {
    runId = await makeRun([
      { fn: 'setRoot', args: ['0xc3'], evidence: 'a second root from the previous epoch sheet' },
    ]);
    const seen: CriticAction[] = [];

    const result = await phaseCritique(
      deps(khWith({ setRoot: '0xb466ddbf' }), {
        critic: criticVetoing([])(seen),
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.ready).toEqual([]);
    expect(result.vetoed).toHaveLength(1);
    expect(result.vetoed[0]?.vetoReason).toBe('would_revert');
    expect(result.vetoed[0]?.decidedBy).toBe('simulator');
    // The simulator's veto is final, so no tokens are spent asking about it.
    expect(seen).toHaveLength(0);

    const item = await prisma.item.findUniqueOrThrow({ where: { runId_idx: { runId, idx: 0 } } });
    expect(item.state).toBe('VETOED');
    expect(item.vetoReason).toBe('would_revert');
  });

  it('decodes the custom-error selector into the contract-level reason', async () => {
    runId = await makeRun([{ fn: 'enableMarket', args: ['1'], evidence: 'open market 1' }]);

    const result = await phaseCritique(
      deps(khWith({ enableMarket: '0x30f065ef' })),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.vetoed[0]?.reason).toContain('MarketAlreadyEnabled()');
    const event = await prisma.event.findFirst({
      where: { runId, type: 'ITEM_VETOED' },
      orderBy: { id: 'desc' },
    });
    expect((event?.payload as { revert?: string }).revert).toBe('MarketAlreadyEnabled()');
  });

  it('vetoes on the per-item budget projection — arithmetic, not judgement', async () => {
    runId = await makeRun([
      { fn: 'fund', args: ['250000000'], evidence: 'fund 250 USDC', gasBudgetUsdc: '0.000001' },
    ]);
    const seen: CriticAction[] = [];

    const result = await phaseCritique(
      deps(khWith({}), { critic: criticVetoing([])(seen) }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.vetoed[0]?.vetoReason).toBe('over_budget');
    expect(result.vetoed[0]?.decidedBy).toBe('arithmetic');
    expect(result.vetoed[0]?.reason).toContain('0.000001 USDC allocation');
    expect(seen).toHaveLength(0);
  });

  it('does not veto for a missing gas price — unknown is never over budget', async () => {
    runId = await makeRun([
      { fn: 'fund', args: ['250000000'], evidence: 'fund 250 USDC', gasBudgetUsdc: '0.000001' },
    ]);

    // No gasPriceWei and no reachable RPC: the projection is `unknown`, and the
    // item passes. The alternative — vetoing on a number nobody has — is the
    // false veto the hard acceptance bar exists to prevent.
    const result = await phaseCritique(deps(khWith({})), runId, budget(), {
      gasPriceWei: undefined,
    });

    // Either the RPC answered (item is judged on a real price and its tiny
    // allocation is genuinely exceeded) or it did not (unknown, approved). Both
    // are correct; what must never happen is a veto with no arithmetic behind it.
    if (result.vetoed.length > 0) {
      expect(result.vetoed[0]?.reason).toContain('projects to');
    } else {
      expect(result.ready).toEqual([0]);
    }
  });
});

describe('phaseCritique — the Critic layered on top', () => {
  it('vetoes evidence_mismatch that the simulator cannot see', async () => {
    runId = await makeRun([
      {
        fn: 'fund',
        args: ['500000000'],
        evidence: 'Top-up of 250 USDC against the epoch-42 root; the sheet totals 250.000000.',
      },
    ]);
    const seen: CriticAction[] = [];

    const result = await phaseCritique(
      deps(khWith({}), { critic: criticVetoing(['fund'])(seen) }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.ready).toEqual([]);
    expect(result.vetoed[0]?.vetoReason).toBe('evidence_mismatch');
    expect(result.vetoed[0]?.decidedBy).toBe('critic');
    // The simulate said this call succeeds. Only the Critic caught it.
    expect(seen[0]?.simulator.wouldRevert).toBe(false);
    expect(seen[0]?.simulator.gasEstimate).toBe('45903');
  });

  it('hands the Critic a symbolic target name, never an address', async () => {
    runId = await makeRun([{ fn: 'fund', args: ['1'], evidence: 'fund it' }]);
    const seen: CriticAction[] = [];

    await phaseCritique(deps(khWith({}), { critic: criticVetoing([])(seen) }), runId, budget(), {
      gasPriceWei: GAS_PRICE,
    });

    expect(seen[0]?.target).not.toMatch(/^0x/);
    expect(JSON.stringify(seen[0])).not.toContain(TARGET.slice(2, 10));
  });

  it('approves and records that the Critic was consulted', async () => {
    runId = await makeRun([{ fn: 'enableMarket', args: ['7'], evidence: 'open market 7' }]);
    const seen: CriticAction[] = [];

    const result = await phaseCritique(
      deps(khWith({}), { critic: criticVetoing([])(seen) }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.ready).toEqual([0]);
    expect(result.vetoed).toEqual([]);
    const item = await prisma.item.findUniqueOrThrow({ where: { runId_idx: { runId, idx: 0 } } });
    expect(item.state).toBe('SIMULATED');
    const event = await prisma.event.findFirst({
      where: { runId, type: 'ITEM_SIMULATED' },
      orderBy: { id: 'desc' },
    });
    expect((event?.payload as { criticConsulted?: boolean }).criticConsulted).toBe(true);
  });

  it('falls back to the simulator-only gate when no Critic is wired', async () => {
    runId = await makeRun([{ fn: 'enableMarket', args: ['7'], evidence: 'open market 7' }]);

    const result = await phaseCritique(deps(khWith({})), runId, budget(), {
      gasPriceWei: GAS_PRICE,
    });

    expect(result.ready).toEqual([0]);
    // Reported as not-consulted rather than as an approval the Critic granted.
    expect(result.vetoed).toEqual([]);
    const event = await prisma.event.findFirst({
      where: { runId, type: 'ITEM_SIMULATED' },
      orderBy: { id: 'desc' },
    });
    expect((event?.payload as { criticConsulted?: boolean }).criticConsulted).toBe(false);
  });

  it('treats a thrown Critic as unavailable, not as a veto', async () => {
    runId = await makeRun([{ fn: 'enableMarket', args: ['7'], evidence: 'open market 7' }]);

    const result = await phaseCritique(
      deps(khWith({}), {
        critic: async () => {
          throw new Error('ECONNRESET');
        },
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    // A provider outage must not look like a batch full of bad items.
    expect(result.ready).toEqual([0]);
    expect(result.vetoed).toEqual([]);
  });
});

describe('phaseCritique — the one permitted re-plan cycle', () => {
  const REPLANNABLE: ItemSpec[] = [
    { fn: 'fund', args: ['250000000'], evidence: 'fund 250 USDC', gasBudgetUsdc: '0.000001' },
    { fn: 'enableMarket', args: ['7'], evidence: 'open market 7' },
  ];

  it('runs no cycle at all when no replan port is wired', async () => {
    runId = await makeRun(REPLANNABLE);

    const result = await phaseCritique(deps(khWith({})), runId, budget(), {
      gasPriceWei: GAS_PRICE,
    });

    expect(result.replanCycles).toBe(0);
    expect(result.vetoed.map((v) => v.idx)).toEqual([0]);
    expect(result.failedIdx).toEqual([]);
  });

  it('re-plans once, and a revised allocation can rescue the item', async () => {
    runId = await makeRun(REPLANNABLE);
    let calls = 0;

    const result = await phaseCritique(
      deps(khWith({}), {
        replan: async (request) => {
          calls += 1;
          expect(request.vetoed.map((v) => v.reason)).toEqual(['over_budget']);
          return await Promise.resolve<ReplanOutcome>({
            gasBudgetPerItem: [{ idx: 0, gasBudgetUsdc: '1.000000' }],
            retryIdx: [0],
            note: 'raised the allocation on item 0',
          });
        },
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(calls).toBe(1);
    expect(result.replanCycles).toBe(MAX_REPLAN_CYCLES);
    expect(result.ready).toEqual([0, 1]);
    expect(result.vetoed).toEqual([]);
    expect(result.failedIdx).toEqual([]);

    const item = await prisma.item.findUniqueOrThrow({ where: { runId_idx: { runId, idx: 0 } } });
    expect(item.state).toBe('SIMULATED');
    expect(item.vetoReason).toBeNull();
  });

  it('FAILS an item that is still vetoed after its one re-plan, and asks no more', async () => {
    runId = await makeRun(REPLANNABLE);
    let calls = 0;

    const result = await phaseCritique(
      deps(khWith({}), {
        replan: async () => {
          calls += 1;
          // A re-plan that changes nothing. The item comes back vetoed.
          return await Promise.resolve<ReplanOutcome>({
            retryIdx: [0],
            note: 'no allocation change available',
          });
        },
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(calls).toBe(1);
    expect(result.failedIdx).toEqual([0]);

    const item = await prisma.item.findUniqueOrThrow({ where: { runId_idx: { runId, idx: 0 } } });
    expect(item.state).toBe('FAILED');
    // The closed-enum reason survives the move to FAILED.
    expect(item.vetoReason).toBe('over_budget');

    const failed = await prisma.event.findFirst({
      where: { runId, itemIdx: 0, type: 'ITEM_FAILED' },
      orderBy: { id: 'desc' },
    });
    expect((failed?.payload as { replanCycles?: number }).replanCycles).toBe(MAX_REPLAN_CYCLES);
  });

  it('leaves an item the re-plan did not ask to revisit VETOED, not FAILED', async () => {
    runId = await makeRun(REPLANNABLE);

    const result = await phaseCritique(
      deps(khWith({}), {
        replan: async () =>
          await Promise.resolve<ReplanOutcome>({ retryIdx: [], note: 'nothing to revise' }),
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.failedIdx).toEqual([]);
    expect(result.vetoed.map((v) => v.idx)).toEqual([0]);
    const item = await prisma.item.findUniqueOrThrow({ where: { runId_idx: { runId, idx: 0 } } });
    // Never re-planned, so never "persistently" vetoed. Overstating what was
    // tried would misreport the run.
    expect(item.state).toBe('VETOED');
  });

  it('honours a declined re-plan without a cycle', async () => {
    runId = await makeRun(REPLANNABLE);

    const result = await phaseCritique(
      deps(khWith({}), { replan: async () => await Promise.resolve(undefined) }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(result.replanCycles).toBe(0);
    expect(result.notes.join(' ')).toContain('re-plan declined');
    expect(result.vetoed.map((v) => v.idx)).toEqual([0]);
  });

  it('is bounded by MAX_REPLAN_CYCLES, whatever the replan port asks for', async () => {
    runId = await makeRun(REPLANNABLE);
    let calls = 0;

    await phaseCritique(
      deps(khWith({}), {
        replan: async () => {
          calls += 1;
          return await Promise.resolve<ReplanOutcome>({ retryIdx: [0], note: 'again please' });
        },
      }),
      runId,
      budget(),
      { gasPriceWei: GAS_PRICE },
    );

    expect(MAX_REPLAN_CYCLES).toBe(1);
    expect(calls).toBe(1);
  });
});
