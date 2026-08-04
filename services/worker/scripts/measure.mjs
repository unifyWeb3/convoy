// MEASUREMENT 1 (nonce serialization) + MEASUREMENT 2 (EXECUTE_FANOUT).
// 12 independent enableMarket items — no dependencies, so EXECUTE dispatches
// them all concurrently and KeeperHub's nonce manager is what orders them.
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

const FANOUT = Number(process.argv[2] ?? '4');
const N = Number(process.argv[3] ?? '12');
const BASE_MARKET = Number(process.argv[4] ?? '100');
const D = process.env.MOCK_DISTRIBUTOR_ADDR;

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

const items = Array.from({ length: N }, (_, k) => {
  const args = [String(BASE_MARKET + k)];
  return {
    idx: k,
    targetAddr: Buffer.from(D.slice(2), 'hex'),
    functionName: 'enableMarket',
    functionArgs: args,
    payloadHash: ph(D, 'enableMarket', args, k),
    evidence: `independent market ${BASE_MARKET + k}`,
    state: 'PENDING',
    dependsOn: [],
  };
});
const run = await prisma.run.create({
  data: {
    status: 'RECEIVED',
    budgetUsdc: '500.000000',
    runEthUsd: '3400.000000',
    items: { create: items },
  },
});
console.log(`run ${run.id} — ${N} independent items, fanout=${FANOUT}\n`);

const t0 = Date.now();
const r = await runBatch(
  { kh: khFromEnv(), registryAddr: process.env.CONVOY_REGISTRY_ADDR, log: () => {} },
  run.id,
  { fanout: FANOUT },
);
const elapsed = Date.now() - t0;
console.log(
  `status=${r.status} landed=${r.executed.filter((e) => e.landed).length}/${N} elapsed=${(elapsed / 1000).toFixed(1)}s`,
);
console.log(
  `HASHES ${r.executed
    .filter((e) => e.landed)
    .map((e) => e.txHash)
    .join(',')}`,
);
console.log(`ELAPSED_MS ${elapsed}`);
await prisma.$disconnect();
