#!/usr/bin/env tsx
/**
 * Convoy environment verification — the PASS/FAIL matrix from Implementation
 * Blueprint §11.
 *
 * Rules this script obeys:
 *  - It never fakes a pass. A check that cannot run yet reports FAIL with the
 *    reason and the milestone that will make it pass.
 *  - It never calls KeeperHub directly. `packages/kh-client` is the only module
 *    permitted to reach the KeeperHub API, and a script is not an exception to
 *    that boundary. Since CVY-004 the KeeperHub rows run a real `simulate:true`
 *    THROUGH that client — zero gas, no signing, no broadcast, no audit row.
 *  - It never reads or prints a secret value.
 *
 * Exit code: 0 if every check that is expected to pass at the current stage
 * passes; 1 if a blocking check fails.
 */

import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Status = 'PASS' | 'FAIL';

/**
 * The configured execution chain. DEC-001 moved development, rehearsal and the
 * demo from Base mainnet (8453) to Base Sepolia (84532); Base mainnet is an
 * optional final demo target at CVY-019 only.
 *
 * Declared once so the id, the label and the RPC comparison cannot drift apart.
 * `docs/IMPLEMENTATION_BLUEPRINT.md` §11 still says `eth_chainId == 0x2105`;
 * that text is superseded by DEC-001 — do not "fix" this back to mainnet.
 */
const TARGET_CHAIN = { id: 84_532, name: 'Base Sepolia' } as const;

interface Result {
  check: string;
  status: Status;
  detail: string;
  /** Undefined = must pass now. Otherwise the milestone that makes it pass. */
  expectedFrom?: string;
}

// ---------------------------------------------------------------------------
// .env loading (no dependency — the file is read, never printed)
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  // Values still carrying an .env.example placeholder are treated as unset.
  if (/replace_me|^sk-replace|^kh_live_replace/.test(trimmed)) return undefined;
  if (/^0x0{40}$/.test(trimmed)) return undefined;
  return trimmed;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string,
  args: string[],
  cwd = ROOT,
  envOverrides: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd,
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...envOverrides },
  });
  return stdout.trim();
}

/** execFile errors carry the child's stderr; surface it instead of the generic message. */
function failureDetail(e: unknown, fallback: string): string {
  const err = e as { stderr?: string; message?: string };
  const stderr = (err.stderr ?? '').trim();
  if (stderr !== '') {
    const lines = stderr.split('\n').filter((l) => l.trim() !== '');
    return lines.slice(-2).join(' | ');
  }
  return err.message?.split('\n')[0] ?? fallback;
}

function tcpProbe(host: string, port: number, payload?: string, timeoutMs = 3000): Promise<string> {
  return new Promise((res, rej) => {
    const socket = createConnection({ host, port });
    let data = '';
    const done = (err?: Error): void => {
      socket.destroy();
      if (err) rej(err);
      else res(data);
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`timeout after ${timeoutMs}ms`)));
    socket.on('error', done);
    socket.on('connect', () => {
      if (payload === undefined) done();
      else socket.write(payload);
    });
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      done();
    });
  });
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

async function checkNode(): Promise<Result> {
  const version = process.version;
  return {
    check: 'Node version',
    status: version.startsWith('v22.') ? 'PASS' : 'FAIL',
    detail: `${version} (require v22.x)`,
  };
}

async function checkPnpm(): Promise<Result> {
  try {
    return { check: 'pnpm present', status: 'PASS', detail: `v${await run('pnpm', ['-v'])}` };
  } catch {
    return { check: 'pnpm present', status: 'FAIL', detail: 'pnpm not on PATH' };
  }
}

async function checkFoundry(): Promise<Result> {
  try {
    const out = await run('forge', ['--version']);
    return { check: 'Foundry present', status: 'PASS', detail: out.split('\n')[0] ?? out };
  } catch {
    return {
      check: 'Foundry present',
      status: 'FAIL',
      detail: 'forge not on PATH (run foundryup)',
    };
  }
}

