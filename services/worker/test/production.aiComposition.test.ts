import { afterEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({
  caller: vi.fn(async () => ({ content: '{}' })),
  planRun: vi.fn(async (_input: unknown, call: unknown) => ({
    plan: {
      source: call === undefined ? 'fallback-topological' : 'planner',
      order: [0],
      deferrals: [],
      gasBudgetPerItem: [{ idx: 0, gasBudgetUsdc: '10.000000' }],
      rationalePerItem: [{ idx: 0, rationale: 'evidence' }],
      excludedIdx: [],
      warnings: call === undefined ? ['deterministic fallback used: LLM disabled'] : [],
      attempts: call === undefined ? 0 : 1,
    },
    firstPassValid: true,
    transcript: [],
  })),
  critiqueAction: vi.fn(async (_action: unknown, call: unknown) => ({
    final: {
      approved: true,
      decidedBy: call === undefined ? 'default' : 'critic',
      detail: call === undefined ? 'simulator-only gate' : 'matches evidence',
      overrides: [],
      criticConsulted: call !== undefined,
    },
    firstPassValid: true,
    transcript: [],
  })),
}));
const lifecycle = vi.hoisted(() => ({
  runBatch: vi.fn(async () => ({ status: 'SEALED_OK', runId: 'run-production' })),
}));

vi.mock('@convoy/ai/planner', () => ({ planRun: llm.planRun }));
vi.mock('@convoy/ai/provider', () => ({
  createConfiguredLlmCaller: vi.fn(() => llm.caller),
}));
vi.mock('@convoy/ai/critic', () => ({ critiqueAction: llm.critiqueAction }));
vi.mock('../src/runBatch.js', () => ({
  runBatch: lifecycle.runBatch,
  khFromEnv: vi.fn(() => ({ kind: 'kh' })),
}));

import { composeProductionAi, runProductionLifecycle } from '../src/handlers/types.js';

describe('production AI composition', () => {
  afterEach(() => vi.clearAllMocks());

  it('wires the real Planner and Critic adapters when configured', async () => {
    const ai = await composeProductionAi(vi.fn());
    const plan = await ai.planner?.({
      runId: 'run',
      budgetUsdc: '10.000000',
      items: [
        {
          idx: 0,
          target: 'RewardDistributor',
          functionName: 'fund',
          functionArgs: ['1'],
          evidence: 'fund one',
          dependsOn: [],
        },
      ],
    });
    const verdict = await ai.critic?.(
      {
        idx: 0,
        target: 'RewardDistributor',
        functionName: 'fund',
        functionArgs: ['1'],
        evidence: 'fund one',
        simulator: { wouldRevert: false },
      },
      { wouldRevert: false, budget: 'affordable', targetWhitelisted: true },
    );
    expect(plan).toMatchObject({ source: 'planner' });
    expect(verdict?.criticConsulted).toBe(true);
    expect(llm.planRun).toHaveBeenCalledOnce();
    expect(llm.critiqueAction).toHaveBeenCalledOnce();
  });

  it('keeps deterministic/simulator fallback ports when LLM configuration is absent', async () => {
    const providerModule = await import('@convoy/ai/provider');
    vi.mocked(providerModule.createConfiguredLlmCaller).mockImplementationOnce(() => {
      throw new Error('OPENAI_API_KEY is not set');
    });
    const log = vi.fn();
    const ai = await composeProductionAi(log);
    expect(ai.planner).toBeDefined();
    expect(ai.critic).toBeDefined();
    expect(ai.plannerFallback).toBe(true);
    expect(ai.criticFallback).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Planner=deterministic'));
    const plan = await ai.planner?.({
      runId: 'run',
      budgetUsdc: '10.000000',
      items: [],
    });
    const verdict = await ai.critic?.(
      {
        idx: 0,
        target: 'RewardDistributor',
        functionName: 'fund',
        functionArgs: ['1'],
        evidence: 'fund one',
        simulator: { wouldRevert: false },
      },
      { wouldRevert: false, budget: 'affordable', targetWhitelisted: true },
    );
    expect(plan).toMatchObject({ source: 'fallback-topological', attempts: 0 });
    expect(verdict?.criticConsulted).toBe(false);
  });

  it('passes the configured Planner and Critic into the single production runBatch rail', async () => {
    process.env['CONVOY_REGISTRY_ADDR'] = '0x0000000000000000000000000000000000000001';
    const result = await runProductionLifecycle({
      data: { runId: 'run-production', itemIdx: null, phase: 'plan', attempt: 0 },
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    expect(result.outcome).toBe('done');
    const [deps, runId, options] = lifecycle.runBatch.mock.calls[0] ?? [];
    expect(runId).toBe('run-production');
    expect(deps).toMatchObject({ registryAddr: process.env['CONVOY_REGISTRY_ADDR'] });
    expect(deps).toHaveProperty('critic');
    expect(options).toHaveProperty('planner');
  });
});
