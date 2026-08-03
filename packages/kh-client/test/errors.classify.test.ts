import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  KhError,
  classifyHttpError,
  classifyTransportError,
  extractMessage,
  parseRetryAfter,
} from '../src/errors.js';

/** Tapes are verbatim recordings of real KeeperHub responses (2026-08-03). */
function tape(name: string): { httpStatus: number; responseBody: unknown } {
  const path = fileURLToPath(new URL(`./vcr/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as { httpStatus: number; responseBody: unknown };
}

const headers = (h: Record<string, string> = {}): Headers => new Headers(h);

describe('classifyHttpError — the four classes', () => {
  it('401 is fatal: a rejected key cannot be retried into working', () => {
    // Recorded against the live API with a deliberately invalid key.
    const t = tape('errors.401.unauthorized.json');
    expect(t.httpStatus).toBe(401);

    const e = classifyHttpError({
      httpStatus: t.httpStatus,
      body: t.responseBody,
      headers: headers(),
    });
    expect(e.classification).toBe('fatal');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('Unauthorized');
  });

  it('403 daily cap is fatal-to-run, not fatal (gap G-03)', () => {
    const e = classifyHttpError({
      httpStatus: 403,
      body: { error: 'Daily spending cap exceeded' },
      headers: headers(),
    });
    expect(e.classification).toBe('fatal-to-run');
    expect(e.retryable).toBe(false);
  });

  it('422 wallet-not-configured is fatal-to-run (gap G-03)', () => {
    const e = classifyHttpError({
      httpStatus: 422,
      body: { error: 'Wallet not configured for this organization' },
      headers: headers(),
    });
    expect(e.classification).toBe('fatal-to-run');
  });

  it('429 is transient and honours Retry-After', () => {
    const e = classifyHttpError({
      httpStatus: 429,
      body: { error: 'Too Many Requests' },
      headers: headers({ 'retry-after': '7' }),
    });
    expect(e.classification).toBe('transient');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(7_000);
  });

  it('an unsupported chain returns 500 with an EMPTY body (gap G-22)', () => {
    // This is why KhClient validates chainId before sending: a permanent config
    // error arriving as a 500 would otherwise be retried forever.
    const t = tape('errors.unsupportedChain.500.json');
    expect(t.httpStatus).toBe(500);
    expect(t.responseBody).toBe('');

    const e = classifyHttpError({
      httpStatus: t.httpStatus,
      body: t.responseBody,
      headers: headers(),
    });
    expect(e.classification).toBe('transient');
    expect(e.message).toBe('KeeperHub HTTP 500');
  });

  describe('coded run errors are transient wherever they appear', () => {
    for (const code of ['E-0002', 'N-0001', 'P-0003', 'C-0001', 'C-0002']) {
      it(`${code} is transient`, () => {
        const e = classifyHttpError({
          httpStatus: 400,
          body: { error: `Execution failed: ${code} temporary provider fault` },
          headers: headers(),
        });
        expect(e.classification).toBe('transient');
        expect(e.code).toBe(code);
      });
    }

    it('the code wins over the status, so a coded 400 is not mistaken for a config-revert', () => {
      const coded = classifyHttpError({
        httpStatus: 400,
        body: { error: 'N-0001 nonce desync, retrying' },
        headers: headers(),
      });
      const uncoded = classifyHttpError({
        httpStatus: 400,
        body: { error: 'execution reverted: RootNotSet()' },
        headers: headers(),
      });
      expect(coded.classification).toBe('transient');
      expect(uncoded.classification).toBe('item-failed');
    });
  });

  it('a config-revert — full message, no code — fails the item and is NEVER retried', () => {
    const e = classifyHttpError({
      httpStatus: 400,
      body: { error: 'execution reverted: NotOperator()' },
      headers: headers(),
    });
    expect(e.classification).toBe('item-failed');
    expect(e.retryable).toBe(false);
  });

  describe('the two 409s have opposite handling', () => {
    it('idempotency_in_progress retries — the same key is mid-flight', () => {
      const e = classifyHttpError({
        httpStatus: 409,
        body: { error: 'idempotency_in_progress' },
        headers: headers(),
      });
      expect(e.classification).toBe('transient');
    });

    it('idempotency_conflict fails the item — it is a Convoy bug, not an API fault', () => {
      const e = classifyHttpError({
        httpStatus: 409,
        body: { error: 'idempotency_conflict' },
        headers: headers(),
      });
      expect(e.classification).toBe('item-failed');
      expect(e.retryable).toBe(false);
    });
  });

  it("transport failures are Convoy's own fault and always retry", () => {
    const e = classifyTransportError(new Error('ECONNRESET'));
    expect(e).toBeInstanceOf(KhError);
    expect(e.classification).toBe('transient');
    expect(e.httpStatus).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
  });

  it('reads an HTTP date, relative to now', () => {
    const now = Date.parse('2026-08-03T00:00:00Z');
    expect(parseRetryAfter('Mon, 03 Aug 2026 00:00:10 GMT', now)).toBe(10_000);
  });

  it('never returns a negative delay for a date already past', () => {
    const now = Date.parse('2026-08-03T00:01:00Z');
    expect(parseRetryAfter('Mon, 03 Aug 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined when absent or unparseable', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('   ', 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});

describe('extractMessage', () => {
  it('prefers error, then message, then revertReason', () => {
    expect(extractMessage({ error: 'a', message: 'b' })).toBe('a');
    expect(extractMessage({ message: 'b' })).toBe('b');
    expect(extractMessage({ revertReason: 'c' })).toBe('c');
  });

  it('passes a bare string through and tolerates junk', () => {
    expect(extractMessage('plain')).toBe('plain');
    expect(extractMessage(null)).toBe('');
    expect(extractMessage(42)).toBe('');
    expect(extractMessage({ error: '' })).toBe('');
  });
});
