import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GENLAYER_DEPLOYMENT_ENV_FILE,
  readGenLayerDeploymentKey,
} from '../genlayer/deployment_config.js';

const ENV_KEY = `0x${'11'.repeat(32)}`;
const FILE_KEY = `0x${'22'.repeat(32)}`;
const temporaryDirectories: string[] = [];

function temporaryFile(contents: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'convoy-genlayer-deploy-'));
  temporaryDirectories.push(directory);
  const path = resolve(directory, '.env.deploy.local');
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GenLayer deployment credential isolation', () => {
  it('uses the deployment environment variable without reading Convoy runtime config', () => {
    expect(readGenLayerDeploymentKey({ GENLAYER_DEPLOYMENT_KEY: ENV_KEY }, '/missing')).toBe(
      ENV_KEY,
    );
  });

  it('loads only the dedicated local deployment file when the variable is absent', () => {
    const path = temporaryFile(`# deployment only\nGENLAYER_DEPLOYMENT_KEY='${FILE_KEY}'\n`);
    expect(readGenLayerDeploymentKey({}, path)).toBe(FILE_KEY);
  });

  it('never includes an invalid credential in its error', () => {
    const invalid = 'do-not-print-this-value';
    expect(() =>
      readGenLayerDeploymentKey({ GENLAYER_DEPLOYMENT_KEY: invalid }, '/missing'),
    ).toThrow('GENLAYER_DEPLOYMENT_KEY must be supplied');
    try {
      readGenLayerDeploymentKey({ GENLAYER_DEPLOYMENT_KEY: invalid }, '/missing');
    } catch (error) {
      expect(String(error)).not.toContain(invalid);
    }
  });

  it('keeps the credential out of runtime code and explicitly gitignores the local file', () => {
    const runtimeSource = [
      readFileSync(resolve(process.cwd(), 'src/genlayer.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/provider.ts'), 'utf8'),
    ].join('\n');
    const gitignore = readFileSync(resolve(process.cwd(), '../../.gitignore'), 'utf8');

    expect(runtimeSource).not.toContain('GENLAYER_DEPLOYMENT_KEY');
    expect(runtimeSource).not.toContain('createAccount');
    expect(GENLAYER_DEPLOYMENT_ENV_FILE.endsWith('packages/ai/genlayer/.env.deploy.local')).toBe(
      true,
    );
    expect(gitignore).toContain('packages/ai/genlayer/.env.deploy.local');
  });
});
