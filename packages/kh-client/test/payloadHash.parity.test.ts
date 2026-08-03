// Sol↔TS payloadHash parity.
//
// The fixtures are dumped from real Solidity output by
// `packages/contracts/script/DumpPayloadHashFixtures.s.sol`, never hand-written:
// a hand-written fixture would only prove TypeScript agrees with what the author
// believed Solidity does. `commitAction` correctness — the onchain proof that
// item `idx` was committed with exactly this payload — rests on this agreement,
// so a failure here is a release blocker, not a test nit.
//
// If a case fails, the bug is in the fixture plumbing or in the caller's
// argument encoding. Do NOT switch to the documented fallback encoding to make
// it green: that is a frozen-spec change and it would mask the real defect.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeArgs, payloadHash } from '../src/payloadHash.js';
import type { AbiArgValue } from '../src/payloadHash.js';
import type { Address, Hex } from 'viem';

const PINNED_ENCODING = 'keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))';

const FIXTURES_URL = new URL('../../../tests/fixtures/payloadHash.fixtures.json', import.meta.url);

interface Fixture {
  readonly name: string;
  readonly target: Address;
  readonly functionName: string;
  readonly argTypes: readonly string[];
  readonly argValues: readonly string[];
  readonly args: Hex;
  readonly idx: string;
  readonly payloadHash: Hex;
}

interface FixtureDocument {
  readonly encoding: string;
  readonly generatedBy: string;
  readonly fixtures: readonly Fixture[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Explicit structural validation. The file is a build artifact of our own forge
 * script rather than an LLM/KeeperHub/HTTP trust boundary, so it does not need
 * a zod schema — but it does need to fail loudly rather than yield `undefined`
 * into an assertion that then trivially passes.
 */
function parseFixtures(raw: string): FixtureDocument {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('fixtures: root is not an object');
  }

  const doc = parsed as Record<string, unknown>;
  if (typeof doc['encoding'] !== 'string') throw new Error('fixtures: missing encoding');
  if (typeof doc['generatedBy'] !== 'string') throw new Error('fixtures: missing generatedBy');
  if (!Array.isArray(doc['fixtures'])) throw new Error('fixtures: fixtures is not an array');

  const fixtures = doc['fixtures'].map((entry: unknown, i: number): Fixture => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`fixtures[${i}]: not an object`);
    }
    const f = entry as Record<string, unknown>;

    for (const key of ['name', 'target', 'functionName', 'args', 'idx', 'payloadHash']) {
      if (typeof f[key] !== 'string') {
        throw new Error(`fixtures[${i}]: ${key} is not a string`);
      }
    }
    if (!isStringArray(f['argTypes'])) throw new Error(`fixtures[${i}]: argTypes invalid`);
    if (!isStringArray(f['argValues'])) throw new Error(`fixtures[${i}]: argValues invalid`);
    if (f['argTypes'].length !== f['argValues'].length) {
      throw new Error(`fixtures[${i}]: argTypes/argValues length mismatch`);
    }

    return {
      name: f['name'] as string,
      target: f['target'] as Address,
      functionName: f['functionName'] as string,
      argTypes: f['argTypes'],
      argValues: f['argValues'],
      args: f['args'] as Hex,
      idx: f['idx'] as string,
      payloadHash: f['payloadHash'] as Hex,
    };
  });

  return {
    encoding: doc['encoding'],
    generatedBy: doc['generatedBy'],
    fixtures,
  };
}

/**
 * Turns a fixture's string-encoded value back into the typed value viem wants.
 * The fixtures carry values as strings so the JSON stays lossless for uint256
 * (which JSON numbers cannot represent) — the conversion belongs here, in the
 * test, not in the shipped helper.
 */
