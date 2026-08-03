import { describe, expect, it } from 'vitest';

import { KhClient } from '../src/client.js';
import { getExecutionStatus, parsePollHint, pollUntilTerminal, statusPath } from '../src/status.js';
import type { WriteResult } from '../src/types.js';

function statusClient(responses: { body: unknown; headers?: Record<string, string> }[]): {
  client: KhClient;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const client = new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    fetchImpl: (async (url: string) => {
      urls.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return new Response(JSON.stringify(r?.body ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json', ...(r?.headers ?? {}) },
      });
    }) as unknown as typeof fetch,
  });
  return { client, urls };
}

describe('parsePollHint', () => {
  it('reads seconds into milliseconds', () => {
    expect(parsePollHint('3')).toBe(3_000);
  });

  it('0 means terminal and is distinct from absent', () => {
    expect(parsePollHint('0')).toBe(0);
    expect(parsePollHint(null)).toBeUndefined();
    // A 0 hint must survive as 0, not collapse to undefined via falsiness.
    expect(parsePollHint('0')).not.toBeUndefined();
  });

  it('ignores junk and negatives', () => {
    expect(parsePollHint('later')).toBeUndefined();
    expect(parsePollHint('-1')).toBeUndefined();
    expect(parsePollHint('  ')).toBeUndefined();
  });
});

describe('statusPath', () => {
  it('encodes the execution id', () => {
    expect(statusPath('direct_abc')).toBe('/api/execute/direct_abc/status');
    expect(statusPath('a/b')).toBe('/api/execute/a%2Fb/status');
  });
});

describe('getExecutionStatus', () => {
  it('reads the hint header and the transaction fields', async () => {
    const { client, urls } = statusClient([
      {
        body: {
          status: 'completed',
          transactionHash: '0xabc',
          transactionLink: 'https://sepolia.basescan.org/tx/0xabc',
          gasUsedWei: '31000',
        },
        headers: { 'X-Poll-Interval-Hint': '0' },
      },
    ]);

    const result = await getExecutionStatus(client, 'direct_1');

    expect(urls[0]).toContain('/api/execute/direct_1/status');
    expect(result.status).toBe('completed');
    expect(result.transactionHash).toBe('0xabc');
    expect(result.gasUsedWei).toBe('31000');
    expect(result.pollIntervalHintMs).toBe(0);
    expect(result.terminal).toBe(true);
  });

  it('treats a 0 hint as terminal even when the status string still says running', async () => {
    // The header is the explicit signal; trusting only the status string would
    // keep polling a settled execution.
    const { client } = statusClient([
      { body: { status: 'running' }, headers: { 'X-Poll-Interval-Hint': '0' } },
    ]);
    const result = await getExecutionStatus(client, 'direct_1');
    expect(result.terminal).toBe(true);
  });

  it('is non-terminal while running with a positive hint', async () => {
    const { client } = statusClient([
      { body: { status: 'running' }, headers: { 'X-Poll-Interval-Hint': '2' } },
    ]);
    const result = await getExecutionStatus(client, 'direct_1');
    expect(result.terminal).toBe(false);
    expect(result.pollIntervalHintMs).toBe(2_000);
  });
});

describe('pollUntilTerminal', () => {
  const pending: WriteResult = {
    executionId: 'direct_1',
    status: 'pending',
    terminal: false,
    httpStatus: 202,
    raw: {},
  };

  it('does NOT short-circuit a terminal write that has no hash yet (gap G-23)', async () => {
    // Measured against the live API: a synchronous write returns
    // 202 {status:"completed"} with NO transactionHash; the hash appears only on
    // GET /status. Short-circuiting on terminality alone would discard the one
    // field the manifest, the honesty table and the Basescan link depend on.
    let calls = 0;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            status: 'completed',
            transactionHash: '0x9450',
            transactionLink: 'https://sepolia.basescan.org/tx/0x9450',
            gasUsedWei: '74093',
          }),
          { status: 200, headers: { 'X-Poll-Interval-Hint': '0' } },
        );
      }) as unknown as typeof fetch,
    });

    const hashless: WriteResult = {
      executionId: 'direct_1',
      status: 'completed',
      terminal: true,
      httpStatus: 202,
      raw: {},
    };

    const result = await pollUntilTerminal(client, hashless, { sleep: async () => {} });

    expect(calls).toBe(1);
    expect(result.transactionHash).toBe('0x9450');
    expect(result.gasUsedWei).toBe('74093');
  });

  it('short-circuits when the write is terminal AND already carries a hash (gap G-02)', async () => {
    let calls = 0;
    const client = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const done: WriteResult = {
      executionId: 'direct_1',
      status: 'completed',
      transactionHash: '0xabc',
      terminal: true,
      httpStatus: 202,
      raw: {},
    };

    const result = await pollUntilTerminal(client, done);
    expect(result.status).toBe('completed');
    expect(result.transactionHash).toBe('0xabc');
    // The whole point: a synchronous write costs zero status calls.
    expect(calls).toBe(0);
  });

  it('polls until terminal, sleeping for exactly the hinted interval', async () => {
    const slept: number[] = [];
    const { client } = statusClient([
      { body: { status: 'running' }, headers: { 'X-Poll-Interval-Hint': '1' } },
      { body: { status: 'running' }, headers: { 'X-Poll-Interval-Hint': '3' } },
      { body: { status: 'completed', transactionHash: '0xfeed' } },
    ]);

    const result = await pollUntilTerminal(client, pending, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(result.status).toBe('completed');
    expect(result.transactionHash).toBe('0xfeed');
    expect(slept).toEqual([1_000, 3_000]);
  });

  it('falls back to the default interval when the header is absent', async () => {
    const slept: number[] = [];
    const { client } = statusClient([
      { body: { status: 'running' } },
      { body: { status: 'completed' } },
    ]);

    await pollUntilTerminal(client, pending, {
      defaultIntervalMs: 5_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([5_000]);
  });

  it('throws rather than fabricating terminality when it never settles', async () => {
    const { client } = statusClient([
      { body: { status: 'running' }, headers: { 'X-Poll-Interval-Hint': '1' } },
    ]);

    await expect(
      pollUntilTerminal(client, pending, { maxPolls: 3, sleep: async () => {} }),
    ).rejects.toThrow(/did not reach a terminal state/i);
  });
});
