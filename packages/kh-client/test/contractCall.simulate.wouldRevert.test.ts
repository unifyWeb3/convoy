import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { KhClient } from '../src/client.js';
import type { VcrTape } from '../src/client.js';
import { KhError } from '../src/errors.js';
import { simulateContractCall } from '../src/contractCall.js';
import type { ContractCallParams } from '../src/types.js';

interface Recording {
  httpStatus: number;
  responseBody: unknown;
  request?: Record<string, unknown>;
}

function tape(name: string): Recording {
  const path = fileURLToPath(new URL(`./vcr/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Recording;
}

const PARAMS: ContractCallParams = {
  contractAddress: '0x4200000000000000000000000000000000000006',
  functionName: 'withdraw',
  functionArgs: ['1000000000000000000000000'],
};

function clientWith(tapes: Record<string, VcrTape>): KhClient {
  return new KhClient({ apiKey: 'kh_test', chainId: '84532', mode: 'vcr', tapes });
}

const KEY = 'SIMULATE 0x4200000000000000000000000000000000000006.withdraw';

describe('simulate — a would-revert is an ANSWER, not an error', () => {
  it('HTTP 400 with wouldRevert:true resolves instead of throwing', async () => {
    // The real recorded response. This is the single most important behaviour in
    // the client: if a 400 here were classified as an API error, every Critic
    // veto would become a hard failure and the veto mechanism would be unusable.
    const t = tape('simulate.wouldRevert.true.json');
    expect(t.httpStatus).toBe(400);

    const client = clientWith({
      [KEY]: { httpStatus: t.httpStatus, responseBody: t.responseBody },
    });

    const result = await simulateContractCall(client, PARAMS);

    expect(result.wouldRevert).toBe(true);
    expect(result.httpStatus).toBe(400);
    expect(result.revertReason).toBeDefined();
    expect(result.revertReason).toContain('Simulation reverted');
  });

  it('the recorded revert body carries success:false — the verdict is wouldRevert, not success', async () => {
    const t = tape('simulate.wouldRevert.true.json');
    expect((t.responseBody as Record<string, unknown>)['success']).toBe(false);

    const client = clientWith({
      [KEY]: { httpStatus: t.httpStatus, responseBody: t.responseBody },
    });
    // Keying on `success` would report this as a failed call rather than a
    // successful simulate that found a revert.
    await expect(simulateContractCall(client, PARAMS)).resolves.toMatchObject({
      wouldRevert: true,
    });
  });

  it('HTTP 200 with wouldRevert:false returns the gas estimate', async () => {
    const probe = tape('dec-001.simulate.84532.probe.json') as unknown as {
      primary: Recording;
    };
    const p = probe.primary;
    expect(p.httpStatus).toBe(200);

    const client = clientWith({
      'SIMULATE 0x4200000000000000000000000000000000000006.deposit': {
        httpStatus: p.httpStatus,
        responseBody: p.responseBody,
      },
    });

    const result = await simulateContractCall(client, {
      contractAddress: '0x4200000000000000000000000000000000000006',
      functionName: 'deposit',
      functionArgs: [],
    });

    expect(result.wouldRevert).toBe(false);
    expect(result.gasEstimate).toBe('25989');
    expect(result.httpStatus).toBe(200);
  });

  it('a 400 with NO wouldRevert verdict throws rather than reporting "would not revert"', async () => {
    // A validation error wearing the same status code. Reporting wouldRevert:false
    // here would let the Critic approve an item the API never evaluated — the
    // worst available failure mode.
    const client = clientWith({
      [KEY]: { httpStatus: 400, responseBody: { error: 'invalid functionArgs' } },
    });

    await expect(simulateContractCall(client, PARAMS)).rejects.toBeInstanceOf(KhError);
    await expect(simulateContractCall(client, PARAMS)).rejects.toMatchObject({
      classification: 'item-failed',
    });
  });

  it('a 401 during simulate still throws — expectedStatuses covers 400 only', async () => {
    const client = clientWith({
      [KEY]: { httpStatus: 401, responseBody: { error: 'Unauthorized' } },
    });
    await expect(simulateContractCall(client, PARAMS)).rejects.toMatchObject({
      classification: 'fatal',
    });
  });
});

describe('simulate — wire body', () => {
  it('sends simulate as a strict boolean true, and args as a JSON-array STRING', async () => {
    let captured: Record<string, unknown> | undefined;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ wouldRevert: false, gasEstimate: '21000' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await simulateContractCall(client, {
      contractAddress: '0xabc0000000000000000000000000000000000001',
      functionName: 'commitAction',
      functionArgs: ['0xrun', 1, '0xhash'],
      abi: [{ name: 'commitAction', type: 'function' }],
      value: '0',
    });

    expect(captured?.['simulate']).toBe(true);
    expect(typeof captured?.['simulate']).toBe('boolean');
    // A JSON-array string, not an array.
    expect(captured?.['functionArgs']).toBe('["0xrun",1,"0xhash"]');
    expect(typeof captured?.['functionArgs']).toBe('string');
    expect(typeof captured?.['abi']).toBe('string');
    // Both fields, both strings (gap G-01).
    expect(captured?.['chainId']).toBe('84532');
    expect(captured?.['network']).toBe('84532');
  });

  it('never sends a nonce — ordering belongs to KeeperHub', async () => {
    let captured: Record<string, unknown> | undefined;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ wouldRevert: false }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await simulateContractCall(client, PARAMS);
    expect(Object.keys(captured ?? {})).not.toContain('nonce');
    expect(JSON.stringify(captured)).not.toMatch(/nonce/i);
  });

  it('simulate carries NO Idempotency-Key — simulates are exempt', async () => {
    let headers: Record<string, string> = {};
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ wouldRevert: false }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await simulateContractCall(client, PARAMS);
    const names = Object.keys(headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('idempotency-key');
  });
});

describe('chain validation happens before any request is sent', () => {
  it('rejects an unsupported chainId at construction (gap G-22)', () => {
    expect(
      () =>
        new KhClient({
          apiKey: 'kh_test',
          chainId: '999999' as unknown as '84532',
        }),
    ).toThrow(/unsupported chainId/i);
  });
});
