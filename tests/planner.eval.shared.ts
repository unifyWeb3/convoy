// Shared harness for the two Planner evals.
//
// TWO THINGS THIS FILE REFUSES TO DO:
//
// 1. Report green without measuring. With no usable LLM the evals EXIT NONZERO
//    with an explicit "not measured" verdict. A skipped eval that prints a tick
//    is worse than no eval, because it gets cited.
// 2. Round a small denominator into a big claim. Every number is printed as
//    `matched/total`, so "95%" can be checked against the sample it came from.
//
// Transcripts are written to tests/fixtures/planner.transcripts/ so a reviewer
// can read what the model actually returned rather than trusting a summary.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLlmCaller,
  llmConfigFromEnv,
  planRun,
  LlmUnavailableError,
  type LlmCaller,
  type PlannerInput,
  type StoredPlan,
} from '../apps/web/lib/planner/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

export interface FixtureRun {
  readonly id: string;
  readonly budgetUsdc: string;
  readonly whitelist: readonly string[];
  readonly items: readonly {
    idx: number;
    target: string;
    functionName: string;
    functionArgs: readonly unknown[];
    evidence: string;
  }[];
  readonly expectedEdges: readonly [number, number][];
  readonly forbiddenEdges: readonly [number, number][];
  readonly expectedExcluded?: readonly number[];
  readonly injection?: { itemIdx: number; note: string };
}

export function loadFixture(): FixtureRun[] {
  const raw = readFileSync(join(REPO_ROOT, 'tests/fixtures/planner.10run.json'), 'utf8');
  return (JSON.parse(raw) as { runs: FixtureRun[] }).runs;
}

/** Load `.env` without a dependency. Existing env vars always win. */
export function loadDotEnv(): void {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || !t.includes('=')) continue;
    const at = t.indexOf('=');
    const key = t.slice(0, at);
    if (process.env[key] === undefined) process.env[key] = t.slice(at + 1).trim();
  }
}

export function toPlannerInput(run: FixtureRun): PlannerInput {
  return {
    items: run.items.map((i) => ({
      idx: i.idx,
      target: i.target,
      functionName: i.functionName,
      functionArgs: i.functionArgs,
      evidence: i.evidence,
    })),
    budgetUsdc: run.budgetUsdc,
  };
}

/**
 * Retry TRANSPORT failures only.
 *
 * A dropped connection is infrastructure, not model quality, and letting it
 * count as "the model could not produce JSON" would understate the metric for
 * the wrong reason. This retries the connection; it never retries a response.
 * A response that arrived and was malformed goes to the repair pass, which is
 * capped at one and is the thing actually being measured.
 *
 * Deliberately NOT inside `createLlmCaller`: in production, degrading to the
 * deterministic plan on the first failure is the correct behaviour, because the
 * run must not stall behind an LLM.
 */
function withTransportRetry(inner: LlmCaller, attempts = 3): LlmCaller {
  return async (request) => {
    let last: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await inner(request);
      } catch (e) {
        last = e;
        if (i < attempts - 1) await pace(2000 * (i + 1));
      }
    }
    throw last;
  };
}

/**
 * Replay recorded completions instead of calling the model.
 *
 * This is how CI runs the evals: deterministic, no credential, no spend, and
 * measuring the SAME completions a human measured live. It is a replay, not a
 * re-measurement, and both eval outputs say so.
 */
function replayCaller(path: string): LlmCaller {
  const recorded = JSON.parse(readFileSync(path, 'utf8')) as {
    outcomes: { runId: string; trial: number; transcript: { role: string; content: string }[] }[];
  };
  const queues = new Map<string, string[]>();
  for (const o of recorded.outcomes) {
    queues.set(
      `${o.runId}#${o.trial}`,
      o.transcript.map((t) => t.content),
    );
  }
  let current: string[] | undefined;
  const caller: LlmCaller & { select?: (runId: string, trial: number) => void } = async () => {
    const next = current?.shift();
    if (next === undefined)
      throw new Error('replay exhausted — recorded transcript has no more turns');
    return { content: next, model: '(replay)' };
  };
  caller.select = (runId, trial): void => {
    current = [...(queues.get(`${runId}#${trial}`) ?? [])];
  };
  replaySelectors.set(caller, caller.select);
  return caller;
}

