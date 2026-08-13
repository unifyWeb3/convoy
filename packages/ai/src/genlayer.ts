import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

import {
  LlmUnavailableError,
  type LlmCaller,
  type LlmResponse,
  type StructuredRequest,
} from './planner/llm.js';

export const GENLAYER_PROVIDER = 'genlayer';
export const GENLAYER_BRADBURY_NETWORK = 'testnetBradbury';
export const GENLAYER_INFERENCE_METHOD = 'infer';
export const GENLAYER_MODEL_LABEL = 'genlayer/bradbury-consensus';

export interface GenLayerConfig {
  readonly network: typeof GENLAYER_BRADBURY_NETWORK;
  readonly contractAddress: `0x${string}`;
  readonly timeoutMs: number;
}

export interface GenLayerSimulationClient {
  readonly simulateWriteContract: (args: {
    readonly address: `0x${string}`;
    readonly functionName: typeof GENLAYER_INFERENCE_METHOD;
    readonly args: readonly [string, string, string];
  }) => Promise<unknown>;
}

export type GenLayerClientFactory = (config: GenLayerConfig) => GenLayerSimulationClient;

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['CONVOY_LLM_TIMEOUT_MS'] ?? '30000';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new LlmUnavailableError(`CONVOY_LLM_TIMEOUT_MS must be a positive integer (got ${raw})`);
  }
  return value;
}

export function genLayerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GenLayerConfig {
  const network = env['CONVOY_GENLAYER_NETWORK'] ?? GENLAYER_BRADBURY_NETWORK;
  if (network !== GENLAYER_BRADBURY_NETWORK) {
    throw new LlmUnavailableError(
      `CONVOY_GENLAYER_NETWORK must be ${GENLAYER_BRADBURY_NETWORK} (got ${network})`,
    );
  }

  const contractAddress = env['CONVOY_GENLAYER_CONTRACT'];
  if (
    contractAddress === undefined ||
    !/^0x[0-9a-fA-F]{40}$/.test(contractAddress) ||
    /^0x0{40}$/i.test(contractAddress)
  ) {
    throw new LlmUnavailableError('CONVOY_GENLAYER_CONTRACT must be a deployed Bradbury address');
  }

  return {
    network,
    contractAddress: contractAddress as `0x${string}`,
    timeoutMs: timeoutFromEnv(env),
  };
}

export function createBradburySimulationClient(): GenLayerSimulationClient {
  const client = createClient({ chain: testnetBradbury });
  return {
    simulateWriteContract: (args) =>
      client.simulateWriteContract({
        address: args.address,
        functionName: args.functionName,
        args: [...args.args],
      }),
  };
}

function responseContent(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('scalar JSON');
      }
      return JSON.stringify(parsed);
    } catch {
      throw new LlmUnavailableError('GenLayer returned a malformed JSON string');
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }

  throw new LlmUnavailableError('GenLayer returned no JSON object');
}

export function createGenLayerLlmCaller(
  config: GenLayerConfig,
  clientFactory: GenLayerClientFactory = createBradburySimulationClient,
): LlmCaller {
  const client = clientFactory(config);
  return async (request: StructuredRequest): Promise<LlmResponse> => {
    if (request.schemaName !== 'convoy_plan' && request.schemaName !== 'convoy_critic_verdict') {
      throw new LlmUnavailableError(`GenLayer does not allow schema ${request.schemaName}`);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(new LlmUnavailableError(`GenLayer request timed out after ${config.timeoutMs}ms`)),
        config.timeoutMs,
      );
    });

    try {
      const result = await Promise.race([
        client.simulateWriteContract({
          address: config.contractAddress,
          functionName: GENLAYER_INFERENCE_METHOD,
          args: [
            request.schemaName,
            JSON.stringify(request.messages),
            JSON.stringify(request.jsonSchema),
          ],
        }),
        timedOut,
      ]);
      return { content: responseContent(result), model: GENLAYER_MODEL_LABEL };
    } catch (error) {
      if (error instanceof LlmUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmUnavailableError(`GenLayer request failed: ${message}`);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}
