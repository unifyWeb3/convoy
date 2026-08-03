// @convoy/kh-client — transport core
//
// Owns auth, retry/backoff, and VCR replay. Everything that reaches
// app.keeperhub.com goes through `KhClient.request`, so there is exactly one
// place where a header, a retry rule or a redaction can be got wrong.
//
// This package is the ONLY module permitted to reach app.keeperhub.com.

import { KhError, classifyHttpError, classifyTransportError } from './errors.js';
import { isSupportedChainId } from './types.js';
import type { ChainId, KhMode } from './types.js';

export interface KhResponse {
  readonly httpStatus: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 8_000 };

/** A recorded tape. `key` is `METHOD path`, optionally suffixed by the caller. */
export interface VcrTape {
  readonly httpStatus: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody: unknown;
}

export interface KhClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly chainId: ChainId;
  readonly mode?: KhMode;
  readonly retry?: Partial<RetryPolicy>;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Deterministic jitter for tests. Returns [0,1). */
  readonly random?: () => number;
  /** Tapes for `vcr` mode, keyed by `${method} ${path}` or an explicit tapeKey. */
  readonly tapes?: Readonly<Record<string, VcrTape>>;
  readonly requestTimeoutMs?: number;
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the default `${method} ${path}` VCR lookup. */
  readonly tapeKey?: string;
  /**
   * Statuses that are a legitimate answer rather than a failure. A simulate that
   * finds a revert arrives on HTTP 400 — see types.ts SimulateResult.
   */
  readonly expectedStatuses?: readonly number[];
  readonly retry?: Partial<RetryPolicy>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class KhClient {
  readonly chainId: ChainId;
  readonly mode: KhMode;
  readonly baseUrl: string;

  readonly #apiKey: string;
  readonly #retry: RetryPolicy;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #tapes: Readonly<Record<string, VcrTape>>;
  readonly #timeoutMs: number;

  constructor(options: KhClientOptions) {
    if (options.apiKey === '') throw new Error('KhClient: apiKey is required');
    // Validated here rather than upstream: an unsupported chain returns HTTP 500
    // with an empty body (gap G-22), which the classifier would read as a
    // transient server fault and retry forever. Catch it before it is sent.
    if (!isSupportedChainId(options.chainId)) {
      throw new Error(
        `KhClient: unsupported chainId ${JSON.stringify(options.chainId)}. ` +
          'Convoy targets Base Sepolia 84532 (DEC-001); 8453 is the optional CVY-019 flip.',
      );
    }
    this.#apiKey = options.apiKey;
    this.chainId = options.chainId;
    this.mode = options.mode ?? 'live';
    this.baseUrl = (options.baseUrl ?? 'https://app.keeperhub.com').replace(/\/+$/, '');
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => Date.now());
    this.#random = options.random ?? Math.random;
    this.#tapes = options.tapes ?? {};
    this.#timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /** Never logged, never returned. Present so callers cannot reach the raw key. */
  get authorizationHeaderForTesting(): string {
    return `Bearer ${this.#apiKey.slice(0, 6)}…`;
  }

  backoffMs(attempt: number, retryAfterMs: number | undefined, policy: RetryPolicy): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, policy.maxDelayMs);
    // Full jitter: spreads a thundering herd of retrying items.
    return Math.floor(capped * this.#random());
  }

  async request(options: RequestOptions): Promise<KhResponse> {
    const policy = { ...this.#retry, ...options.retry };
    const expected = options.expectedStatuses ?? [];
    let last: KhError | undefined;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      let response: KhResponse;
      try {
        response = this.mode === 'vcr' ? this.#replay(options) : await this.#send(options);
      } catch (cause) {
        last = cause instanceof KhError ? cause : classifyTransportError(cause);
        if (!last.retryable || attempt === policy.maxAttempts) throw last;
        await this.#sleep(this.backoffMs(attempt, last.retryAfterMs, policy));
        continue;
      }

      if (response.httpStatus < 400 || expected.includes(response.httpStatus)) return response;

      const error = classifyHttpError({
        httpStatus: response.httpStatus,
        body: response.body,
        headers: response.headers,
        nowMs: this.#now(),
      });
      if (!error.retryable || attempt === policy.maxAttempts) throw error;
      last = error;
      await this.#sleep(this.backoffMs(attempt, error.retryAfterMs, policy));
    }

    /* c8 ignore next */
    throw last ?? new Error('KhClient: retry loop exited without a result');
  }

  async #send(options: RequestOptions): Promise<KhResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      ...options.headers,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.#fetch(`${this.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const text = await response.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = null;
    }
    return { httpStatus: response.status, headers: response.headers, body };
  }

  #replay(options: RequestOptions): KhResponse {
    const key = options.tapeKey ?? `${options.method} ${options.path}`;
    const tape = this.#tapes[key];
    if (tape === undefined) {
      // Loud rather than silent: a missing tape must never look like a pass.
      // Thrown as a KhError classified `fatal` so the retry loop does not treat
      // a harness misconfiguration as a transient network fault and sit through
      // four backoffs before reporting it.
      throw new KhError({
        message:
          `KhClient(vcr): no tape for ${JSON.stringify(key)}. ` +
          `Available: ${Object.keys(this.#tapes).join(', ') || '(none)'}`,
        classification: 'fatal',
        reason: 'a missing VCR tape is a harness configuration error; retrying cannot help',
      });
    }
    return {
      httpStatus: tape.httpStatus,
      headers: new Headers(tape.responseHeaders ?? {}),
      body: tape.responseBody,
    };
  }
}
