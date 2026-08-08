// CVY-GATE2 evidence runner. The action set is selected from a read-only chain
// preflight: market 1 is enabled, while GATE2_MARKETS names unused actions.
import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import { keccak256, encodeAbiParameters } from 'viem';

for (const line of (await import('node:fs'))
  .readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  .split('\n')) {
  const value = line.trim();
  if (!value || value.startsWith('#') || !value.includes('=')) continue;
  const equals = value.indexOf('=');
  if (process.env[value.slice(0, equals)] === undefined)
    process.env[value.slice(0, equals)] = value.slice(equals + 1).trim();
}

const { runBatch, khFromEnv } = await import('../dist/runBatch.js');

const DISTRIBUTOR = process.env.MOCK_DISTRIBUTOR_ADDR;
const REGISTRY = process.env.CONVOY_REGISTRY_ADDR;
const markets = (
  process.env.GATE2_MARKETS ?? '23080701,23080702,23080703,23080704,23080705,23080706,23080707'
)
  .split(',')
  .map((market) => market.trim());

function hex(value) {
  return Buffer.from(value.replace(/^0x/, ''), 'hex');
}

function payloadHash(target, functionName, args, idx) {
  const encodedArgs = encodeAbiParameters([{ type: 'string' }], [JSON.stringify(args)]);
  return hex(
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
        [target, functionName, encodedArgs, BigInt(idx)],
      ),
    ),
  );
}

function item(idx, target, functionName, functionArgs, evidence, dependsOn = []) {
  return {
    idx,
    targetAddr: hex(target),
    functionName,
    functionArgs,
    payloadHash: payloadHash(target, functionName, functionArgs, idx),
    evidence,
    state: 'PENDING',
    dependsOn,
  };
}

const items = [
  item(
    0,
    DISTRIBUTOR,
    'fund',
    ['1000000'],
    'Fund the already-published epoch before opening markets.',
  ),
  item(
    1,
    DISTRIBUTOR,
    'enableMarket',
    [markets[0]],
    `Open unused market ${markets[0]} after item 0 lands.`,
    [0],
  ),
  item(
    2,
    DISTRIBUTOR,
    'enableMarket',
    [markets[1]],
    `Open unused market ${markets[1]} after item 1 lands.`,
    [1],
  ),
  item(
    3,
    DISTRIBUTOR,
    'enableMarket',
    [markets[2]],
    `Open unused market ${markets[2]} after item 0 lands.`,
    [0],
  ),
  item(4, DISTRIBUTOR, 'fund', ['2000000'], 'Record a second valid top-up.', []),
  item(
    5,
    DISTRIBUTOR,
    'enableMarket',
    [markets[3]],
    `Open unused market ${markets[3]} after item 4 lands.`,
    [4],
  ),
  item(
    6,
    DISTRIBUTOR,
    'enableMarket',
    [markets[4]],
    `Open unused market ${markets[4]} independently.`,
    [],
  ),
  item(
    7,
    DISTRIBUTOR,
    'enableMarket',
    ['1'],
    'Duplicate enabled market; the deployed contract must veto it.',
    [],
  ),
  item(
    8,
    DISTRIBUTOR,
    'setRoot',
    ['0x' + 'c3'.repeat(32)],
    'Second root; the deployed contract must veto it.',
    [],
  ),
  item(
    9,
    DISTRIBUTOR,
    'enableMarket',
    [markets[5]],
    `Open unused market ${markets[5]} after item 0 lands.`,
    [0],
  ),
  item(
    10,
    DISTRIBUTOR,
    'enableMarket',
    [markets[6]],
    `Open unused market ${markets[6]} after item 9 lands.`,
    [9],
  ),
  item(
    11,
    DISTRIBUTOR,
    'fund',
    ['3000000'],
    'Record a third valid top-up after item 4 lands.',
    [4],
  ),
];

const mode = process.argv[2] ?? 'prepare';
if (mode === 'prepare') {
  const run = await prisma.run.create({
    data: {
      status: 'RECEIVED',
      budgetUsdc: new Prisma.Decimal('120.000000'),
      runEthUsd: new Prisma.Decimal(process.env.CONVOY_ETH_USD ?? '3400'),
      items: { create: items },
      events: {
        create: { type: 'RUN_RECEIVED', payload: { itemCount: 12, budgetUsdc: '120.000000' } },
      },
    },
  });
  console.log(
    JSON.stringify({
      runId: run.id,
      itemCount: items.length,
      dependencies: items.filter((entry) => entry.dependsOn.length > 0).length,
    }),
  );
} else {
  const runId = process.argv[3];
  if (!runId) throw new Error('usage: gate2.mjs execute <runId>');
  const result = await runBatch(
    { kh: khFromEnv(), registryAddr: REGISTRY, log: (message) => console.log(message) },
    runId,
    { fanout: Number(process.env.GATE2_FANOUT ?? '4') },
  );
  const [run, finalItems, attempts, events] = await Promise.all([
    prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } }),
    prisma.attempt.findMany({
      where: { item: { runId } },
      include: { item: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.event.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
  ]);
  console.log(
    JSON.stringify(
      {
        result: {
          status: result.status,
          runIdOnchain: result.runIdOnchain,
          openTx: result.openTx,
          sealTx: result.sealTx,
          executed: result.executed.map((entry) => ({
            idx: entry.idx,
            landed: entry.landed,
            txHash: entry.txHash,
            transactionLink: entry.transactionLink,
            feeWeiTotal: entry.feeWeiTotal?.toString(),
            sponsored: entry.sponsored,
          })),
          vetoed: result.vetoed,
          budget: {
            budgetUsdc: result.budget.budgetUsdc.toString(),
            spentGasUsdc: result.budget.spentGasUsdc.toString(),
            spentPayUsdc: result.budget.spentPayUsdc.toString(),
          },
        },
        run: {
          status: run.status,
          spentGasUsdc: run.spentGasUsdc.toString(),
          spentPayUsdc: run.spentPayUsdc.toString(),
        },
        items: finalItems.map((entry) => ({
          idx: entry.idx,
          functionName: entry.functionName,
          functionArgs: entry.functionArgs,
          dependsOn: entry.dependsOn,
          state: entry.state,
        })),
        attempts: attempts.map((entry) => ({
          idx: entry.item.idx,
          kind: entry.kind,
          attemptNo: entry.attemptNo,
          executionId: entry.executionId,
          txHash: entry.txHash ? `0x${entry.txHash.toString('hex')}` : null,
          txLink: entry.txLink,
          gasUsedUsdc: entry.gasUsedUsdc?.toString(),
          wouldRevert: entry.wouldRevert,
          revertReason: entry.revertReason,
          khStatus: entry.khStatus,
        })),
        events: events.map((entry) => ({
          id: entry.id.toString(),
          itemIdx: entry.itemIdx,
          type: entry.type,
          payload: entry.payload,
        })),
      },
      null,
      2,
    ),
  );
}
await prisma.$disconnect();
