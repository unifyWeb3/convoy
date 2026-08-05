// CVY-011 acceptance: the Critic against a 5-valid/5-invalid labelled fixture.
//
// THE BARS, from the task card:
//   >= 4/5 invalid items VETOED
//   5/5 valid items PASSED — zero false vetoes. This is the hard one. A false
//   veto stops a legitimate release and costs a human a re-run; a missed problem
//   is caught downstream by the simulator and by the onchain preconditions.
//
// THE SIMULATE LEG IS REAL. Every item is simulated against the deployed
// MockRewardDistributor on Base Sepolia through `@convoy/kh-client`, at zero gas
// — no signing, no broadcast, no audit row. The reverts come from the contract's
// own preconditions against its actual state, which is why the fixture was
// written after reading that state rather than before. Nothing here is staged.
//
// TWO NUMBERS ARE REPORTED, NOT ONE. `final` is what the run would actually do —
// the model's verdict after corroboration, which is the number that matters.
// `model-alone` is what the model said before the simulator and the arithmetic
// were applied. Keeping them apart is what lets CVY-016's honesty table say what
// the LLM contributed rather than crediting it with the simulator's work.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { KhClient, simulateContractCall } from '@convoy/kh-client';
import { Prisma } from '@convoy/db';

import {
  critiqueAction,
  type CriticInput,
  type CriticVerdict,
  type DeterministicFacts,
} from '../apps/web/lib/critic/index.js';
import {
  createLlmCaller,
  llmConfigFromEnv,
  LlmUnavailableError,
  type LlmCaller,
} from '../apps/web/lib/planner/llm.js';
import { DISTRIBUTOR_ABI, decodeRevertSelector } from '../services/worker/src/abis.js';
import { projectItemCost } from '../services/worker/src/budget.js';
import { readGasPriceWei } from '../services/worker/src/receipt.js';
import { loadDotEnv, pace, REPO_ROOT } from './planner.eval.shared.js';

interface FixtureItem {
  readonly idx: number;
  readonly label: string;
  readonly expected: 'APPROVE' | 'VETO';
  readonly acceptableReasons?: readonly string[];
  readonly corroboratedBy?: string;
  readonly target: string;
  readonly functionName: string;
  readonly functionArgs: readonly string[];
  readonly gasBudgetUsdc: string;
  readonly evidence: string;
}

interface Fixture {
  readonly budgetUsdc: string;
  readonly whitelist: readonly string[];
  readonly items: readonly FixtureItem[];
}

/** A recorded simulate, so a replay measures the same chain answer. */
interface RecordedSim {
  readonly wouldRevert: boolean;
  readonly revertReason?: string | null;
  readonly revertSelector?: string | null;
  readonly gasEstimate?: string | null;
  readonly httpStatus: number;
}

interface Recording {
  readonly gasPriceWei: string | null;
  readonly outcomes: {
    readonly idx: number;
    readonly simulate: RecordedSim;
    readonly transcript: { role: string; content: string }[];
  }[];
}

const TRANSCRIPT_DIR = join(REPO_ROOT, 'tests/fixtures/critic.transcripts');
const TRANSCRIPT_PATH = join(TRANSCRIPT_DIR, 'veto.json');

/** See the note where this is applied. Not the production timeout. */
const EVAL_TIMEOUT_MS = 60_000;
/**
 * Read BEFORE `loadDotEnv` runs, so "the operator set this" can be told apart
 * from "the repo's .env set this". `.env` carries the 8s production budget; an
 * explicit shell value is a deliberate choice and is left alone.
 */
const SHELL_TIMEOUT_MS = process.env['CONVOY_LLM_TIMEOUT_MS'];
/**
 * Courtesy pacing between items.
 *
 * The free tier this was measured on rate-limits from a SHARED upstream pool, so
 * 429s arrive on a budget nobody local controls. Pacing is the only lever that
 * works; the transport retry below handles the ones that get through anyway.
 */
const PACE_MS = Number(process.env['CONVOY_EVAL_PACE_MS'] ?? '4000');

function loadFixture(): Fixture {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'tests/fixtures/critic.5valid5invalid.json'), 'utf8'),
  ) as Fixture;
}

/**
 * Retry TRANSPORT failures only — never a response.
 *
 * A dropped connection is infrastructure. Counting it as "the Critic vetoed" or
 * "the Critic could not answer" would attribute a network fault to model
 * quality, in a measurement whose whole purpose is to separate the two.
 */