function coerce(type: string, raw: string): AbiArgValue {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    const parsed: unknown = JSON.parse(raw);
    if (!isStringArray(parsed)) {
      throw new Error(`coerce: ${type} value is not an array of strings: ${raw}`);
    }
    return parsed.map((v) => coerce(inner, v));
  }
  if (type === 'bool') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`coerce: bad bool ${raw}`);
    return raw === 'true';
  }
  if (/^u?int(\d+)?$/.test(type)) return BigInt(raw);
  // address, string, bytes, bytesN all travel as strings.
  return raw;
}

function coerceAll(argTypes: readonly string[], argValues: readonly string[]): AbiArgValue[] {
  return argValues.map((raw, i) => {
    const type = argTypes[i];
    if (type === undefined) throw new Error(`coerceAll: no type at index ${i}`);
    return coerce(type, raw);
  });
}

const doc = parseFixtures(readFileSync(FIXTURES_URL, 'utf8'));

describe('payloadHash Sol↔TS parity', () => {
  it('reads fixtures dumped by the forge script, not hand-written ones', () => {
    expect(doc.generatedBy).toBe('packages/contracts/script/DumpPayloadHashFixtures.s.sol');
  });

  it('pins the frozen encoding (blueprint A4)', () => {
    expect(doc.encoding).toBe(PINNED_ENCODING);
  });

  it('covers at least 10 fixtures', () => {
    expect(doc.fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it('covers the dynamic and edge-case types the card requires', () => {
    const names = doc.fixtures.map((f) => f.name);
    const allTypes = doc.fixtures.flatMap((f) => f.argTypes);

    expect(names).toContain('emptyArgs');
    expect(names).toContain('longFunctionName');
    expect(names).toContain('commitActionTriple');
    expect(allTypes).toContain('bytes32');
    expect(allTypes).toContain('uint256');
    expect(allTypes).toContain('address[]');
  });

  describe.each(doc.fixtures.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    const values = coerceAll(f.argTypes, f.argValues);

    it('encodes the argument tuple to the same bytes as Solidity', () => {
      expect(encodeArgs(f.argTypes, values)).toBe(f.args);
    });

    it('produces the same payloadHash as Solidity', () => {
      expect(
        payloadHash({
          target: f.target,
          functionName: f.functionName,
          encodedArgs: f.args,
          idx: BigInt(f.idx),
        }),
      ).toBe(f.payloadHash);
    });

    it('produces the same payloadHash from its own re-encoded args', () => {
      expect(
        payloadHash({
          target: f.target,
          functionName: f.functionName,
          encodedArgs: encodeArgs(f.argTypes, values),
          idx: BigInt(f.idx),
        }),
      ).toBe(f.payloadHash);
    });
  });
});

describe('payloadHash helper behaviour', () => {
  const target: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  it('encodes an empty argument tuple to 0x', () => {
    expect(encodeArgs([], [])).toBe('0x');
  });

  it('accepts idx as a number or a bigint interchangeably', () => {
    const base = { target, functionName: 'openRun', encodedArgs: '0x' as Hex };
    expect(payloadHash({ ...base, idx: 7 })).toBe(payloadHash({ ...base, idx: 7n }));
  });

  it('changes when any single component changes', () => {
    const base = {
      target,
      functionName: 'commitAction',
      encodedArgs: '0x' as Hex,
      idx: 1n,
    };
    const h = payloadHash(base);

    expect(payloadHash({ ...base, idx: 2n })).not.toBe(h);
    expect(payloadHash({ ...base, functionName: 'sealRun' })).not.toBe(h);
    expect(payloadHash({ ...base, target: '0x0000000000000000000000000000000000000000' })).not.toBe(
      h,
    );
    expect(payloadHash({ ...base, encodedArgs: encodeArgs(['uint256'], [1n]) })).not.toBe(h);
  });

  it('rejects a types/values length mismatch rather than encoding something wrong', () => {
    expect(() => encodeArgs(['uint256', 'address'], [1n])).toThrow(/2 types but 1 values/);
  });
});
