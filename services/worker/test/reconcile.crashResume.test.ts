import { describe, expect, it } from 'vitest';
import { KhClient, type StatusResult } from '@convoy/kh-client';

describe('CVY-015 reconcile-before-act', () => {
  function client(statuses: readonly { body: unknown; hint?: string }[]) {
    let cursor = 0;
    const sleeps: number[] = [];
    const kh = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 1 },
      sleep: async (ms) => sleeps.push(ms),
      fetchImpl: async () => {
        const next = statuses[Math.min(cursor++, statuses.length - 1)];
        return new Response(JSON.stringify(next?.body ?? null), {
          status: 200,
          headers: next?.hint === undefined ? {} : { 'X-Poll-Interval-Hint': next.hint },
        });
      },
    });
    return { kh, sleeps };
  }

  it('polls a persisted pending/running execution and honours the interval hint', async () => {
    const { kh, sleeps } = client([
      { body: { status: 'pending', executionId: 'direct_resume' }, hint: '0.025' },
      { body: { status: 'running', executionId: 'direct_resume' }, hint: '0.010' },
      {
        body: { status: 'completed', executionId: 'direct_resume', transactionHash: '0xabc' },
        hint: '0',
      },
    ]);
    const { pollPersistedExecution, classifyExecutionStatus } = await import('../src/reconcile.js');
    const status = await pollPersistedExecution(
      kh,
      {
        id: 'attempt-1',
        itemId: 'item-1',
        attemptNo: 0,
        kind: 'EXECUTE',
        executionId: 'direct_resume',
        txHash: null,
        txLink: null,
        khStatus: 'pending',
        errorCode: null,
        revertReason: null,
        gasUsedWei: null,
        gasUsedUsdc: null,
        sponsored: null,
      },
      { sleep: async (ms) => sleeps.push(ms) },
    );
    expect(sleeps).toEqual([25, 10]);
    expect(classifyExecutionStatus(status)).toMatchObject({ outcome: 'landed', txHash: '0xabc' });
  });

  it('never lands a completed status without a hash', async () => {
    const { kh } = client([
      { body: { status: 'completed', executionId: 'direct_no_hash' }, hint: '0' },
    ]);
    const { pollPersistedExecution, classifyExecutionStatus } = await import('../src/reconcile.js');
    const status = await pollPersistedExecution(kh, {
      id: 'attempt-2',
      itemId: 'item-1',
      attemptNo: 0,
      kind: 'EXECUTE',
      executionId: 'direct_no_hash',
      txHash: null,
      txLink: null,
      khStatus: 'completed',
      errorCode: null,
      revertReason: null,
      gasUsedWei: null,
      gasUsedUsdc: null,
      sponsored: null,
    });
    expect(classifyExecutionStatus(status).outcome).toBe('failed');
  });

  it('distinguishes transient coded failures from config reverts', async () => {
    const { classifyExecutionStatus } = await import('../src/reconcile.js');
    const base = (raw: unknown): StatusResult => ({
      executionId: 'direct_failed',
      status: 'failed',
      terminal: true,
      raw,
    });
    expect(
      classifyExecutionStatus(base({ status: 'failed', error: 'N-0001 temporary' })),
    ).toMatchObject({
      outcome: 'retry',
      code: 'N-0001',
    });
    expect(
      classifyExecutionStatus(base({ status: 'failed', revertReason: 'RootNotSet()' })),
    ).toMatchObject({
      outcome: 'failed',
    });
  });

  it('reissues no-execution attempts with a stable replayable key', async () => {
    const calls: string[] = [];
    const kh = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 1 },
      fetchImpl: async (_url, init) => {
        calls.push(
          Object.entries((init?.headers ?? {}) as Record<string, string>).find(
            ([key]) => key.toLowerCase() === 'idempotency-key',
          )?.[1] ?? 'none',
        );
        return new Response(JSON.stringify({ executionId: 'direct_reissued', status: 'pending' }), {
          status: 202,
        });
      },
    });
    const { writeContractCall, buildIdempotencyKey } = await import('@convoy/kh-client');
    const ref = { runId: 'run-x', idx: 2, attempt: 0 };
    await writeContractCall(
      kh,
      {
        contractAddress: '0x0000000000000000000000000000000000000001',
        functionName: 'enableMarket',
        functionArgs: ['2'],
      },
      ref,
    );
    expect(calls).toEqual([buildIdempotencyKey(ref)]);
  });

  it('retries idempotency_in_progress with the same key', async () => {
    const keys: string[] = [];
    let calls = 0;
    const kh = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
      random: () => 0,
      fetchImpl: async (_url, init) => {
        keys.push(
          Object.entries((init?.headers ?? {}) as Record<string, string>).find(
            ([key]) => key.toLowerCase() === 'idempotency-key',
          )?.[1] ?? 'none',
        );
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ error: 'idempotency_in_progress' }), { status: 409 })
          : new Response(JSON.stringify({ executionId: 'direct_same', status: 'pending' }), {
              status: 202,
            });
      },
    });
    const { writeContractCall } = await import('@convoy/kh-client');
    await writeContractCall(
      kh,
      {
        contractAddress: '0x0000000000000000000000000000000000000001',
        functionName: 'enableMarket',
        functionArgs: ['2'],
      },
      { runId: 'run-x', idx: 2, attempt: 0 },
    );
    expect(keys).toEqual(['run-x:2:0', 'run-x:2:0']);
  });

  it('classifies idempotency_conflict as a permanent Convoy bug', async () => {
    const kh = new KhClient({
      apiKey: 'kh_test',
      chainId: '84532',
      retry: { maxAttempts: 1 },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'idempotency_conflict' }), { status: 409 }),
    });
    const { writeContractCall, KhError } = await import('@convoy/kh-client');
    await expect(
      writeContractCall(
        kh,
        {
          contractAddress: '0x0000000000000000000000000000000000000001',
          functionName: 'enableMarket',
          functionArgs: ['2'],
        },
        { runId: 'run-x', idx: 2, attempt: 0 },
      ),
    ).rejects.toMatchObject<Partial<InstanceType<typeof KhError>>>({
      classification: 'item-failed',
      httpStatus: 409,
    });
  });
});
