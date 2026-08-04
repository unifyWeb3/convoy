// CVY-008 acceptance: a genuinely invalid item (fund before setRoot) is VETOED
// at zero gas, through the orchestrator. Uses a FRESH distributor whose root is
// unset — the deployed one has had setRoot called, so RootNotSet() is no longer
// reachable there.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const { runBatch, khFromEnv } = await import('../dist/runBatch.js');
const { unsafeRawClient: prisma } = await import('@convoy/db');
const { keccak256, encodeAbiParameters } = await import('viem');

const D = process.argv[2];
const ph = (t, f, a, i) =>
  Buffer.from(
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'string' }, { type: 'bytes' }, { type: 'uint256' }],
        [t, f, encodeAbiParameters([{ type: 'string' }], [JSON.stringify(a)]), BigInt(i)],
      ),
    ).slice(2),
    'hex',
  );

const mk = (idx, fn, args, ev) => ({
  idx,
  targetAddr: Buffer.from(D.slice(2), 'hex'),
  functionName: fn,
  functionArgs: args,
  payloadHash: ph(D, fn, args, idx),
  evidence: ev,
  state: 'PENDING',
  dependsOn: [],
});

const run = await prisma.run.create({
  data: {
    status: 'RECEIVED',
    budgetUsdc: '50.000000',
    runEthUsd: '3400.000000',
    items: {
      create: [
        mk(
          0,
          'fund',
          ['1000000'],
          'INVALID: fund before setRoot. The contract genuinely reverts RootNotSet().',
        ),
        mk(1, 'setRoot', ['0x' + 'a1'.repeat(32)], 'VALID: publish the epoch root.'),
      ],
    },
  },
});

const r = await runBatch(
  { kh: khFromEnv(), registryAddr: process.env.CONVOY_REGISTRY_ADDR, log: (m) => console.log(m) },
  run.id,
);
console.log('\n=== RESULT ===');
console.log('status:', r.status);
for (const v of r.vetoed) console.log(`  VETOED idx=${v.idx} — ${v.reason}`);
for (const e of r.executed)
  console.log(`  item ${e.idx}: landed=${e.landed} tx=${e.txHash ?? '-'}`);

const its = await prisma.item.findMany({ where: { runId: run.id }, orderBy: { idx: 'asc' } });
for (const i of its)
  console.log(
    `  idx ${i.idx} ${i.functionName.padEnd(10)} ${i.state}${i.vetoReason ? ' (' + i.vetoReason + ')' : ''}`,
  );
const att = await prisma.attempt.findMany({
  where: { item: { runId: run.id } },
  orderBy: { id: 'asc' },
});
console.log('\n=== ATTEMPTS (gas actually spent by the vetoed item) ===');
for (const a of att)
  console.log(
    `  ${a.kind.padEnd(8)} wouldRevert=${a.wouldRevert} revert=${a.revertReason ?? '-'} txHash=${a.txHash ? 'yes' : 'NONE'} gas=${a.gasUsedWei ?? '0'}`,
  );
const ev = await prisma.event.findMany({ where: { runId: run.id }, orderBy: { id: 'asc' } });
console.log('\n=== EVENTS ===');
for (const e of ev)
  console.log(
    `  ${e.type}${e.itemIdx === null ? '' : ' idx=' + e.itemIdx}${e.type === 'ITEM_VETOED' ? ' -> ' + JSON.stringify(e.payload) : ''}`,
  );
await prisma.$disconnect();