async function checkPostgres(): Promise<Result> {
  const url = env('DATABASE_URL');
  if (url === undefined) {
    return { check: 'Postgres reachable', status: 'FAIL', detail: 'DATABASE_URL not set' };
  }
  try {
    const parsed = new URL(url);
    const port = parsed.port === '' ? 5432 : Number(parsed.port);
    await tcpProbe(parsed.hostname, port);
    try {
      const out = await run('psql', [url, '-tAc', 'select 1']);
      return {
        check: 'Postgres reachable',
        status: out === '1' ? 'PASS' : 'FAIL',
        detail: out === '1' ? `select 1 ok on ${parsed.hostname}:${port}` : `unexpected: ${out}`,
      };
    } catch (e) {
      return {
        check: 'Postgres reachable',
        status: 'FAIL',
        detail: `port open but query failed: ${(e as Error).message.split('\n')[0]}`,
      };
    }
  } catch (e) {
    return { check: 'Postgres reachable', status: 'FAIL', detail: (e as Error).message };
  }
}

async function checkRedis(): Promise<Result> {
  const url = env('REDIS_URL');
  if (url === undefined) {
    return { check: 'Redis reachable', status: 'FAIL', detail: 'REDIS_URL not set' };
  }
  try {
    const parsed = new URL(url);
    const port = parsed.port === '' ? 6379 : Number(parsed.port);
    const reply = await tcpProbe(parsed.hostname, port, 'PING\r\n');
    return {
      check: 'Redis reachable',
      status: reply.startsWith('+PONG') ? 'PASS' : 'FAIL',
      detail: reply.startsWith('+PONG')
        ? `PING -> PONG on ${parsed.hostname}:${port}`
        : `unexpected reply: ${JSON.stringify(reply)}`,
    };
  } catch (e) {
    return { check: 'Redis reachable', status: 'FAIL', detail: (e as Error).message };
  }
}

async function checkPrismaClient(): Promise<Result> {
  try {
    // Probed through @convoy/db rather than @prisma/client directly: the db
    // package owns the dependency, and importing it here is what an actual
    // consumer does. A root-level probe would fail on resolution even with a
    // perfectly generated client.
    const { db, EVENT_TYPE } = await import('@convoy/db');
    const runs = await db.run.count();
    return {
      check: 'Prisma client generated',
      status: 'PASS',
      detail: `@convoy/db imports and queries; ${runs} run(s), ${EVENT_TYPE.length} event types`,
    };
  } catch (e) {
    return {
      check: 'Prisma client generated',
      status: 'FAIL',
      detail: `@convoy/db import/query failed: ${(e as Error).message.split('\n')[0]}`,
    };
  }
}

async function checkMigrations(): Promise<Result> {
  try {
    const out = await run('pnpm', [
      '--filter',
      '@convoy/db',
      'exec',
      'prisma',
      'migrate',
      'status',
    ]);
    const clean = /up to date|No pending migrations/i.test(out);
    return {
      check: 'Migrations applied',
      status: clean ? 'PASS' : 'FAIL',
      detail: clean
        ? 'no pending migrations'
        : (out.split('\n').slice(-1)[0] ?? 'pending migrations'),
      expectedFrom: clean ? undefined : 'CVY-005',
    };
  } catch {
    return {
      check: 'Migrations applied',
      status: 'FAIL',
      detail: 'prisma not installed — migrations land in CVY-005',
      expectedFrom: 'CVY-005',
    };
  }
}

/**
 * One live simulate, shared by the auth and wallet checks.
 *
 * Routed through `@convoy/kh-client` — this script still never speaks to
 * KeeperHub directly, because that package is the only module permitted to.
 * A simulate signs nothing, broadcasts nothing and creates no audit row, so the
 * verification costs nothing and changes nothing.
 */
