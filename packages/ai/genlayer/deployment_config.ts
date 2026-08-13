import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENLAYER_DEPLOYMENT_KEY_ENV = 'GENLAYER_DEPLOYMENT_KEY';
export const GENLAYER_DEPLOYMENT_ENV_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '.env.deploy.local',
);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function keyFromFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1 || line.slice(0, equals).trim() !== GENLAYER_DEPLOYMENT_KEY_ENV) continue;
    return unquote(line.slice(equals + 1));
  }
  return undefined;
}

export function readGenLayerDeploymentKey(
  env: NodeJS.ProcessEnv = process.env,
  filePath = GENLAYER_DEPLOYMENT_ENV_FILE,
): `0x${string}` {
  const direct = env[GENLAYER_DEPLOYMENT_KEY_ENV];
  const candidate =
    direct === undefined || direct.trim() === '' ? keyFromFile(filePath) : unquote(direct);
  if (candidate === undefined || !/^0x[0-9a-fA-F]{64}$/.test(candidate)) {
    throw new Error(
      `${GENLAYER_DEPLOYMENT_KEY_ENV} must be supplied through the deployment environment or ${filePath}`,
    );
  }
  return candidate as `0x${string}`;
}
