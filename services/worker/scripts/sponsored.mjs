// Does KeeperHub's `sponsored` flag report the PAYER, or only that a paymaster
// was attempted? The tie-breaker is DEC-006's one write that the org Turnkey
// wallet demonstrably paid for (balance moved 282,292,353,887 wei).
//
// Find that write by its receipt `from`, then read `sponsored` off its own
// KeeperHub execution record.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const { unsafeRawClient: prisma } = await import('@convoy/db');
const { KhClient, getExecutionStatus } = await import('@convoy/kh-client');

const ORG_WALLET = '0x65f5afd3'; // prefix match, case-insensitive
const RPC = process.env.BASE_RPC_URL;
const khClient = new KhClient({
  apiKey: process.env.KEEPERHUB_API_KEY,
  baseUrl: process.env.KEEPERHUB_BASE_URL,
  chainId: '84532',
});

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
}

const attempts = await prisma.attempt.findMany({
  where: { kind: 'EXECUTE', txHash: { not: null } },
  orderBy: { createdAt: 'desc' },
  take: 60,
});
console.log(`inspecting ${attempts.length} EXECUTE attempts with a hash\n`);

let orgPaid = [];
let relayPaid = 0;
for (const a of attempts) {
  const hash = '0x' + Buffer.from(a.txHash).toString('hex');
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  if (!tx) continue;
  if (tx.from.toLowerCase().startsWith(ORG_WALLET)) {
    orgPaid.push({
      hash,
      executionId: a.executionId,
      nonce: parseInt(tx.nonce, 16),
      from: tx.from,
    });
  } else {
    relayPaid += 1;
  }
}
console.log(`relay-sent: ${relayPaid}   org-wallet-sent: ${orgPaid.length}`);
console.log(JSON.stringify(orgPaid, null, 2));

for (const o of orgPaid) {
  if (!o.executionId) continue;
  const body = await getExecutionStatus(khClient, o.executionId);
  console.log(`\n=== ORG-WALLET-PAID execution ${o.executionId} ===`);
  console.log(
    JSON.stringify(
      {
        sponsored: body.sponsored,
        gasUsedUnits: body.gasUsedUnits,
        gasFeeWeiL2: body.gasFeeWeiL2,
        gasPriceWei: body.gasPriceWei,
        transactionHash: body.transactionHash,
        retryCount: body.retryCount,
      },
      null,
      2,
    ),
  );
}

// Control: one relay-sent write from the same batch.
const control = attempts.find((a) => {
  const h = '0x' + Buffer.from(a.txHash).toString('hex');
  return !orgPaid.some((o) => o.hash === h);
});
if (control?.executionId) {
  const body = await getExecutionStatus(khClient, control.executionId);
  console.log(`\n=== CONTROL relay-sent execution ${control.executionId} ===`);
  console.log(
    JSON.stringify(
      {
        sponsored: body.sponsored,
        transactionHash: body.transactionHash,
        retryCount: body.retryCount,
      },
      null,
      2,
    ),
  );
}

await prisma.$disconnect();
