// Planner eval — FIRST-PASS VALID JSON. Acceptance: ≥ 95%.
//
// "First pass" means the model's FIRST response parsed as JSON and satisfied the
// zod schema, with no repair pass. The denominator is runs × trials and is
// printed, because 10 samples cannot express 95% — 9/10 is 90% and 10/10 is
// 100%, with nothing in between. Default is 3 trials over 10 runs = 30 parses.
//
// ONE LENIENCY, DISCLOSED: a response wrapped in a ```json fence is unwrapped
// before the verdict. That is a formatting habit, not a schema failure, and
// counting it as one would misattribute the error. Everything else — a trailing
// sentence, a missing field, a string where an integer belongs — fails.
//
//   pnpm tsx tests/planner.validJson.eval.ts [trials]

import {
  isReplay,
  loadFixture,
  pace,
  planFixtureRun,
  requireCaller,
  saveTranscripts,
  type RunOutcome,
} from './planner.eval.shared.js';

const TRIALS = Number(process.argv[2] ?? '3');
const PACE_MS = Number(process.env['CONVOY_EVAL_PACE_MS'] ?? '3500');

async function main(): Promise<void> {
  const call = requireCaller();
  const runs = loadFixture();

  let firstPass = 0;
  let repairedOk = 0;
  let total = 0;
  let unavailable = 0;
  const outcomes: RunOutcome[] = [];

  for (let trial = 1; trial <= TRIALS; trial += 1) {
    for (const run of runs) {
      const outcome = await planFixtureRun(run, call, trial);
      outcomes.push(outcome);
      total += 1;
      if (outcome.firstPassValid) firstPass += 1;
      else if (outcome.plan.attempts === 2) repairedOk += 1;

      // A transport failure is not a JSON failure. It is counted separately so a
      // rate limit cannot masquerade as a model that cannot produce JSON.
      if (outcome.transcript.length === 0 && !outcome.firstPassValid) unavailable += 1;

      process.stdout.write(
        `  ${run.id.padEnd(34)} t${trial}  ` +
          `${outcome.firstPassValid ? 'first-pass' : outcome.plan.attempts === 2 ? 'REPAIRED  ' : 'FAILED    '}` +
          `  attempts=${outcome.plan.attempts}  ${outcome.plan.source}\n`,
      );
      await pace(PACE_MS);
    }
  }

  const path = saveTranscripts('validJson', outcomes, process.env['CONVOY_EVAL_REPLAY']);
  const measured = total - unavailable;
  const rate = measured === 0 ? 0 : firstPass / measured;

  process.stdout.write(
    `\n${'='.repeat(76)}\n` +
      `PLANNER FIRST-PASS VALID JSON — ${runs.length} runs x ${TRIALS} trial(s)\n` +
      `${'='.repeat(76)}\n` +
      `  first-pass valid  ${firstPass}/${measured} = ${(rate * 100).toFixed(1)}%   (acceptance >= 95.0%)\n` +
      `  repaired in one   ${repairedOk}\n` +
      `  unreachable       ${unavailable}  (transport failures, excluded from the denominator)\n` +
      `  mode              ${isReplay(call) ? 'REPLAY of a recorded live measurement' : 'LIVE'}\n` +
      `  transcripts       ${path}\n` +
      `${'='.repeat(76)}\n`,
  );

  if (measured === 0) {
    process.stderr.write('NOT MEASURED — every call failed at the transport layer.\n');
    process.exit(2);
  }
  const pass = rate >= 0.95;
  process.stdout.write(pass ? 'PASS\n' : 'FAIL\n');
  process.exit(pass ? 0 : 1);
}

void main();