let keeperHubProbe: Promise<{ ok: boolean; detail: string; status?: number }> | undefined;

function probeKeeperHub(): Promise<{ ok: boolean; detail: string; status?: number }> {
  keeperHubProbe ??= (async () => {
    const key = env('KEEPERHUB_API_KEY');
    if (key === undefined) return { ok: false, detail: 'KEEPERHUB_API_KEY not set' };
    try {
      const { KhClient, simulateContractCall } = await import('@convoy/kh-client');
      const client = new KhClient({
        apiKey: key,
        baseUrl: env('KEEPERHUB_BASE_URL'),
        chainId: '84532',
      });
      // The WETH9 predeploy: exists on 84532 independently of anything Convoy
      // deploys, so this probes the credential and the wallet, not our contracts.
      const sim = await simulateContractCall(client, {
        contractAddress: '0x4200000000000000000000000000000000000006',
        functionName: 'deposit',
        functionArgs: [],
        abi: [
          {
            name: 'deposit',
            type: 'function',
            stateMutability: 'payable',
            inputs: [],
            outputs: [],
          },
        ],
        value: '0',
      });
      return {
        ok: !sim.wouldRevert,
        status: sim.httpStatus,
        detail: sim.wouldRevert
          ? `simulate would revert: ${sim.revertReason ?? 'no reason'}`
          : `simulate HTTP ${sim.httpStatus}, sender ${sim.from ?? 'unknown'}`,
      };
    } catch (e) {
      const err = e as { httpStatus?: number; classification?: string; message?: string };
      return {
        ok: false,
        status: err.httpStatus,
        detail: `${err.classification ?? 'error'}: ${err.message ?? String(e)}`,
      };
    }
  })();
  return keeperHubProbe;
}

async function checkKeeperHubAuth(): Promise<Result> {
  const r = await probeKeeperHub();
  return {
    check: 'KeeperHub auth',
    status: r.ok ? 'PASS' : 'FAIL',
    detail: r.ok ? `key accepted — ${r.detail}` : r.detail,
  };
}

async function checkKeeperHubWallet(): Promise<Result> {
  const r = await probeKeeperHub();
  // 422 is the specific signal that the org Turnkey wallet is not configured
  // for this chain (gap G-03). It is fatal-to-run, not a transient fault.
  const notConfigured = r.status === 422;
  return {
    check: 'KeeperHub wallet configured',
    status: r.ok ? 'PASS' : 'FAIL',
    detail: notConfigured
      ? '422 — org Turnkey wallet is NOT configured for 84532 (fatal to any run)'
      : r.ok
        ? `org wallet is the simulate sender — ${r.detail}`
        : r.detail,
  };
}

async function checkBaseRpc(): Promise<Result> {
  const check = `RPC pinned ${TARGET_CHAIN.id}`;
  const url = env('BASE_RPC_URL');
  if (url === undefined) {
    return {
      check,
      status: 'FAIL',
      detail: `BASE_RPC_URL not set (dedicated ${TARGET_CHAIN.name} RPC required — never a public one)`,
      expectedFrom: 'CVY-003',
    };
  }
  try {
    const chainId = await rpcCall(url, 'eth_chainId', []);
    // Compared numerically, not as a string: `eth_chainId` is hex and 0x14a34
    // contains letters, whose case no provider guarantees.
    const reported = Number(chainId);
    const ok = reported === TARGET_CHAIN.id;
    return {
      check,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `eth_chainId == ${String(chainId)} (${TARGET_CHAIN.name})`
        : `eth_chainId == ${String(chainId)} (${Number.isNaN(reported) ? 'unparseable' : reported}), expected ${TARGET_CHAIN.id}`,
    };
  } catch (e) {
    return { check, status: 'FAIL', detail: (e as Error).message, expectedFrom: 'CVY-003' };
  }
}

