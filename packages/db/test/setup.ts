// Load the repo-root .env before any test constructs a PrismaClient.
//
// Without this the suite passes only for whoever exported DATABASE_URL by hand,
// and fails under `pnpm -r test` and in CI — a suite that depends on the
// operator's shell is not a gate.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = resolve(root, '.env');

if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(eq + 1).trim();
  }
}

if (process.env['DATABASE_URL'] === undefined) {
  throw new Error(
    'DATABASE_URL is not set and no .env was found. @convoy/db tests read the APPLIED schema out ' +
      'of a live Postgres — they cannot be faked against schema.prisma. Start Postgres and run ' +
      '`pnpm --filter @convoy/db db:migrate && pnpm --filter @convoy/db db:seed` first.',
  );
}
