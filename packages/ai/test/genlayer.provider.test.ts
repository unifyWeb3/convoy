import { describe, expect, it, vi } from 'vitest';

import {
  GENLAYER_INFERENCE_METHOD,
  createBradburySimulationClient,
  createGenLayerLlmCaller,
  genLayerConfigFromEnv,
  type GenLayerClientFactory,
  type GenLayerSimulationClient,
} from '../src/genlayer.js';
import { LlmUnavailableError, type StructuredRequest } from '../src/planner/llm.js';
import { createConfiguredLlmCaller, llmProviderFromEnv } from '../src/provider.js';

const { createClientMock, sdkSimulationMock, sdkWriteMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  sdkSimulationMock: vi.fn(),
  sdkWriteMock: vi.fn(),
}));

vi.mock('genlayer-js', () => ({ createClient: createClientMock }));
vi.mock('genlayer-js/chains', () => ({ testnetBradbury: { id: 4221, name: 'testnetBradbury' } }));

const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const PLAN_SCHEMA = {
  type: 'object',
  required: ['order', 'deferrals', 'gasBudgetPerItem', 'rationalePerItem'],
} as const;
const PLAN_REQUEST: StructuredRequest = {
  messages: [
    { role: 'system', content: 'Plan the run.' },
    { role: 'user', content: 'Fund after setting the root.' },
  ],
  schemaName: 'convoy_plan',
  jsonSchema: PLAN_SCHEMA,
};
const CRITIC_REQUEST: StructuredRequest = {
  messages: [
    { role: 'system', content: 'Critique the action.' },
    { role: 'user', content: 'The simulated action matches the evidence.' },
  ],
  schemaName: 'convoy_critic_verdict',
  jsonSchema: { type: 'object', required: ['verdict', 'reason'] },
};

function config(timeoutMs = 1_000) {
  return { network: 'testnetBradbury' as const, contractAddress: CONTRACT, timeoutMs };
}

function factoryReturning(value: unknown): {
  readonly factory: GenLayerClientFactory;
  readonly simulate: ReturnType<typeof vi.fn>;
} {
  const simulate = vi.fn(async () => value);
  const factory: GenLayerClientFactory = () => ({ simulateWriteContract: simulate });
  return { factory, simulate };
}

