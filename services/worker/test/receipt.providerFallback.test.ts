import { describe, expect, it } from 'vitest';

import { readReceiptGas } from '../src/receipt.js';

describe('receipt provider fallback and chain pinning', () => {
  it('rejects a wrong-chain primary and reads the receipt from a pinned fallback', async () => {
    const previousPrimary = process.env['BASE_RPC_URL'];
    const previousFallback = process.env['BASE_RPC_URL_FALLBACK'];
    process.env['BASE_RPC_URL'] = 'https://primary.invalid/key';
    process.env['BASE_RPC_URL_FALLBACK'] = 'https://fallback.invalid/key';
    const calls: string[] = [];
    try {
      const result = await readReceiptGas(`0x${'11'.repeat(32)}`, {
        attempts: 2,
        retryDelayMs: 0,
        fetchImpl: async (url, init) => {
          const target = String(url);
          calls.push(target);
          const method = JSON.parse(String(init?.body)) as { method: string };
          if (method.method === 'eth_chainId') {
            return new Response(
              JSON.stringify({ result: target.includes('primary') ? '0x1' : '0x14a34' }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              result: {
                gasUsed: '0x5208',
                effectiveGasPrice: '0x2',
                l1Fee: '0x3',
                from: `0x${'22'.repeat(20)}`,
              },
            }),
            { status: 200 },
          );
        },
      });
      expect(result?.totalWei).toBe(42_003n);
      expect(calls.some((url) => url.includes('fallback'))).toBe(true);
      expect(calls.filter((url) => url.includes('primary'))).toHaveLength(1);
    } finally {
      if (previousPrimary === undefined) delete process.env['BASE_RPC_URL'];
      else process.env['BASE_RPC_URL'] = previousPrimary;
      if (previousFallback === undefined) delete process.env['BASE_RPC_URL_FALLBACK'];
      else process.env['BASE_RPC_URL_FALLBACK'] = previousFallback;
    }
  });
});
