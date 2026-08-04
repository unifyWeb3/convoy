// CVY-010 acceptance: a run PLANNED BY THE LLM and then executed on 84532.
//
// This is the end-to-end path the eval cannot demonstrate. The eval measures the
// Planner's output against labels; this proves the output actually drives a real
// execution — the Planner writes `runs.plan`, the worker consumes it (D-030),
// and the batch lands onchain.
//
// It is also the FIRST LIVE EXERCISE of the DEC-010 meter. That rewrite shipped
// on unit tests alone: `composeFee`, `readReceiptGas`, `l1FeeIncluded`, the real
// wei in `gas_used_wei`, `gas_used_usdc` populated for the first time, and
// `sponsored` recorded per attempt have never run against the API. The attempt
// rows are dumped at the end for exactly that reason.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}

const { runBatch, khFromEnv } = await import('../dist/runBatch.js');
const { unsafeRawClient: prisma, bytesToHex } = await import('@convoy/db');
const { createLlmCaller, llmConfigFromEnv, planRun } =
  await import('../../../apps/web/lib/planner/index.ts');

const FIXTURE = '00000000-0000-4000-8000-000000000003';
const src = await prisma.run.findUniqueOrThrow({
  where: { id: FIXTURE },
  include: { items: { orderBy: { idx: 'asc' } } },
});

// Symbolic target names — the Planner never sees an address (schema.ts).
// Optional override: a FRESH distributor, so `setRoot` is actually reachable.
// The long-lived one has had its root set by earlier runs, and re-setting it
// reverts `RootAlreadySet()` — a real precondition, correctly vetoed at zero
// gas, but it means nothing executes and the meter is never exercised.
const DISTRIBUTOR = process.argv[2] ?? process.env.MOCK_DISTRIBUTOR_ADDR;
const TARGET_NAME = {
  [DISTRIBUTOR.toLowerCase()]: 'RewardDistributor',
  [process.env.CONVOY_REGISTRY_ADDR?.toLowerCase()]: 'ConvoyRegistry',
};
const nameFor = (addr) => TARGET_NAME[bytesToHex(addr).toLowerCase()] ?? 'UnknownContract';
const retarget = () => Buffer.from(DISTRIBUTOR.slice(2), 'hex');

const fresh = await prisma.run.create({
  data: {
    status: 'RECEIVED',
    budgetUsdc: src.budgetUsdc,
    runEthUsd: src.runEthUsd,
    items: {
      create: src.items.map((i) => ({
        idx: i.idx,
        targetAddr: retarget(),
        functionName: i.functionName,
        functionArgs: i.functionArgs,
        payloadHash: i.payloadHash,
        evidence: i.evidence,
        state: 'PENDING',
        // Deliberately EMPTY. The fixture declares the edges; here the Planner
        // must extract them from the evidence prose alone, or the run executes
        // in the wrong order and the distributor reverts on its own terms.
        dependsOn: [],
      })),
    },
  },
});
console.log(`run ${fresh.id} — declared edges deliberately stripped\n`);

// --- PLAN ------------------------------------------------------------------
const config = llmConfigFromEnv();
console.log(`Planner: ${config.model} via ${config.baseUrl}`);
const plannerInput = {
  budgetUsdc: String(src.budgetUsdc),
  items: src.items.map((i) => ({
    idx: i.idx,
    target: nameFor(retarget()),
    functionName: i.functionName,
    functionArgs: i.functionArgs,
    evidence: i.evidence,
  })),
};
// Two provider-side conditions are retried here, and NEITHER is a Planner
// result: an upstream 429 (the free-tier model sits behind a shared pool) and a
// transport failure (this environment's DNS/connect to the provider is flaky).
// Letting either degrade the run to the deterministic fallback would misreport
// the acceptance as "the Planner could not plan".
//
// A response that ARRIVED and was malformed is not retried here — that goes to
// the one repair pass inside `planRun`, which is the thing being measured.
const base = createLlmCaller(config);
const withBackoff = async (req) => {
  let last;
  for (let i = 0; i < 6; i += 1) {
    try {
      return await base(req);
    } catch (e) {
      last = e;
      const msg = String(e.message);
      const retryable = msg.includes('429') || msg.includes('fetch failed');
      if (!retryable) throw e;
      const wait = 10000 * (i + 1);
      console.log(`  provider unavailable (${msg.slice(0, 60)}) — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
};

const { plan, firstPassValid } = await planRun(plannerInput, withBackoff, {
  whitelist: ['RewardDistributor', 'ConvoyRegistry'],
});
console.log(`  source=${plan.source} firstPassValid=${firstPassValid} attempts=${plan.attempts}`);
console.log(`  order      ${JSON.stringify(plan.order)}`);
console.log(`  deferrals  ${JSON.stringify(plan.deferrals)}`);
for (const r of plan.rationalePerItem) console.log(`  idx ${r.idx}: ${r.rationale}`);
if (plan.warnings.length > 0) console.log(`  warnings   ${JSON.stringify(plan.warnings)}`);

if (plan.source !== 'planner') {
  console.error('\nPlanner did not produce the plan — refusing to claim an LLM-planned run.');
  process.exit(1);
}

await prisma.run.update({ where: { id: fresh.id }, data: { plan } });
console.log('\nwrote runs.plan — the worker now consumes it (D-030)\n');

// --- EXECUTE ---------------------------------------------------------------
const r = await runBatch(
  { kh: khFromEnv(), registryAddr: process.env.CONVOY_REGISTRY_ADDR, log: (m) => console.log(m) },
  fresh.id,
);

console.log('\n=== RESULT ===');
console.log('status :', r.status);
console.log('openTx :', r.openTx);
console.log('sealTx :', r.sealTx);
for (const e of r.executed) {
  console.log(
    `  item ${e.idx}: landed=${e.landed} tx=${e.txHash ?? '-'} ` +
      `feeWei=${e.feeWeiTotal ?? '-'} fromReceipt=${e.feeFromReceipt} ` +
      `l1Included=${e.l1FeeIncluded} sponsored=${e.sponsored}`,
  );
}
for (const v of r.vetoed) console.log(`  item ${v.idx}: VETOED ${v.reason}`);

console.log('\n=== DEC-010 METER, LIVE ===');
console.log('gas CONSUMED (usdc):', r.budget.spentGasUsdc.toFixed(9));
console.log('wallet DEBITED (usdc):', r.walletDebitedUsdc.toFixed(9));
console.log('unknown payer count :', r.unknownPayerCount);

const attempts = await prisma.attempt.findMany({
  where: { item: { runId: fresh.id }, kind: 'EXECUTE' },
  include: { item: true },
  orderBy: { createdAt: 'asc' },
});
console.log('\n=== attempts rows (EXECUTE) ===');
for (const a of attempts) {
  console.log(
    `  idx=${a.item.idx} sponsored=${a.sponsored} ` +
      `gas_used_wei=${a.gasUsedWei?.toFixed(0) ?? 'null'} ` +
      `gas_used_usdc=${a.gasUsedUsdc?.toFixed(9) ?? 'null'}`,
  );
}

const its = await prisma.item.findMany({ where: { runId: fresh.id }, orderBy: { idx: 'asc' } });
console.log('\n=== FINAL ITEM STATES ===');
for (const i of its) console.log(`  idx=${i.idx} ${i.functionName} -> ${i.state}`);

await prisma.$disconnect();
