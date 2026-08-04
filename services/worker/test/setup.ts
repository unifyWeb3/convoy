// Load the repo-root .env so REDIS_URL is present under `pnpm -r test` and CI,
// not only in a shell where someone exported it by hand.
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
if (process.env['REDIS_URL'] === undefined) {
  throw new Error(
    'REDIS_URL is not set and no .env was found. @convoy/worker tests drive a real BullMQ queue ' +
      'against Redis — durability and stalled-job behaviour cannot be faked with a mock.',
  );
}
