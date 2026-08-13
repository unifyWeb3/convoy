import { describe, expect, it } from 'vitest';

import {
  LlmUnavailableError,
  createLlmCaller,
  llmConfigFromEnv,
  type LlmConfig,
  type StructuredRequest,
} from '../src/planner/llm.js';

const CONFIG: LlmConfig = {
  apiKey: 'test-agentrouter-token',
  baseUrl: 'https://agentrouter.org/v1',
  model: 'gpt-5.6-sol',
  timeoutMs: 1_000,
};

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;

const REQUEST: StructuredRequest = {
  messages: [
    { role: 'system', content: 'Return JSON.' },
    { role: 'user', content: 'Is the transport working?' },
    { role: 'assistant', content: '{"ok":' },
    { role: 'user', content: 'Repair the JSON.' },
  ],
  schemaName: 'convoy_transport_test',
  jsonSchema: SCHEMA,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Responses API transport', () => {
  it('sends the Responses wire shape with strict JSON Schema output', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({
        object: 'response',
        status: 'completed',
        model: CONFIG.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '{"ok":true}' }],
          },
        ],
      });
    };

    const result = await createLlmCaller(CONFIG, fetchImpl)(REQUEST);

    expect(capturedUrl).toBe('https://agentrouter.org/v1/responses');
    if (capturedInit === undefined) throw new Error('request init was not captured');
    expect(capturedInit.method).toBe('POST');
    expect(new Headers(capturedInit.headers).get('authorization')).toBe(
      'Bearer test-agentrouter-token',
    );
    expect(new Headers(capturedInit.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(capturedInit.body))).toEqual({
      model: 'gpt-5.6-sol',
      input: REQUEST.messages,
      text: {
        format: {
          type: 'json_schema',
          name: 'convoy_transport_test',
          strict: true,
          schema: SCHEMA,
        },
      },
    });
    expect(result).toEqual({ content: '{"ok":true}', model: 'gpt-5.6-sol' });
  });

  it('concatenates canonical output_text parts and preserves an incomplete reason', async () => {
    const call = createLlmCaller(CONFIG, async () =>
      jsonResponse({
        status: 'incomplete',
        model: CONFIG.model,
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ignore me' }] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: '{"ok":' },
              { type: 'output_text', text: 'true}' },
            ],
          },
        ],
      }),
    );

    await expect(call(REQUEST)).resolves.toEqual({
      content: '{"ok":true}',
      model: 'gpt-5.6-sol',
      finishReason: 'max_output_tokens',
    });
  });

  it('accepts a compatible provider top-level output_text field', async () => {
    const call = createLlmCaller(CONFIG, async () =>
      jsonResponse({ model: CONFIG.model, output_text: '{"ok":true}' }),
    );

    await expect(call(REQUEST)).resolves.toMatchObject({ content: '{"ok":true}' });
  });

  it('rejects a successful envelope without output text', async () => {
    const call = createLlmCaller(CONFIG, async () =>
      jsonResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'Cannot comply.' }],
          },
        ],
      }),
    );

    await expect(call(REQUEST)).rejects.toThrow(LlmUnavailableError);
    await expect(call(REQUEST)).rejects.toThrow(/no output text/);
  });

  it('preserves HTTP and non-JSON envelope errors', async () => {
    const httpCall = createLlmCaller(CONFIG, async () =>
      jsonResponse({ error: 'rate limited' }, 429),
    );
    const nonJsonCall = createLlmCaller(
      CONFIG,
      async () => new Response('upstream proxy error', { status: 200 }),
    );

    await expect(httpCall(REQUEST)).rejects.toThrow(
      'LLM returned HTTP 429: {"error":"rate limited"}',
    );
    await expect(nonJsonCall(REQUEST)).rejects.toThrow(
      'LLM returned non-JSON envelope: upstream proxy error',
    );
  });

  it('classifies a scalar JSON envelope as missing output instead of throwing a type error', async () => {
    const call = createLlmCaller(CONFIG, async () => jsonResponse(null));

    await expect(call(REQUEST)).rejects.toThrow(LlmUnavailableError);
    await expect(call(REQUEST)).rejects.toThrow(/no output text/);
  });

  it('continues to read the provider settings from the existing environment names', () => {
    expect(
      llmConfigFromEnv({
        OPENAI_API_KEY: 'test-agentrouter-token',
        OPENAI_BASE_URL: 'https://agentrouter.org/v1',
        CONVOY_LLM_MODEL: 'gpt-5.6-sol',
        CONVOY_LLM_TIMEOUT_MS: '9000',
      }),
    ).toEqual({
      apiKey: 'test-agentrouter-token',
      baseUrl: 'https://agentrouter.org/v1',
      model: 'gpt-5.6-sol',
      timeoutMs: 9_000,
    });
  });
});
