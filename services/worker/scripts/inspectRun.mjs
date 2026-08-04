// Dump one run's ledger rows — item states, EXECUTE attempts, and the
// ITEM_LANDED payloads that record where each fee figure came from.
//
// Written for CVY-010: the DEC-010 meter records provenance (`feeFromReceipt`,
// `l1FeeIncluded`) precisely so a degraded reading is visible, and that is only
// worth anything if someone actually looks.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const { unsafeRawClient: prisma } = await import('@convoy/db');

const RUN = process.argv[2];
if (!RUN) {
  console.error('usage: node inspectRun.mjs <runId>');
  process.exit(1);
}

const run = await prisma.run.findUniqueOrThrow({ where: { id: RUN } });
console.log('run status   :', run.status);
console.log('spentGasUsdc :', run.spentGasUsdc.toFixed(9));

const items = await prisma.item.findMany({ where: { runId: RUN }, orderBy: { idx: 'asc' } });
console.log('\n=== FINAL ITEM STATES ===');
for (const i of items) console.log(`  idx=${i.idx} ${i.functionName} -> ${i.state}`);

const at = await prisma.attempt.findMany({
  where: { item: { runId: RUN }, kind: 'EXECUTE' },
  include: { item: true },
  orderBy: { createdAt: 'asc' },
});
console.log('\n=== attempts (EXECUTE) ===');
for (const a of at) {
  console.log(
    `  idx=${a.item.idx} sponsored=${a.sponsored} ` +
      `gas_used_wei=${a.gasUsedWei?.toFixed(0) ?? 'null'} ` +
      `gas_used_usdc=${a.gasUsedUsdc?.toFixed(9) ?? 'null'} ` +
      `tx=0x${a.txHash?.toString('hex').slice(0, 12) ?? '-'}`,
  );
}

const evs = await prisma.event.findMany({
  where: { runId: RUN, type: 'ITEM_LANDED' },
  orderBy: { id: 'asc' },
});
console.log('\n=== ITEM_LANDED payloads (fee provenance) ===');
for (const e of evs) console.log(' ', JSON.stringify(e.payload));

await prisma.$disconnect();
