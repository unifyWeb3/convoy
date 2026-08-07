import { describe, expect, it } from 'vitest';

import { checkAndExecute } from '../src/checkAndExecute.js';
import { KhClient } from '../src/client.js';

const CHECK = {
  contractAddress: '0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA',
  functionName: 'isCommitted',
  functionArgs: ['0xabc', '2'],
  abi: [{ name: 'isCommitted', type: 'function' }],
} as const;
const ACTION = {
  contractAddress: '0xD45c61797d7283caf8A31D91A5Bd6465A45AD561',
  functionName: 'fund',
  functionArgs: ['75000000'],
  abi: [{ name: 'fund', type: 'function' }],
} as const;

function clientReturning(body: unknown, capture?: (init: RequestInit) => void): KhClient {
  return new KhClient({
    apiKey: 'kh_test',
    chainId: '84532',
    retry: { maxAttempts: 1 },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      if (init !== undefined) capture?.(init);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
}

describe('check-and-execute', () => {
  it('parses a real condition-unmet response without requiring an executionId', async () => {
    const result = await checkAndExecute(
      clientReturning({
        executed: false,
        conditionResult: {
          met: false,
          observedValue: 'false',
          targetValue: 'true',
          operator: 'eq',
        },
      }),
      { check: CHECK, condition: { operator: 'eq', value: true }, action: ACTION },
      { runId: 'run-x', idx: 3, attempt: 0 },
    );

    expect(result).toMatchObject({
      executed: false,
      condition: {
        met: false,
        observedValue: 'false',
        targetValue: 'true',
        operator: 'eq',
      },
    });
    expect(result.executionId).toBeUndefined();
  });

  it('parses a condition-met execution response', async () => {
    const result = await checkAndExecute(
      clientReturning({
        executed: true,
        executionId: 'direct_gate_1',
        status: 'completed',
        transactionHash: '0xdead',
        transactionLink: 'https://sepolia.basescan.org/tx/0xdead',
        conditionResult: {
          met: true,
          observedValue: 'true',
          targetValue: 'true',
          operator: 'eq',
        },
      }),
      { check: CHECK, condition: { operator: 'eq', value: true }, action: ACTION },
      { runId: 'run-x', idx: 3, attempt: 0 },
    );

    expect(result).toMatchObject({
      executed: true,
      executionId: 'direct_gate_1',
      status: 'completed',
      terminal: true,
      condition: { met: true, observedValue: 'true', targetValue: 'true', operator: 'eq' },
    });
  });

  it('uses the verified flat wire shape and preserves retry idempotency', async () => {
    let requestBody: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const client = clientReturning(
      {
        executed: false,
        conditionResult: {
          met: false,
          observedValue: 'false',
          targetValue: 'true',
          operator: 'eq',
        },
      },
      (init) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        headers = (init.headers ?? {}) as Record<string, string>;
      },
    );

    await checkAndExecute(
      client,
      { check: CHECK, condition: { operator: 'eq', value: true }, action: ACTION },
      { runId: 'run-x', idx: 3, attempt: 2 },
    );

    expect(requestBody).toMatchObject({
      chainId: '84532',
      network: '84532',
      contractAddress: CHECK.contractAddress,
      functionName: 'isCommitted',
      functionArgs: '["0xabc","2"]',
      condition: { operator: 'eq', value: 'true' },
      action: {
        contractAddress: ACTION.contractAddress,
        functionName: 'fund',
        functionArgs: '["75000000"]',
      },
    });
    expect('check' in requestBody).toBe(false);
    expect('execute' in requestBody).toBe(false);
    expect(headers['Idempotency-Key']).toBe('run-x:3:2');
  });
});