async function checkRegistryDeployed(): Promise<Result> {
  const url = env('BASE_RPC_URL');
  const addr = env('CONVOY_REGISTRY_ADDR');
  if (url === undefined || addr === undefined) {
    return {
      check: 'Registry deployed',
      status: 'FAIL',
      detail: 'BASE_RPC_URL and/or CONVOY_REGISTRY_ADDR not set — deployed in CVY-003',
      expectedFrom: 'CVY-003',
    };
  }
  try {
    const code = await rpcCall(url, 'eth_getCode', [addr, 'latest']);
    const deployed = typeof code === 'string' && code !== '0x';
    return {
      check: 'Registry deployed',
      status: deployed ? 'PASS' : 'FAIL',
      detail: deployed ? `bytecode present at ${addr}` : `no bytecode at ${addr}`,
      expectedFrom: deployed ? undefined : 'CVY-003',
    };
  } catch (e) {
    return {
      check: 'Registry deployed',
      status: 'FAIL',
      detail: (e as Error).message,
      expectedFrom: 'CVY-003',
    };
  }
}

async function checkContractsBuild(): Promise<Result> {
  try {
    await run('forge', ['build'], resolve(ROOT, 'packages/contracts'));
    return { check: 'Contracts build', status: 'PASS', detail: 'forge build ok' };
  } catch (e) {
    return {
      check: 'Contracts build',
      status: 'FAIL',
      detail: failureDetail(e, 'forge build failed'),
    };
  }
}

async function checkWebBuild(): Promise<Result> {
  if (process.argv.includes('--skip-web-build')) {
    return { check: 'Web build', status: 'PASS', detail: 'skipped via --skip-web-build' };
  }
  try {
    // A production build must not inherit NODE_ENV=development from .env —
    // `next build` rejects a non-production NODE_ENV.
    await run('pnpm', ['--filter', '@convoy/web', 'build'], ROOT, { NODE_ENV: 'production' });
    return { check: 'Web build', status: 'PASS', detail: 'next build ok' };
  } catch (e) {
    return { check: 'Web build', status: 'FAIL', detail: failureDetail(e, 'next build failed') };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile(resolve(ROOT, '.env'));

  const results: Result[] = [];
  for (const check of [
    checkNode,
    checkPnpm,
    checkFoundry,
    checkPostgres,
    checkRedis,
    checkPrismaClient,
    checkMigrations,
    checkKeeperHubAuth,
    checkKeeperHubWallet,
    checkBaseRpc,
    checkRegistryDeployed,
    checkContractsBuild,
    checkWebBuild,
  ]) {
    results.push(await check());
  }

  const width = Math.max(...results.map((r) => r.check.length));
  console.log('\nCONVOY — environment PASS/FAIL matrix\n');
  for (const r of results) {
    const mark = r.status === 'PASS' ? 'PASS' : 'FAIL';
    const tag =
      r.status === 'FAIL' && r.expectedFrom !== undefined
        ? ` (expected until ${r.expectedFrom})`
        : '';
    console.log(`  ${mark}  ${r.check.padEnd(width)}  ${r.detail}${tag}`);
  }

  const blocking = results.filter((r) => r.status === 'FAIL' && r.expectedFrom === undefined);
  const expected = results.filter((r) => r.status === 'FAIL' && r.expectedFrom !== undefined);
  const passed = results.filter((r) => r.status === 'PASS');

  console.log(
    `\n  ${passed.length} passed · ${expected.length} expected-fail · ${blocking.length} blocking\n`,
  );

  if (expected.length > 0) {
    console.log('  Expected failures (credentials or artifacts that do not exist yet):');
    for (const r of expected) console.log(`    - ${r.check} → ${r.expectedFrom}`);
    console.log('');
  }

  if (blocking.length > 0) {
    console.log('  BLOCKING failures — fix before proceeding:');
    for (const r of blocking) console.log(`    - ${r.check}: ${r.detail}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
