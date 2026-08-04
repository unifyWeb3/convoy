import { describe, expect, it } from 'vitest';

import { KhClient } from '../src/client.js';
import { KhError } from '../src/errors.js';
import { buildContractCallBody, writeContractCall } from '../src/contractCall.js';
import type { AttemptRef, ContractCallParams } from '../src/types.js';

const PARAMS: ContractCallParams = {
  contractAddress: '0xabc0000000000000000000000000000000000001',
  functionName: 'openRun',
  functionArgs: ['0x1234'],
  abi: [{ name: 'openRun', type: 'function' }],
};

const REF: AttemptRef = { runId: 'run_7', idx: 3, attempt: 0 };

function clientReturning(
  status: number,
  body: unknown,
  capture?: (init: RequestInit) => void,
): KhClient {
  return new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    retry: { maxAttempts: 1 },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init !== undefined) capture?.(init);
      return new Response(body === null ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
}

describe('write — executionId', () => {
  it('returns the executionId from a 202', async () => {
    const client = clientReturning(202, {
      executionId: 'direct_abc123',
      status: 'completed',
      transactionHash: '0xdead',
      transactionLink: 'https://sepolia.basescan.org/tx/0xdead',
      gasUsedWei: '21000',
    });

    const result = await writeContractCall(client, PARAMS, REF);

    expect(result.executionId).toBe('direct_abc123');
    expect(result.transactionHash).toBe('0xdead');
    expect(result.gasUsedUnits).toBe('21000');
  });

  it('marks a synchronous completed write terminal so the poll is skipped (gap G-02)', async () => {
    const client = clientReturning(202, { executionId: 'direct_x', status: 'completed' });
    const result = await writeContractCall(client, PARAMS, REF);
    expect(result.terminal).toBe(true);
  });

  it('marks a failed write terminal too — failed is an answer, not a pending state', async () => {
    const client = clientReturning(202, { executionId: 'direct_x', status: 'failed' });
    const result = await writeContractCall(client, PARAMS, REF);
    expect(result.terminal).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('leaves a pending write non-terminal', async () => {
    const client = clientReturning(202, { executionId: 'direct_x', status: 'pending' });
    const result = await writeContractCall(client, PARAMS, REF);
    expect(result.terminal).toBe(false);
  });

  it('throws when no executionId comes back — there would be nothing to reconcile', async () => {
    const client = clientReturning(202, { status: 'completed' });
    await expect(writeContractCall(client, PARAMS, REF)).rejects.toBeInstanceOf(KhError);
  });
});

describe('write — headers and wire body', () => {
  it('carries Idempotency-Key as <runId>:<idx>:<attempt>', async () => {
    let headers: Record<string, string> = {};
    const client = clientReturning(
      202,
      { executionId: 'direct_x', status: 'completed' },
      (init) => {
        headers = (init.headers ?? {}) as Record<string, string>;
      },
    );

    await writeContractCall(client, PARAMS, REF);

    const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'idempotency-key');
    expect(entry?.[1]).toBe('run_7:3:0');
  });

  it('omits `simulate` entirely on a write rather than sending false', async () => {
    // The API treats simulate as a strict boolean; sending `false` is a
    // different request from omitting it.
    const body = buildContractCallBody('84532', PARAMS, false);
    expect('simulate' in body).toBe(false);

    const simulated = buildContractCallBody('84532', PARAMS, true);
    expect(simulated.simulate).toBe(true);
  });

  it('serialises functionArgs to a JSON-array string and abi to a JSON string', () => {
    const body = buildContractCallBody('84532', PARAMS, false);
    expect(body.functionArgs).toBe('["0x1234"]');
    expect(typeof body.abi).toBe('string');
    expect(body.chainId).toBe('84532');
    expect(body.network).toBe('84532');
  });

  it('omits optional fields it was not given', () => {
    const body = buildContractCallBody(
      '84532',
      {
        contractAddress: '0x1',
        functionName: 'f',
        functionArgs: [],
      },
      false,
    );
    expect('abi' in body).toBe(false);
    expect('value' in body).toBe(false);
    expect('gasLimitMultiplier' in body).toBe(false);
    expect(body.functionArgs).toBe('[]');
  });

  it('never includes a nonce', () => {
    const body = buildContractCallBody('84532', PARAMS, false);
    expect(JSON.stringify(body)).not.toMatch(/nonce/i);
  });
});

describe('write — retry behaviour', () => {
  it('retries a transient 429 and honours Retry-After', async () => {
    let calls = 0;
    const slept: number[] = [];
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 },
      random: () => 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
            status: 429,
            headers: { 'retry-after': '2' },
          });
        }
        return new Response(JSON.stringify({ executionId: 'direct_ok', status: 'completed' }), {
          status: 202,
        });
      }) as unknown as typeof fetch,
    });

    const result = await writeContractCall(client, PARAMS, REF);
    expect(result.executionId).toBe('direct_ok');
    expect(calls).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  it('does NOT retry a config-revert — the item is failed', async () => {
    let calls = 0;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: 'execution reverted: RootNotSet()' }), {
          status: 400,
        });
      }) as unknown as typeof fetch,
    });

    await expect(writeContractCall(client, PARAMS, REF)).rejects.toMatchObject({
      classification: 'item-failed',
    });
    expect(calls).toBe(1);
  });

  it('does NOT retry a 401', async () => {
    let calls = 0;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }) as unknown as typeof fetch,
    });

    await expect(writeContractCall(client, PARAMS, REF)).rejects.toMatchObject({
      classification: 'fatal',
    });
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts on a persistent transient fault', async () => {
    let calls = 0;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return new Response('', { status: 503 });
      }) as unknown as typeof fetch,
    });

    await expect(writeContractCall(client, PARAMS, REF)).rejects.toMatchObject({
      classification: 'transient',
    });
    expect(calls).toBe(3);
  });
});

describe('VCR mode', () => {
  it('replays a recorded write without touching the network', async () => {
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      mode: 'vcr',
      tapes: {
        'WRITE 0xabc0000000000000000000000000000000000001.openRun': {
          httpStatus: 202,
          responseBody: { executionId: 'direct_taped', status: 'completed' },
        },
      },
      fetchImpl: (() => {
        throw new Error('vcr mode must not reach the network');
      }) as unknown as typeof fetch,
    });

    const result = await writeContractCall(client, PARAMS, REF);
    expect(result.executionId).toBe('direct_taped');
  });

  it('a missing tape fails loudly rather than silently passing', async () => {
    const client = new KhClient({ apiKey: 'kh_test', chainId: '84532', mode: 'vcr', tapes: {} });
    await expect(writeContractCall(client, PARAMS, REF)).rejects.toThrow(/no tape for/i);
  });
});
