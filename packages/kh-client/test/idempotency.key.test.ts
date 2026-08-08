import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_HEADER,
  buildIdempotencyKey,
  buildPhaseIdempotencyKey,
  parseIdempotencyKey,
} from '../src/idempotency.js';

describe('buildIdempotencyKey', () => {
  it('is <runId>:<idx>:<attempt>', () => {
    expect(buildIdempotencyKey({ runId: 'run_1', idx: 0, attempt: 0 })).toBe('run_1:0:0');
    expect(buildIdempotencyKey({ runId: 'run_1', idx: 11, attempt: 2 })).toBe('run_1:11:2');
  });

  it('changes with the attempt, so a retry is a distinct key', () => {
    const a = buildIdempotencyKey({ runId: 'r', idx: 1, attempt: 0 });
    const b = buildIdempotencyKey({ runId: 'r', idx: 1, attempt: 1 });
    expect(a).not.toBe(b);
  });

  it('changes with the index, so two items in a run never collide', () => {
    expect(buildIdempotencyKey({ runId: 'r', idx: 1, attempt: 0 })).not.toBe(
      buildIdempotencyKey({ runId: 'r', idx: 2, attempt: 0 }),
    );
  });

  it('rejects a runId containing the separator — keys would become ambiguous', () => {
    expect(() => buildIdempotencyKey({ runId: 'run:1', idx: 0, attempt: 0 })).toThrow(/":"/);
  });

  it('rejects an empty runId', () => {
    expect(() => buildIdempotencyKey({ runId: '', idx: 0, attempt: 0 })).toThrow(/empty/);
  });

  it('rejects non-integer or negative idx/attempt', () => {
    expect(() => buildIdempotencyKey({ runId: 'r', idx: -1, attempt: 0 })).toThrow(/idx/);
    expect(() => buildIdempotencyKey({ runId: 'r', idx: 1.5, attempt: 0 })).toThrow(/idx/);
    expect(() => buildIdempotencyKey({ runId: 'r', idx: 0, attempt: -1 })).toThrow(/attempt/);
    expect(() => buildIdempotencyKey({ runId: 'r', idx: 0, attempt: 1.5 })).toThrow(/attempt/);
  });
});

describe('phase-folded idempotency keys', () => {
  it('keeps the three-part shape and separates every write phase', () => {
    const keys = (['o', 'c', 'x', 's'] as const).map((phase) =>
      buildPhaseIdempotencyKey('run-12345678', phase, 0, 0),
    );
    expect(keys).toEqual(['run-1234-o:0:0', 'run-1234-c:0:0', 'run-1234-x:0:0', 'run-1234-s:0:0']);
    expect(keys.every((key) => key.split(':').length === 3)).toBe(true);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('parseIdempotencyKey', () => {
  it('round-trips', () => {
    const ref = { runId: 'run_9', idx: 4, attempt: 2 };
    expect(parseIdempotencyKey(buildIdempotencyKey(ref))).toEqual(ref);
  });

  it('rejects malformed keys', () => {
    expect(() => parseIdempotencyKey('run_1:0')).toThrow(/malformed/);
    expect(() => parseIdempotencyKey('run_1:0:0:0')).toThrow(/malformed/);
    expect(() => parseIdempotencyKey('run_1:a:0')).toThrow(/malformed/);
  });
});

describe('header name', () => {
  it('is exactly Idempotency-Key', () => {
    expect(IDEMPOTENCY_HEADER).toBe('Idempotency-Key');
  });
});
