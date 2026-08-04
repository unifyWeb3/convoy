/**
 * Asserts the seeded fixtures are what CVY-008 and GATE 2 will consume.
 *
 * Run `pnpm --filter @convoy/db db:seed` first — these read the database rather
 * than re-running the seed, so a stale database fails loudly instead of being
 * silently re-created underneath the assertions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { keccak256, encodeAbiParameters } from 'viem';

import { bytesToHex } from '../src/index.js';

const raw = new PrismaClient();
afterAll(async () => {
  await raw.$disconnect();
});

const RUN_3 = '00000000-0000-4000-8000-000000000003';
const RUN_12 = '00000000-0000-4000-8000-000000000012';

async function loadRun(id: string) {
  const run = await raw.run.findUnique({
    where: { id },
    include: { items: { orderBy: { idx: 'asc' } }, events: true },
  });
  if (run === null) {
    throw new Error(`fixture ${id} not seeded — run \`pnpm --filter @convoy/db db:seed\` first`);
  }
  return run;
}

describe('the 3-item fixture (CVY-008)', () => {
  it('has exactly 3 items, contiguous from idx 0', async () => {
    const run = await loadRun(RUN_3);
    expect(run.items).toHaveLength(3);
    expect(run.items.map((i) => i.idx)).toEqual([0, 1, 2]);
  });

  it('encodes the real ordering constraint: fund depends on setRoot', async () => {
    const run = await loadRun(RUN_3);
    const [setRoot, fund, enable] = run.items;
    expect(setRoot?.functionName).toBe('setRoot');
    expect(fund?.functionName).toBe('fund');
    expect(fund?.dependsOn).toEqual([0]);
    expect(enable?.dependsOn).toEqual([1]);
  });

  it('starts every item PENDING with no attempts — nothing has executed', async () => {
    const run = await loadRun(RUN_3);
    expect(run.items.every((i) => i.state === 'PENDING')).toBe(true);
    expect(await raw.attempt.count({ where: { item: { runId: RUN_3 } } })).toBe(0);
  });
});

describe('the 12-item fixture (GATE 2)', () => {
  it('has exactly 12 items', async () => {
    const run = await loadRun(RUN_12);
    expect(run.items).toHaveLength(12);
    expect(run.items.map((i) => i.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('contains genuinely-invalid items for the Critic to veto', async () => {
    // Not staged failures: a duplicate enableMarket reverts MarketAlreadyEnabled()
    // and a second setRoot reverts RootAlreadySet(). The contract rejects them
    // on its own terms — Convoy never fabricates a failure.
    const run = await loadRun(RUN_12);
    const dupEnable = run.items.filter(
      (i) => i.functionName === 'enableMarket' && JSON.stringify(i.functionArgs) === '["1"]',
    );
    expect(dupEnable.length).toBe(2);

    const setRoots = run.items.filter((i) => i.functionName === 'setRoot');
    expect(setRoots.length).toBe(2);
  });

  it('every dependsOn points at a real, earlier item — no cycles, no dangling', async () => {
    const run = await loadRun(RUN_12);
    for (const item of run.items) {
      for (const dep of item.dependsOn) {
        expect(dep, `item ${item.idx} depends on ${dep}`).toBeLessThan(item.idx);
        expect(run.items.some((i) => i.idx === dep)).toBe(true);
      }
    }
  });
});

describe('both fixtures', () => {
  it('carry no transaction hash — a seeded hash would be a fabricated one', async () => {
    expect(await raw.attempt.count({ where: { txHash: { not: null } } })).toBe(0);
  });

  it('store the frozen ETH/USD rate so gas accounting is reproducible', async () => {
    for (const id of [RUN_3, RUN_12]) {
      const run = await loadRun(id);
      expect(Number(run.runEthUsd)).toBeGreaterThan(0);
      expect(run.status).toBe('RECEIVED');
      expect(run.sealedAt).toBeNull();
      expect(run.runIdOnchain).toBeNull(); // openRun has not been called for a fixture
    }
  });

  it('emit exactly one RUN_RECEIVED event each', async () => {
    for (const id of [RUN_3, RUN_12]) {
      const run = await loadRun(id);
      expect(run.events).toHaveLength(1);
      expect(run.events[0]?.type).toBe('RUN_RECEIVED');
    }
  });

  it('payloadHash matches the CVY-002 encoding, recomputed independently', async () => {
    // The seed computes these; this recomputes them from the stored target /
    // function / args / idx. A hardcoded expectation would only prove the seed
    // agrees with itself.
    const run = await loadRun(RUN_3);
    for (const item of run.items) {
      const args = item.functionArgs as unknown[];
      const encodedArgs = encodeAbiParameters([{ type: 'string' }], [JSON.stringify(args)]);
      const expected = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
          [
            bytesToHex(item.targetAddr) as `0x${string}`,
            item.functionName,
            encodedArgs,
            BigInt(item.idx),
          ],
        ),
      );
      expect(bytesToHex(item.payloadHash)).toBe(expected);
    }
  });

  it('target addresses are 20 bytes and payload hashes 32', async () => {
    const run = await loadRun(RUN_12);
    for (const item of run.items) {
      expect(item.targetAddr.length).toBe(20);
      expect(item.payloadHash.length).toBe(32);
    }
  });
});