function withTransportRetry(inner: LlmCaller, attempts = 4): LlmCaller {
  return async (request) => {
    let last: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await inner(request);
      } catch (e) {
        last = e;
        // Longer than the Planner harness's backoff, because the failures
        // measured here were upstream-pool 429s rather than dropped sockets, and
        // those clear on a timescale of seconds rather than milliseconds.
        if (i < attempts - 1) await pace(4000 * (i + 1));
      }
    }
    throw last;
  };
}

function replayCaller(recording: Recording): LlmCaller & { select: (idx: number) => void } {
  const queues = new Map<number, string[]>(
    recording.outcomes.map((o) => [o.idx, o.transcript.map((t) => t.content)]),
  );
  let current: string[] = [];
  const caller: LlmCaller = async () => {
    const next = current.shift();
    if (next === undefined) throw new Error('replay exhausted — no more recorded turns');
    return await Promise.resolve({ content: next, model: '(replay)' });
  };
  return Object.assign(caller, {
    select: (idx: number): void => {
      current = [...(queues.get(idx) ?? [])];
    },
  });
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  loadDotEnv();
  const fixture = loadFixture();

  const replayPath = process.env['CONVOY_EVAL_REPLAY'];
  const replaying = replayPath !== undefined && replayPath !== '';
  const recording: Recording | undefined = replaying
    ? (JSON.parse(
        readFileSync(replayPath.startsWith('/') ? replayPath : join(REPO_ROOT, replayPath), 'utf8'),
      ) as Recording)
    : undefined;

  let call: LlmCaller;
  let select: ((idx: number) => void) | undefined;
  if (recording !== undefined) {
    process.stdout.write(`REPLAY MODE — recorded completions from ${String(replayPath)}\n`);
    process.stdout.write(
      '  This replays a live measurement, INCLUDING the simulate answers. It does not re-measure.\n\n',
    );
    const replay = replayCaller(recording);
    call = replay;
    select = replay.select;
  } else {
    // The 8s default is a PRODUCTION budget — CRITIQUING sits in the demo's
    // tightest beat and a run must not stall behind a model. It is the wrong
    // budget for a measurement: a free-tier provider that answers in 20s has
    // produced a verdict, and timing it out would record "the Critic missed
    // this" for something that is a latency fact about the tier, not a quality
    // fact about the model. Overridable, and printed either way.
    if (SHELL_TIMEOUT_MS === undefined) {
      process.env['CONVOY_LLM_TIMEOUT_MS'] = String(EVAL_TIMEOUT_MS);
    }
    try {
      const config = llmConfigFromEnv();
      process.stdout.write(
        `model: ${config.model}  via ${config.baseUrl}  (timeout ${config.timeoutMs}ms)\n`,
      );
      call = withTransportRetry(createLlmCaller(config));
    } catch (e) {
      fail(
        `NOT MEASURED — the Critic eval could not run.\n` +
          `  ${e instanceof LlmUnavailableError ? e.message : String(e)}\n\n` +
          `  This is not a pass and not a failure. No number may be reported from this run.\n` +
          `  Set OPENAI_API_KEY (and OPENAI_BASE_URL / CONVOY_LLM_MODEL if not OpenAI) and re-run,\n` +
          `  or set CONVOY_EVAL_REPLAY to a recorded transcript to replay a previous measurement.`,
      );
    }
  }

  // --- the simulator leg -----------------------------------------------------
  const distributor = process.env['MOCK_DISTRIBUTOR_ADDR'];
  let kh: KhClient | undefined;
  if (recording === undefined) {
    const apiKey = process.env['KEEPERHUB_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      fail(
        'NOT MEASURED — KEEPERHUB_API_KEY is not set.\n' +
          '  The Critic is grounded by a REAL simulate; without one there is nothing to corroborate\n' +
          '  against, and a Critic-only number would misrepresent what this milestone built.',
      );
    }
    if (distributor === undefined || distributor === '') {
      fail(
        'NOT MEASURED — MOCK_DISTRIBUTOR_ADDR is not set; there is no contract to simulate against.',
      );
    }
    kh = new KhClient({ apiKey, baseUrl: process.env['KEEPERHUB_BASE_URL'], chainId: '84532' });
    process.stdout.write(`simulating against ${distributor} on Base Sepolia (84532)\n\n`);
  }

  const gasPriceWei =
    recording !== undefined
      ? recording.gasPriceWei === null
        ? undefined
        : BigInt(recording.gasPriceWei)
      : await readGasPriceWei();
  if (gasPriceWei === undefined) {
    process.stdout.write(
      'NOTE: no gas price — the per-item budget projection is `unknown` for this run,\n' +
        '      so the over_budget item cannot be decided by arithmetic. Reported as such below.\n\n',
    );
  } else {
    process.stdout.write(`gas price: ${gasPriceWei.toString()} wei\n\n`);
  }

  const runEthUsd = new Prisma.Decimal(process.env['CONVOY_ETH_USD'] ?? '3400');
  const whitelist = new Set(fixture.whitelist);

  interface Row {
    readonly item: FixtureItem;
    readonly sim: RecordedSim;
    readonly facts: DeterministicFacts;
    readonly finalApproved: boolean;
    readonly finalReason?: string;
    readonly decidedBy: string;
    readonly modelVerdict?: CriticVerdict;
    readonly overrides: readonly string[];
    readonly transcript: readonly { role: string; content: string }[];
    readonly unavailable?: string;
  }
  const rows: Row[] = [];

  for (const item of fixture.items) {
    select?.(item.idx);

    let sim: RecordedSim;
    if (recording !== undefined) {
      const found = recording.outcomes.find((o) => o.idx === item.idx);
      if (found === undefined) fail(`replay has no recorded simulate for item ${item.idx}`);
      sim = found.simulate;
    } else {
      const result = await simulateContractCall(kh as KhClient, {
        contractAddress: distributor as string,
        functionName: item.functionName,
        functionArgs: item.functionArgs,
        abi: DISTRIBUTOR_ABI as unknown as readonly unknown[],
      });
      sim = {
        wouldRevert: result.wouldRevert,
        revertReason: result.revertReason ?? null,
        revertSelector: result.revertSelector ?? null,
        gasEstimate: result.gasEstimate ?? null,
        httpStatus: result.httpStatus,
      };
    }

    const decoded = decodeRevertSelector(sim.revertSelector ?? undefined);
    const projection = projectItemCost({
      itemIdx: item.idx,
      gasEstimateUnits: sim.gasEstimate ?? undefined,
      gasPriceWei,
      allocationUsdc: new Prisma.Decimal(item.gasBudgetUsdc),
      runEthUsd,
    });

    const facts: DeterministicFacts = {
      wouldRevert: sim.wouldRevert,
      ...(decoded === undefined && sim.revertReason == null
        ? {}
        : { revertReason: decoded ?? (sim.revertReason as string) }),
      budget: projection.verdict,
      budgetDetail: projection.detail,
      targetWhitelisted: whitelist.has(item.target),
    };

    // The Critic is consulted on EVERY item, including the ones the simulator
    // already rejected. The worker short-circuits those to save tokens; the eval
    // does not, because measuring the corroboration override requires both
    // verdicts in hand — including the case where the model would have approved
    // something that reverts.
    const input: CriticInput = {
      idx: item.idx,
      target: item.target,
      functionName: item.functionName,
      functionArgs: item.functionArgs,
      evidence: item.evidence,
      gasBudgetUsdc: item.gasBudgetUsdc,
      simulator: {
        wouldRevert: sim.wouldRevert,
        ...(decoded === undefined ? {} : { revertReason: decoded }),
        ...(sim.gasEstimate == null ? {} : { gasEstimate: sim.gasEstimate }),
        budget: projection.verdict,
        budgetDetail: projection.detail,
      },
    };

    const result = await critiqueAction(input, call, facts);
    rows.push({
      item,
      sim,
      facts,
      finalApproved: result.final.approved,
      ...(result.final.reason === undefined ? {} : { finalReason: result.final.reason }),
      decidedBy: result.final.decidedBy,
      ...(result.final.modelVerdict === undefined
        ? {}
        : { modelVerdict: result.final.modelVerdict }),
      overrides: result.final.overrides,
      transcript: result.transcript,
      ...(result.unavailableReason === undefined ? {} : { unavailable: result.unavailableReason }),
    });

    const mark = result.final.approved ? 'APPROVE' : `VETO(${result.final.reason ?? '?'})`;
    const ok = (result.final.approved ? 'APPROVE' : 'VETO') === item.expected ? ' ' : '!';
    process.stdout.write(
      `${ok} item ${item.idx}  ${mark.padEnd(28)} [${result.final.decidedBy}]  ${item.label}\n`,
    );
    for (const o of result.final.overrides) process.stdout.write(`     override: ${o}\n`);
    if (result.unavailableReason !== undefined) {
      process.stdout.write(`     critic unavailable: ${result.unavailableReason}\n`);
    }
    if (recording === undefined) await pace(PACE_MS);
  }

  // --- the numbers -----------------------------------------------------------
  const valid = rows.filter((r) => r.item.expected === 'APPROVE');
  const invalid = rows.filter((r) => r.item.expected === 'VETO');

  const falseVetoes = valid.filter((r) => !r.finalApproved);
  const caught = invalid.filter((r) => !r.finalApproved);
  const rightReason = caught.filter(
    (r) => r.finalReason !== undefined && (r.item.acceptableReasons ?? []).includes(r.finalReason),
  );

  const modelAloneCaught = invalid.filter((r) => r.modelVerdict?.verdict === 'VETO');
  const modelAloneFalse = valid.filter((r) => r.modelVerdict?.verdict === 'VETO');
  const consulted = rows.filter((r) => r.modelVerdict !== undefined);
  const overridden = rows.filter((r) => r.overrides.length > 0);

  process.stdout.write('\n--- CVY-011 -------------------------------------------------\n');
  process.stdout.write(
    `invalid vetoed          ${caught.length}/${invalid.length}   (bar >= 4/5)\n` +
      `  with an expected reason ${rightReason.length}/${invalid.length}\n` +
      `valid approved          ${valid.length - falseVetoes.length}/${valid.length}   (bar 5/5)\n` +
      `FALSE VETOES            ${falseVetoes.length}       (bar 0)\n\n`,
  );
  process.stdout.write(
    `model consulted on      ${consulted.length}/${rows.length} items\n` +
      `model alone, invalid    ${modelAloneCaught.length}/${invalid.length} vetoed\n` +
      `model alone, valid      ${modelAloneFalse.length}/${valid.length} falsely vetoed\n` +
      `corroboration overrode  ${overridden.length} verdict(s)\n`,
  );
  for (const r of overridden) {
    for (const o of r.overrides) process.stdout.write(`  item ${r.item.idx}: ${o}\n`);
  }
  for (const r of falseVetoes) {
    process.stdout.write(
      `\nFALSE VETO on item ${r.item.idx} (${r.decidedBy}): ${r.finalReason ?? '?'}\n` +
        `  quote: ${r.modelVerdict?.evidenceQuote ?? '(none)'}\n` +
        `  reason: ${r.modelVerdict?.justification ?? '(none)'}\n`,
    );
  }

  if (recording === undefined) {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const out: Recording & { recordedAt: string; model: string; baseUrl: string } = {
      recordedAt: new Date().toISOString(),
      model: process.env['CONVOY_LLM_MODEL'] ?? '(default)',
      baseUrl: process.env['OPENAI_BASE_URL'] ?? '(default)',
      gasPriceWei: gasPriceWei === undefined ? null : gasPriceWei.toString(),
      outcomes: rows.map((r) => ({
        idx: r.item.idx,
        simulate: r.sim,
        transcript: [...r.transcript],
      })),
    };
    writeFileSync(TRANSCRIPT_PATH, JSON.stringify(out, null, 2));
    process.stdout.write(`\ntranscripts: ${TRANSCRIPT_PATH}\n`);
  } else {
    process.stdout.write(`\ntranscripts: ${String(replayPath)} (replayed; not re-recorded)\n`);
  }

  // --- the verdict on the milestone -----------------------------------------
  const problems: string[] = [];
  if (falseVetoes.length > 0) {
    problems.push(`${falseVetoes.length} FALSE VETO(ES) — the hard bar is zero`);
  }
  if (caught.length < 4)
    problems.push(`only ${caught.length}/5 invalid items vetoed; the bar is 4`);
  if (consulted.length === 0) {
    problems.push('the Critic was never consulted — this measured the simulator alone');
  }

  if (problems.length > 0) {
    process.stderr.write(`\nFAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(1);
  }
  process.stdout.write('\nPASS — both bars met.\n');
}

void main();
