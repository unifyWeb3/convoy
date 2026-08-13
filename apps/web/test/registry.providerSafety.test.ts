import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readRegistrySnapshot,
  registryBlockRanges,
  sanitizeProviderError,
  sortAndDedupeRegistryLogs,
} from '../lib/registry';

const FALLBACK_BEFORE = process.env['BASE_RPC_URL_FALLBACK'];

afterEach(() => {
  vi.restoreAllMocks();
  if (FALLBACK_BEFORE === undefined) delete process.env['BASE_RPC_URL_FALLBACK'];
  else process.env['BASE_RPC_URL_FALLBACK'] = FALLBACK_BEFORE;
});

describe('registry provider safety', () => {
  it('redacts RPC URLs, query credentials, and bearer material', () => {
    const safe = sanitizeProviderError(
      new Error(
        'fetch failed https://rpc.example.test/v1/key?api_key=secret&foo=bar Authorization: Bearer kh_live_secret',
      ),
    );
    expect(safe).not.toContain('rpc.example.test');
    expect(safe).not.toContain('secret');
    expect(safe).not.toContain('kh_live_secret');
    expect(safe).toContain('<rpc-url-redacted>');
  });

  it('chunks ranges into at most ten blocks', () => {
    expect(registryBlockRanges(3n, 25n)).toEqual([
      [3n, 12n],
      [13n, 22n],
      [23n, 25n],
    ]);
  });

  it('returns no ranges for an inverted interval', () => {
    expect(registryBlockRanges(2n, 1n)).toEqual([]);
  });

  it('merges deterministically and removes identical logs', () => {
    const a = { transactionHash: '0xa', blockHash: '0x1', blockNumber: 2n, logIndex: 1 };
    const b = { transactionHash: '0xb', blockHash: '0x2', blockNumber: 1n, logIndex: 0 };
    expect(sortAndDedupeRegistryLogs([a, b, a])).toEqual([b, a]);
  });

  it('tries a separately chain-pinned fallback after the primary provider fails', async () => {
    const primary = 'https://primary.invalid/v1/primary-secret';
    const fallback = 'https://fallback.invalid/v1/fallback-secret';
    process.env['BASE_RPC_URL_FALLBACK'] = fallback;
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === primary) throw new Error(`provider unavailable at ${primary}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x14a34' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await readRegistrySnapshot({
      runIdOnchain: `0x${'11'.repeat(32)}`,
      itemIndices: [],
      rpcUrl: primary,
      registryAddress: `0x${'22'.repeat(20)}`,
      fetchImpl,
    });

    expect(urls).toEqual([primary, fallback]);
    expect(result).toMatchObject({
      available: false,
      error: 'ledger has no RunOpened transaction hash to bound the registry log scan',
    });
  });

  it('rejects a wrong-chain fallback without exposing either provider URL', async () => {
    const primary = 'https://primary.invalid/v1/primary-secret?token=primary-token';
    const fallback = 'https://fallback.invalid/v1/fallback-secret?token=fallback-token';
    process.env['BASE_RPC_URL_FALLBACK'] = fallback;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === primary) throw new Error(`provider unavailable at ${primary}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await readRegistrySnapshot({
      runIdOnchain: `0x${'11'.repeat(32)}`,
      itemIndices: [],
      fromTransactionHash: `0x${'33'.repeat(32)}`,
      rpcUrl: primary,
      registryAddress: `0x${'22'.repeat(20)}`,
      fetchImpl,
    });

    expect(result.available).toBe(false);
    if (result.available) throw new Error('wrong-chain fallback unexpectedly produced a snapshot');
    expect(result.error).toContain('RPC returned chain 8453');
    expect(result.error).not.toContain('primary-secret');
    expect(result.error).not.toContain('fallback-secret');
    expect(result.error).not.toContain('primary-token');
    expect(result.error).not.toContain('fallback-token');
  });
});
