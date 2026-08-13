import {
  GENLAYER_PROVIDER,
  createGenLayerLlmCaller,
  genLayerConfigFromEnv,
  type GenLayerClientFactory,
} from './genlayer.js';
import {
  LlmUnavailableError,
  createLlmCaller,
  llmConfigFromEnv,
  type LlmCaller,
} from './planner/llm.js';

export type LlmProvider = 'responses' | typeof GENLAYER_PROVIDER;

export interface ProviderFactoryOptions {
  readonly genLayerClientFactory?: GenLayerClientFactory;
  readonly fetchImpl?: typeof fetch;
}

export function llmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const provider = env['CONVOY_LLM_PROVIDER'] ?? 'responses';
  if (provider === 'responses' || provider === GENLAYER_PROVIDER) return provider;
  throw new LlmUnavailableError(`unsupported CONVOY_LLM_PROVIDER ${provider}`);
}

export function createConfiguredLlmCaller(
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderFactoryOptions = {},
): LlmCaller {
  const provider = llmProviderFromEnv(env);
  if (provider === GENLAYER_PROVIDER) {
    return createGenLayerLlmCaller(genLayerConfigFromEnv(env), options.genLayerClientFactory);
  }
  return createLlmCaller(llmConfigFromEnv(env), options.fetchImpl);
}
