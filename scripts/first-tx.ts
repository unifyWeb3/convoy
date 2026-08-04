#!/usr/bin/env tsx
/**
 * CVY-003 — the first real Base transaction.
 *
 * Lands `openRun` on the deployed ConvoyRegistry through KeeperHub's org Turnkey
 * wallet. Convoy signs nothing and sets no nonce; every chain write goes through
 * @convoy/kh-client, the only module permitted to reach KeeperHub.
 *
 * Operational authority for this sequence is docs/RUNBOOK_FIRST_TRANSACTION.md.
 *
 *   pnpm tsx scripts/first-tx.ts --preflight     # simulate only, spends nothing
 *   pnpm tsx scripts/first-tx.ts                 # simulate + write + status poll
 *   pnpm tsx scripts/first-tx.ts --revert-case   # D-019 / G-20 evidence
 *
 * Never fabricates a hash. If nothing landed, it says so and exits non-zero.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { toFunctionSelector } from 'viem';

import {
  KhClient,
  getExecutionStatus,
  pollUntilTerminal,
  simulateContractCall,
  writeContractCall,
} from '@convoy/kh-client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(): void {
  for (const raw of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(eq + 1).trim();
  }
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === '' || /replace_me/.test(v) || /^0x0{40}$/.test(v)) {
    console.error(`\nFAIL — ${name} is not set (or is still a placeholder).`);
    console.error('See docs/RUNBOOK_FIRST_TRANSACTION.md §1.3.\n');
    process.exit(1);
  }
  return v;
}

const REGISTRY_ABI = [
  {
    name: 'openRun',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [],
  },
];

const DISTRIBUTOR_ABI = [
  {
    name: 'fund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
];

function saveTape(name: string, payload: unknown): string {
  const dir = resolve(ROOT, 'packages/kh-client/test/vcr');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

async function revertCase(client: KhClient): Promise<void> {
  const distributor = required('MOCK_DISTRIBUTOR_ADDR');
  console.log('\nD-019 — fund() before setRoot() on the deployed MockRewardDistributor');
  console.log(`  contract: ${distributor}\n`);

  const params = {
    contractAddress: distributor,
    functionName: 'fund',
    functionArgs: ['1000000'],
    abi: DISTRIBUTOR_ABI,
  };

  const sim = await simulateContractCall(client, params);

  console.log(`  HTTP status  : ${sim.httpStatus}`);
  console.log(`  wouldRevert  : ${String(sim.wouldRevert)}`);
  console.log(`  revertReason : ${sim.revertReason ?? '(none)'}`);
  console.log(`  revertSelector: ${sim.revertSelector ?? '(none)'}`);

  // G-20: does the API decode a CUSTOM error, or hand back a diagnostic blob?
  // The selector is DERIVED from the error signature, never hardcoded — a
  // hand-written constant is just a guess that happens to be checked in.
  const reason = (sim.revertReason ?? '').toLowerCase();
  const SELECTOR = toFunctionSelector('RootNotSet()');
  const branch = /rootnotset/.test(reason) ? 'a' : sim.revertSelector === SELECTOR ? 'c' : 'b';
  const verdicts = {
    a: 'names RootNotSet() — the API DOES decode custom errors',
    b: 'neither name nor selector — the API does NOT decode custom errors; CVY-011 needs a client-side decode',
    c: 'carries the selector but not the name — CVY-011 maps selector -> name from the ABI',
  } as const;

  console.log(`\nG-20 branch  : ${branch}`);
  console.log(`  ${verdicts[branch]}\n`);

  const tape = saveTape('d019.fundBeforeSetRoot.revert.json', {
    recordedAt: new Date().toISOString(),
    note: 'D-019 closure evidence: fund() before setRoot() on the deployed MockRewardDistributor.',
    chainId: '84532',
    request: { ...params, simulate: true, _authorization: 'Bearer <REDACTED_KH_KEY>' },
    httpStatus: sim.httpStatus,
    wouldRevert: sim.wouldRevert,
    revertReason: sim.revertReason ?? null,
    revertSelector: sim.revertSelector ?? null,
    decodesTo: sim.revertSelector === SELECTOR ? 'RootNotSet()' : null,
    g20Branch: branch,
    g20Verdict: verdicts[branch],
    g20RootNotSetSelector: SELECTOR,
    responseBody: sim.raw,
  });
  console.log(`  tape: ${tape}\n`);

  if (!sim.wouldRevert) {
    console.error('FAIL — expected wouldRevert:true. The precondition chain did not reject.\n');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const preflight = process.argv.includes('--preflight');

  const client = new KhClient({
    apiKey: required('KEEPERHUB_API_KEY'),
    baseUrl: process.env['KEEPERHUB_BASE_URL'],
    chainId: '84532',
  });

  if (process.argv.includes('--revert-case')) {
    await revertCase(client);
    return;
  }

  // Pre-flight runs BEFORE the deploy, so it cannot target our own registry.
  // It probes the WETH9 predeploy instead: the question it answers is "is the
  // org Turnkey wallet provisioned for 84532", which is independent of anything
  // Convoy deploys, and a 422 here means no amount of deploying will help.
  if (preflight) {
    const WETH9 = '0x4200000000000000000000000000000000000006';
    console.log('\nPRE-FLIGHT — proving the KeeperHub path on 84532 before spending gas.');
    console.log(`  probe target: WETH9 predeploy ${WETH9}\n`);
    const probe = await simulateContractCall(client, {
      contractAddress: WETH9,
      functionName: 'deposit',
      functionArgs: [],
      abi: [
        { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
      ],
      value: '0',
    });
    console.log(`  HTTP ${probe.httpStatus} · wouldRevert=${String(probe.wouldRevert)}`);
    console.log(`  gasEstimate=${probe.gasEstimate ?? '—'} · sender=${probe.from ?? '—'}`);
    if (probe.wouldRevert) {
      console.error(`\nFAIL — probe would revert: ${probe.revertReason ?? '(no reason)'}\n`);
      process.exit(1);
    }
    console.log('\nPRE-FLIGHT OK — wallet provisioned for 84532. Nothing was sent.\n');
    return;
  }

  const registry = required('CONVOY_REGISTRY_ADDR');
  const runId = `0x${randomBytes(32).toString('hex')}`;
  const params = {
    contractAddress: registry,
    functionName: 'openRun',
    functionArgs: [runId],
    abi: REGISTRY_ABI,
  };

  console.log(`\nConvoyRegistry : ${registry}`);
  console.log(`runId          : ${runId}\n`);

  console.log('1. simulate (zero gas, signs nothing)…');
  const sim = await simulateContractCall(client, params);
  console.log(
    `   HTTP ${sim.httpStatus} · wouldRevert=${String(sim.wouldRevert)} · gasEstimate=${sim.gasEstimate ?? '—'}`,
  );
  if (sim.wouldRevert) {
    console.error(`\nFAIL — openRun would revert: ${sim.revertReason ?? '(no reason)'}\n`);
    process.exit(1);
  }

  console.log('\n2. write (org Turnkey wallet; Convoy sets no nonce)…');
  const write = await writeContractCall(client, params, {
    runId: runId.slice(2, 18),
    idx: 0,
    attempt: 0,
  });
  console.log(
    `   HTTP ${write.httpStatus} · executionId=${write.executionId} · status=${write.status}`,
  );

  console.log('\n3. status poll (the hash is only here — gap G-23)…');
  const final = await pollUntilTerminal(client, write, { maxPolls: 30, defaultIntervalMs: 2000 });
  const detail = await getExecutionStatus(client, write.executionId);
  const raw = detail.raw as Record<string, unknown>;

  console.log(`   status       : ${final.status}`);
  console.log(`   txHash       : ${final.transactionHash ?? '(none)'}`);
  console.log(`   txLink       : ${final.transactionLink ?? '(none)'}`);
  console.log(`   gasUsedWei   : ${final.gasUsedWei ?? '(none)'}`);
  console.log(`   retryCount   : ${String(raw['retryCount'] ?? '(none)')}`);
  console.log(`   sponsored    : ${String(raw['sponsored'] ?? '(none)')}`);

  saveTape('cvy-003.openRun.firstTx.json', {
    recordedAt: new Date().toISOString(),
    note: 'CVY-003 first real Base transaction: openRun via the KeeperHub org Turnkey wallet.',
    chainId: '84532',
    runId,
    request: { ...params, _authorization: 'Bearer <REDACTED_KH_KEY>' },
    write: { httpStatus: write.httpStatus, executionId: write.executionId, status: write.status },
    status: detail.raw,
  });

  // The architecture's SUBMITTED -> LANDED guard: `completed` AND a real hash.
  if (final.status !== 'completed' || final.transactionHash === undefined) {
    console.error('\nFAIL — no transaction hash. Nothing landed; nothing is claimed.\n');
    process.exit(1);
  }

  console.log('\nLANDED. Record this in docs/RUNBOOK_FIRST_TRANSACTION.md Part 2.\n');
}

main().catch((e: unknown) => {
  console.error('\n', e);
  process.exit(1);
});
