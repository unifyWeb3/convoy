// What does KeeperHub's `gasUsedWei` actually carry?
//
// G-28 recorded "always gas UNITS", measured on two SPONSORED transactions. The
// sponsorship probe surfaced a counter-example: on an UNSPONSORED record the
// same field reads 275418000000 against a gasPriceWei of 6000000 — a ratio of
// ~45903, which is a plausible gasUsed, not a plausible fee.
//
// This checks the field against the chain receipt for one of each.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}

const RPC = process.env.BASE_RPC_URL;
const { KhClient, getExecutionStatus } = await import('@convoy/kh-client');
const khClient = new KhClient({
  apiKey: process.env.KEEPERHUB_API_KEY,
  baseUrl: process.env.KEEPERHUB_BASE_URL,
  chainId: '84532',
});
const rpc = async (method, params) =>
  (
    await (
      await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    ).json()
  ).result;

// executionId -> expectation, from the sponsorship probe.
const CASES = [
  ['e9vdaxkipq90kvt3jqgn7', 'UNSPONSORED (org wallet paid, DEC-006 nonce 1)'],
  ['tgn3aigyunpl3ric2pj14', 'UNSPONSORED (org wallet paid, nonce 2)'],
  ['pkxdn5g2cnpa2n5uu1rqk', 'SPONSORED (relay)'],
];

for (const [id, label] of CASES) {
  const body = await getExecutionStatus(khClient, id);
  const r = await rpc('eth_getTransactionReceipt', [body.transactionHash]);
  const gasUsed = BigInt(r.gasUsed);
  const price = BigInt(r.effectiveGasPrice);
  const l1 = r.l1Fee === undefined || r.l1Fee === null ? 0n : BigInt(r.l1Fee);
  const reported = BigInt(body.gasUsedWei);

  console.log(`\n=== ${label} — ${id} ===`);
  console.log(`  tx                       ${body.transactionHash}`);
  console.log(`  sponsored                ${body.sponsored}`);
  console.log(`  KH gasUsedWei            ${reported}`);
  console.log(`  KH gasPriceWei           ${body.gasPriceWei}`);
  console.log(`  receipt gasUsed (units)  ${gasUsed}`);
  console.log(`  receipt effectiveGasPrice ${price}`);
  console.log(`  receipt l1Fee            ${l1}`);
  console.log(`  gasUsed * price (L2 wei) ${gasUsed * price}`);
  console.log(`  L2 + L1 (total wei)      ${gasUsed * price + l1}`);
  console.log(
    `  VERDICT: gasUsedWei == units? ${reported === gasUsed}   == L2 wei? ${reported === gasUsed * price}   == total wei? ${reported === gasUsed * price + l1}`,
  );
}
