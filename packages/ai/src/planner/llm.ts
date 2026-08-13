// The LLM transport for the Planner and (from CVY-011) the Critic.
//
// An OpenAI-compatible `/responses` client, deliberately hand-rolled: the
// only features Convoy uses are structured outputs and a timeout, and a vendor
// SDK would add a dependency surface larger than the code it replaces.
//
// PROVIDER IS CONFIGURABLE, and this is load-bearing rather than
// future-proofing. `OPENAI_BASE_URL` selects the provider endpoint, while the
// variable is still named `OPENAI_API_KEY` because the frozen blueprint §11
// environment table names it that (D-031).

export interface LlmConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

// The two defaults must be COHERENT. An endpoint/model mismatch is a guaranteed
// provider error for anyone who sets only the key. These defaults pair OpenAI's
// endpoint with an OpenAI model; deployments can override both together.
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Read config from the environment.
 *
 * Throws rather than returning a half-configured client: a missing key must
 * surface as "the Planner cannot run, use the deterministic fallback", never as
 * a request that fails later and gets mistaken for a model quality problem.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey === '' || apiKey.endsWith('replace_me')) {
    throw new LlmUnavailableError('OPENAI_API_KEY is not set');
  }
  return {
    apiKey,
    baseUrl: env['OPENAI_BASE_URL'] ?? DEFAULT_BASE_URL,
    model: env['CONVOY_LLM_MODEL'] ?? DEFAULT_MODEL,
    timeoutMs: Number(env['CONVOY_LLM_TIMEOUT_MS'] ?? '8000'),
  };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface StructuredRequest {
  readonly messages: readonly ChatMessage[];
  readonly schemaName: string;
  readonly jsonSchema: unknown;
}

export interface LlmResponse {
  readonly content: string;
  readonly model?: string;
  readonly finishReason?: string;
}

export type LlmCaller = (request: StructuredRequest) => Promise<LlmResponse>;

interface ResponsesEnvelope {
  readonly output?: unknown;
  readonly output_text?: unknown;
  readonly model?: unknown;
  readonly incomplete_details?: unknown;
}

function extractOutputText(body: ResponsesEnvelope): string | undefined {
  if (Array.isArray(body.output)) {
    const chunks: string[] = [];
    for (const item of body.output) {
      if (typeof item !== 'object' || item === null) continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const output = part as { type?: unknown; text?: unknown };
        if (output.type === 'output_text' && typeof output.text === 'string') {
          chunks.push(output.text);
        }
      }
    }
    if (chunks.length > 0) return chunks.join('');
  }

  // Some compatible providers expose the SDK-style convenience field directly.
  return typeof body.output_text === 'string' ? body.output_text : undefined;
}

function extractFinishReason(body: ResponsesEnvelope): string | undefined {
  if (typeof body.incomplete_details !== 'object' || body.incomplete_details === null) {
    return undefined;
  }
  const reason = (body.incomplete_details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Call the provider in structured-output mode.
 *
 * `strict: true` asks the provider to constrain generation to the schema. Not
 * every model honours it — which is exactly why the response is validated
 * against `PlanSchema` afterwards regardless. The schema is a strong prior, not
 * a guarantee, and the ≥95% valid-JSON figure measures what actually came back.
 */
export function createLlmCaller(config: LlmConfig, fetchImpl: typeof fetch = fetch): LlmCaller {
  return async (request: StructuredRequest): Promise<LlmResponse> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: request.messages,
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              strict: true,
              schema: request.jsonSchema,
            },
          },
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (e) {
      // `fetch failed` on its own is useless for diagnosis — the reason (DNS,
      // TLS, timeout) lives on `cause`. Surface it, or a rate limit and a typo
      // in the base URL look identical in the eval output.
      const detail = e instanceof Error ? e.message : String(e);
      const cause = e instanceof Error && e.cause !== undefined ? ` (${String(e.cause)})` : '';
      throw new LlmUnavailableError(`LLM request failed: ${detail}${cause}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LlmUnavailableError(`LLM returned HTTP ${response.status}: ${text.slice(0, 400)}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LlmUnavailableError(`LLM returned non-JSON envelope: ${text.slice(0, 200)}`);
    }

    if (typeof body !== 'object' || body === null) {
      throw new LlmUnavailableError(`LLM response carried no output text: ${text.slice(0, 200)}`);
    }

    const envelope = body as ResponsesEnvelope;
    const content = extractOutputText(envelope);
    if (content === undefined) {
      throw new LlmUnavailableError(`LLM response carried no output text: ${text.slice(0, 200)}`);
    }

    const finishReason = extractFinishReason(envelope);
    return {
      content,
      ...(typeof envelope.model === 'string' ? { model: envelope.model } : {}),
      ...(finishReason === undefined ? {} : { finishReason }),
    };
  };
}
