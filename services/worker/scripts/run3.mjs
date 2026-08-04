// CVY-008 acceptance: a 3-item batch RECEIVED -> SEALED_OK on 84532.
// Clones the seeded fixture into a fresh run so the fixture stays pristine and
// no events are ever deleted (the log is append-only).
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const { runBatch, khFromEnv } = await import('../dist/runBatch.js');
const { unsafeRawClient: prisma } = await import('@convoy/db');

const FIXTURE = '00000000-0000-4000-8000-000000000003';
const src = await prisma.run.findUniqueOrThrow({
  where: { id: FIXTURE },
  include: { items: { orderBy: { idx: 'asc' } } },
});
const fresh = await prisma.run.create({
  data: {
    status: 'RECEIVED',
    budgetUsdc: src.budgetUsdc,
    runEthUsd: src.runEthUsd,
    items: {
      create: src.items.map((i) => ({
        idx: i.idx,
        targetAddr: i.targetAddr,
        functionName: i.functionName,
        functionArgs: i.functionArgs,
        payloadHash: i.payloadHash,
        evidence: i.evidence,
        state: 'PENDING',
        dependsOn: i.dependsOn,
      })),
    },
  },
});
console.log(`cloned fixture -> run ${fresh.id}\n`);

const r = await runBatch(
  { kh: khFromEnv(), registryAddr: process.env.CONVOY_REGISTRY_ADDR, log: (m) => console.log(m) },
  fresh.id,
);

console.log('\n=== RESULT ===');
console.log('status :', r.status);
console.log('openTx :', r.openTx);
console.log('sealTx :', r.sealTx);
for (const e of r.executed)
  console.log(
    `  item ${e.idx}: landed=${e.landed} tx=${e.txHash ?? '-'} gasUnits=${e.gasUsedUnits ?? '-'} retries=${e.retries}`,
  );
for (const v of r.vetoed) console.log(`  item ${v.idx}: VETOED ${v.reason}`);
console.log('spentGasUsdc:', r.budget.spentGasUsdc.toFixed(9));

const evs = await prisma.event.findMany({ where: { runId: fresh.id }, orderBy: { id: 'asc' } });
console.log(`\n=== EVENTS (${evs.length}) ===`);
for (const e of evs) console.log(`  ${e.type}${e.itemIdx === null ? '' : ' idx=' + e.itemIdx}`);
const its = await prisma.item.findMany({ where: { runId: fresh.id }, orderBy: { idx: 'asc' } });
console.log('\n=== FINAL ITEM STATES ===');
for (const i of its)
  console.log(
    `  idx ${i.idx} ${i.functionName.padEnd(14)} ${i.state}${i.vetoReason ? ' (' + i.vetoReason + ')' : ''}`,
  );
console.log('\nRUN_ID=' + fresh.id);
await prisma.$disconnect();
