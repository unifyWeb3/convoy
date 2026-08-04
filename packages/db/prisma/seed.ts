// Seed fixtures: the 3-item batch used by CVY-008 and the 12-item batch used by
// GATE 2. Both model Maya's epoch release — publish root, fund the distributor,
// enable markets — against the contracts deployed at CVY-003.
//
// Idempotent: re-running replaces the two fixture runs and leaves anything else
// alone. Deleting a run cascades to its items, attempts and events.
//
// NOTE: the fixtures describe *intent*. They carry no transaction hashes and no
// attempts, because nothing has been executed — a seeded hash would be a
// fabricated one.

import { PrismaClient, Prisma } from '@prisma/client';
import { keccak256, encodeAbiParameters } from 'viem';

const prisma = new PrismaClient();

/** Deterministic ids so re-seeding is idempotent and tests can address them. */
const RUN_3 = '00000000-0000-4000-8000-000000000003';
const RUN_12 = '00000000-0000-4000-8000-000000000012';

/** Deployed at CVY-003 on Base Sepolia 84532. */
const REGISTRY = '0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA';
const DISTRIBUTOR = '0xD45c61797d7283caf8A31D91A5Bd6465A45AD561';

const hex = (s: string): Buffer => Buffer.from(s.replace(/^0x/, ''), 'hex');

/**
 * The same commitment the registry stores, computed the same way as CVY-002's
 * `payloadHash` — keccak256(abi.encode(target, fn, args, idx)). Computed rather
 * than hardcoded so the fixture cannot drift from the real encoding.
 */
function payloadHash(target: string, fn: string, args: readonly unknown[], idx: number): Buffer {
  const encodedArgs = encodeAbiParameters([{ type: 'string' }], [JSON.stringify(args)]);
  return hex(
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
        [target as `0x${string}`, fn, encodedArgs, BigInt(idx)],
      ),
    ),
  );
}

interface SeedItem {
  readonly target: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly evidence: string;
  readonly dependsOn?: readonly number[];
}

/** CVY-008's 3-item batch: the minimal chain with a real ordering constraint. */
const ITEMS_3: readonly SeedItem[] = [
  {
    target: DISTRIBUTOR,
    fn: 'setRoot',
    args: ['0x' + 'a1'.repeat(32)],
    evidence: 'Epoch 42 Merkle root, from the rewards CSV signed off by the incentives lead.',
  },
  {
    target: DISTRIBUTOR,
    fn: 'fund',
    args: ['250000000'],
    evidence:
      'Fund 250 USDC against the epoch-42 root. MUST land after the root is published — funding ' +
      'an unset root reverts RootNotSet().',
    dependsOn: [0],
  },
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['1'],
    evidence: 'Open market 1 for claiming once the distribution is funded.',
    dependsOn: [1],
  },
];

/** GATE 2's 12-item batch: the full epoch release from the demo script. */
const ITEMS_12: readonly SeedItem[] = [
  ...ITEMS_3,
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['2'],
    evidence: 'Open market 2. Same funding precondition as market 1.',
    dependsOn: [1],
  },
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['3'],
    evidence: 'Open market 3.',
    dependsOn: [1],
  },
  {
    target: REGISTRY,
    fn: 'commitAction',
    args: ['0x' + '00'.repeat(32), '5', '0x' + 'b2'.repeat(32)],
    evidence: 'Record the epoch checkpoint against the run.',
  },
  {
    target: DISTRIBUTOR,
    fn: 'fund',
    args: ['75000000'],
    evidence: 'Top-up funding for the late-claim window.',
    dependsOn: [0],
  },
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['4'],
    evidence: 'Open market 4 after the top-up.',
    dependsOn: [6],
  },
  {
    // Deliberately invalid: enabling a market that is already enabled reverts
    // MarketAlreadyEnabled(). A GENUINE revert, not a staged one — this is what
    // the Critic vetoes at zero gas.
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['1'],
    evidence:
      'Duplicate of item 2 — left in the batch on purpose. The Critic should veto this before it ' +
      'costs gas; the contract genuinely reverts MarketAlreadyEnabled().',
    dependsOn: [1],
  },
  {
    // Deliberately invalid: setRoot twice reverts RootAlreadySet().
    target: DISTRIBUTOR,
    fn: 'setRoot',
    args: ['0x' + 'c3'.repeat(32)],
    evidence:
      'A second root, mistakenly included from the previous epoch sheet. Genuinely reverts ' +
      'RootAlreadySet() — a real precondition failure, not a simulated one.',
  },
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['5'],
    evidence: 'Open market 5.',
    dependsOn: [1],
  },
  {
    target: DISTRIBUTOR,
    fn: 'enableMarket',
    args: ['6'],
    evidence: 'Open market 6, closing the epoch.',
    dependsOn: [1],
  },
];

async function seedRun(id: string, items: readonly SeedItem[], budgetUsdc: string): Promise<void> {
  // Cascades to items, attempts and events.
  await prisma.run.deleteMany({ where: { id } });

  await prisma.run.create({
    data: {
      id,
      status: 'RECEIVED',
      budgetUsdc: new Prisma.Decimal(budgetUsdc),
      runEthUsd: new Prisma.Decimal(process.env['CONVOY_ETH_USD'] ?? '3400'),
      items: {
        create: items.map((it, idx) => ({
          idx,
          targetAddr: hex(it.target),
          functionName: it.fn,
          functionArgs: it.args as Prisma.InputJsonValue,
          payloadHash: payloadHash(it.target, it.fn, it.args, idx),
          evidence: it.evidence,
          state: 'PENDING',
          dependsOn: [...(it.dependsOn ?? [])],
        })),
      },
      events: {
        create: [
          {
            type: 'RUN_RECEIVED',
            payload: { itemCount: items.length, budgetUsdc } as Prisma.InputJsonValue,
          },
        ],
      },
    },
  });

  console.log(`  seeded run ${id} — ${items.length} items, budget ${budgetUsdc} USDC`);
}

async function main(): Promise<void> {
  console.log('Seeding Convoy ledger fixtures…');
  await seedRun(RUN_3, ITEMS_3, '25.000000');
  await seedRun(RUN_12, ITEMS_12, '120.000000');

  const runs = await prisma.run.count();
  const items = await prisma.item.count();
  const events = await prisma.event.count();
  console.log(`Done. runs=${runs} items=${items} events=${events}`);
  console.log('No attempts and no transaction hashes: nothing has been executed.');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
