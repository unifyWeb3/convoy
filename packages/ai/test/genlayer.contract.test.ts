import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'genlayer/convoy_inference.py'), 'utf8');

describe('ConvoyInference contract artifact', () => {
  it('pins the proven GenLayer runtime and allows only the two Convoy schemas', () => {
    expect(source).toMatch(/^# \{ "Depends": "py-genlayer:[a-z0-9]+" \}/);
    expect(source).toContain('ALLOWED_SCHEMAS = ("convoy_plan", "convoy_critic_verdict")');
    expect(source).toContain('if schema_name not in ALLOWED_SCHEMAS:');
  });

  it('executes JSON inference and returns canonical JSON without storage', () => {
    expect(source).toContain('gl.nondet.exec_prompt(prompt, response_format="json")');
    expect(source).toContain('json.dumps(result, sort_keys=True, separators=(",", ":"))');
    expect(source).not.toContain('@allow_storage');
    expect(source).not.toContain('TreeMap');
  });
});