const replaySelectors = new WeakMap<LlmCaller, (runId: string, trial: number) => void>();

/**
 * Build the caller, or explain why there is none and exit nonzero.
 *
 * Deliberately fatal. `vitest --passWithNoTests` and a skipped eval both print
 * something that reads like success; this cannot.
 */
export function requireCaller(): LlmCaller {
  loadDotEnv();

  const replay = process.env['CONVOY_EVAL_REPLAY'];
  if (replay !== undefined && replay !== '') {
    const path = replay.startsWith('/') ? replay : join(REPO_ROOT, replay);
    process.stdout.write(`REPLAY MODE — recorded completions from ${path}\n`);
    process.stdout.write(`  This replays a live measurement; it does not re-measure.\n\n`);
    return replayCaller(path);
  }

  try {
    const config = llmConfigFromEnv();
    process.stdout.write(`model: ${config.model}  via ${config.baseUrl}\n\n`);
    return withTransportRetry(createLlmCaller(config));
  } catch (e) {
    process.stderr.write(
      `\nNOT MEASURED — the Planner eval could not run.\n` +
        `  ${e instanceof LlmUnavailableError ? e.message : String(e)}\n\n` +
        `  This is not a pass and not a failure. No number may be reported from this run.\n` +
        `  Set OPENAI_API_KEY (and OPENAI_BASE_URL / CONVOY_LLM_MODEL if not OpenAI) and re-run,\n` +
        `  or set CONVOY_EVAL_REPLAY to a recorded transcript to replay a previous measurement.\n\n`,
    );
    process.exit(2);
  }
}

export function isReplay(call: LlmCaller): boolean {
  return replaySelectors.has(call);
}

export interface RunOutcome {
  readonly runId: string;
  readonly trial: number;
  readonly firstPassValid: boolean;
  readonly plan: StoredPlan;
  readonly transcript: readonly { role: string; content: string }[];
  readonly error?: string;
}

export async function planFixtureRun(
  run: FixtureRun,
  call: LlmCaller,
  trial: number,
): Promise<RunOutcome> {
  replaySelectors.get(call)?.(run.id, trial);
  try {
    const result = await planRun(toPlannerInput(run), call, { whitelist: run.whitelist });
    return {
      runId: run.id,
      trial,
      firstPassValid: result.firstPassValid,
      plan: result.plan,
      transcript: result.transcript,
    };
  } catch (e) {
    return {
      runId: run.id,
      trial,
      firstPassValid: false,
      plan: {
        source: 'fallback-topological',
        order: [],
        deferrals: [],
        gasBudgetPerItem: [],
        rationalePerItem: [],
        excludedIdx: [],
        warnings: [],
        attempts: 0,
      },
      transcript: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function saveTranscripts(
  name: string,
  outcomes: readonly RunOutcome[],
  replaySource?: string,
): string {
  // Never overwrite in replay mode. A replayed run must not leave behind a file
  // that looks like a second independent measurement.
  if (replaySource !== undefined) return `${replaySource} (replayed; not re-recorded)`;
  const dir = join(REPO_ROOT, 'tests/fixtures/planner.transcripts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model: process.env['CONVOY_LLM_MODEL'] ?? '(default)',
        baseUrl: process.env['OPENAI_BASE_URL'] ?? '(default)',
        outcomes: outcomes.map((o) => ({
          runId: o.runId,
          trial: o.trial,
          firstPassValid: o.firstPassValid,
          attempts: o.plan.attempts,
          source: o.plan.source,
          deferrals: o.plan.deferrals,
          order: o.plan.order,
          warnings: o.plan.warnings,
          excludedIdx: o.plan.excludedIdx,
          error: o.error ?? null,
          transcript: o.transcript,
        })),
      },
      null,
      2,
    ),
  );
  return path;
}

/** Rate-limit courtesy. Free-tier providers cap requests per minute. */
export async function pace(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