describe('GenLayer LlmCaller provider', () => {
  it('keeps Responses as the explicit compatibility default and rejects unknown providers', () => {
    expect(llmProviderFromEnv({})).toBe('responses');
    expect(() => llmProviderFromEnv({ CONVOY_LLM_PROVIDER: 'unknown' })).toThrow(
      'unsupported CONVOY_LLM_PROVIDER unknown',
    );
  });

  it('constructs an accountless Bradbury SDK client with simulation only', async () => {
    sdkSimulationMock.mockResolvedValueOnce({ ok: true });
    sdkWriteMock.mockRejectedValueOnce(new Error('writeContract must not be called'));
    createClientMock.mockReturnValueOnce({
      simulateWriteContract: sdkSimulationMock,
      writeContract: sdkWriteMock,
    });

    const client = createBradburySimulationClient();
    await expect(
      client.simulateWriteContract({
        address: CONTRACT,
        functionName: GENLAYER_INFERENCE_METHOD,
        args: ['convoy_plan', '[]', '{}'],
      }),
    ).resolves.toEqual({ ok: true });
    expect(createClientMock).toHaveBeenCalledWith({
      chain: { id: 4221, name: 'testnetBradbury' },
    });
    expect(sdkSimulationMock).toHaveBeenCalledWith({
      address: CONTRACT,
      functionName: GENLAYER_INFERENCE_METHOD,
      args: ['convoy_plan', '[]', '{}'],
    });
    expect(sdkWriteMock).not.toHaveBeenCalled();
  });

  it('selects GenLayer without requiring OPENAI_API_KEY', async () => {
    const { factory } = factoryReturning({
      order: [],
      deferrals: [],
      gasBudgetPerItem: [],
      rationalePerItem: [],
    });
    const call = createConfiguredLlmCaller(
      {
        CONVOY_LLM_PROVIDER: 'genlayer',
        CONVOY_GENLAYER_NETWORK: 'testnetBradbury',
        CONVOY_GENLAYER_CONTRACT: CONTRACT,
        CONVOY_LLM_TIMEOUT_MS: '1000',
      },
      { genLayerClientFactory: factory },
    );
    await expect(call(PLAN_REQUEST)).resolves.toMatchObject({
      model: 'genlayer/bradbury-consensus',
    });
    expect(llmProviderFromEnv({ CONVOY_LLM_PROVIDER: 'genlayer' })).toBe('genlayer');
  });

  it('serializes messages and the selected convoy_plan schema', async () => {
    const { factory, simulate } = factoryReturning({
      order: [],
      deferrals: [],
      gasBudgetPerItem: [],
      rationalePerItem: [],
    });
    await createGenLayerLlmCaller(config(), factory)(PLAN_REQUEST);
    expect(simulate).toHaveBeenCalledWith({
      address: CONTRACT,
      functionName: GENLAYER_INFERENCE_METHOD,
      args: ['convoy_plan', JSON.stringify(PLAN_REQUEST.messages), JSON.stringify(PLAN_SCHEMA)],
    });
  });

  it('passes convoy_critic_verdict through the same simulation boundary', async () => {
    const { factory, simulate } = factoryReturning({
      verdict: 'APPROVE',
      reason: 'none',
      evidenceQuote: '',
      justification: 'matches evidence',
    });
    const result = await createGenLayerLlmCaller(config(), factory)(CRITIC_REQUEST);
    expect(JSON.parse(result.content)).toMatchObject({ verdict: 'APPROVE', reason: 'none' });
    expect(simulate.mock.calls[0]?.[0].args[0]).toBe('convoy_critic_verdict');
  });

  it('accepts a canonical JSON string returned by the contract', async () => {
    const { factory } = factoryReturning(
      '{"order":[],"deferrals":[],"gasBudgetPerItem":[],"rationalePerItem":[]}',
    );
    const result = await createGenLayerLlmCaller(config(), factory)(PLAN_REQUEST);
    expect(JSON.parse(result.content)).toEqual({
      order: [],
      deferrals: [],
      gasBudgetPerItem: [],
      rationalePerItem: [],
    });
  });

  it('rejects malformed GenLayer output and unsupported schemas', async () => {
    const { factory } = factoryReturning('not json');
    await expect(createGenLayerLlmCaller(config(), factory)(PLAN_REQUEST)).rejects.toThrow(
      'malformed JSON string',
    );
    await expect(
      createGenLayerLlmCaller(config(), factory)({ ...PLAN_REQUEST, schemaName: 'other' }),
    ).rejects.toThrow('does not allow schema other');
  });

  it('preserves provider failures as LlmUnavailableError', async () => {
    const factory: GenLayerClientFactory = () => ({
      simulateWriteContract: vi.fn(async () => {
        throw new Error('Bradbury unavailable');
      }),
    });
    await expect(createGenLayerLlmCaller(config(), factory)(PLAN_REQUEST)).rejects.toThrow(
      LlmUnavailableError,
    );
    await expect(createGenLayerLlmCaller(config(), factory)(PLAN_REQUEST)).rejects.toThrow(
      'GenLayer request failed: Bradbury unavailable',
    );
  });

  it('enforces the configured timeout', async () => {
    const factory: GenLayerClientFactory = () => ({
      simulateWriteContract: vi.fn(() => new Promise(() => undefined)),
    });
    await expect(createGenLayerLlmCaller(config(5), factory)(PLAN_REQUEST)).rejects.toThrow(
      'timed out after 5ms',
    );
  });

  it('requires no account or private-key surface and exposes simulation only', () => {
    const captured: GenLayerSimulationClient[] = [];
    const factory: GenLayerClientFactory = () => {
      const client: GenLayerSimulationClient = {
        simulateWriteContract: vi.fn(async () => ({})),
      };
      captured.push(client);
      return client;
    };
    createGenLayerLlmCaller(config(), factory);
    expect(Object.keys(captured[0] ?? {})).toEqual(['simulateWriteContract']);
    expect(captured[0]).not.toHaveProperty('writeContract');
    expect(captured[0]).not.toHaveProperty('account');
    expect(captured[0]).not.toHaveProperty('privateKey');
  });

  it('validates Bradbury provider configuration', () => {
    expect(
      genLayerConfigFromEnv({
        CONVOY_GENLAYER_CONTRACT: CONTRACT,
        CONVOY_GENLAYER_NETWORK: 'testnetBradbury',
        CONVOY_LLM_TIMEOUT_MS: '12345',
      }),
    ).toEqual({ network: 'testnetBradbury', contractAddress: CONTRACT, timeoutMs: 12345 });
    expect(() =>
      genLayerConfigFromEnv({
        CONVOY_GENLAYER_CONTRACT: CONTRACT,
        CONVOY_GENLAYER_NETWORK: 'studionet',
      }),
    ).toThrow('must be testnetBradbury');
    expect(() =>
      genLayerConfigFromEnv({
        CONVOY_GENLAYER_CONTRACT: '0x0000000000000000000000000000000000000000',
      }),
    ).toThrow('must be a deployed Bradbury address');
  });
});
