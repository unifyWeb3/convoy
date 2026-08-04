// Planner eval — DEPENDENCY RECALL. Acceptance: ≥ 0.9.
//
//   recall = |predicted edges ∩ labelled edges| / |labelled edges|
//
// Recall alone is gameable: a model emitting every ordered pair scores 1.0. So
// this also reports PRECISION and, more pointedly, the FORBIDDEN-EDGE rate — the
// pairs the fixture's prose deliberately does not license, several of which are
// chronological statements that read like dependencies and are not. A high
// recall with a high forbidden rate is a model agreeing with everything, and the
// output says so rather than hiding it behind the headline number.
//
//   pnpm tsx tests/planner.recall.eval.ts [trials]

import {
  isReplay,
  loadFixture,
  pace,
  planFixtureRun,
  requireCaller,
  saveTranscripts,
  type RunOutcome,
} from './planner.eval.shared.js';

const TRIALS = Number(process.argv[2] ?? '1');
const PACE_MS = Number(process.env['CONVOY_EVAL_PACE_MS'] ?? '3500');

const key = (a: number, b: number): string => `${a}<-${b}`;

async function main(): Promise<void> {
  const call = requireCaller();
  const runs = loadFixture();

  let labelledTotal = 0;
  let matchedTotal = 0;
  let predictedTotal = 0;
  let forbiddenHit = 0;
  let forbiddenTotal = 0;
  let cycles = 0;
  let excludedCorrect = 0;
  let excludedExpected = 0;
  let injectionClean = 0;
  let injectionRuns = 0;
  let unreachable = 0;
  let orderSatisfies = 0;
  let orderChecked = 0;

  const outcomes: RunOutcome[] = [];
  const rows: string[] = [];

  for (let trial = 1; trial <= TRIALS; trial += 1) {
    for (const run of runs) {
      const outcome = await planFixtureRun(run, call, trial);
      outcomes.push(outcome);

      const predicted = new Set(outcome.plan.deferrals.map((d) => key(d.idx, d.dependsOn)));
      const labelled = run.expectedEdges.map(([a, b]) => key(a, b));
      const forbidden = run.forbiddenEdges.map(([a, b]) => key(a, b));

      // A transport failure is not a wrong answer. Counting an unreachable run
      // as zero recall would blame the model for the network, so it is excluded
      // from the denominator and reported on its own line instead.
      if (outcome.transcript.length === 0) {
        unreachable += 1;
        process.stdout.write(`  ${run.id.padEnd(34)} t${trial}  UNREACHABLE — excluded\n`);
        await pace(PACE_MS);
        continue;
      }

      const matched = labelled.filter((k) => predicted.has(k)).length;
      const hitForbidden = forbidden.filter((k) => predicted.has(k)).length;

      labelledTotal += labelled.length;
      matchedTotal += matched;
      predictedTotal += predicted.size;
      forbiddenTotal += forbidden.length;
      forbiddenHit += hitForbidden;

      // THE OPERATIONALLY MEANINGFUL QUESTION. A missed edge only matters if it
      // changes what actually happens. `2 after 1 after 0` and `2 after both 1
      // and 0` are different edge sets and the same execution order, so recall
      // alone over-punishes a model that omits transitive closure. This checks
      // the order the plan produces against EVERY labelled edge, including the
      // ones the model never wrote down.
      orderChecked += 1;
      const at = new Map(outcome.plan.order.map((idx, i) => [idx, i]));
      const orderOk = run.expectedEdges.every(
        ([dependent, dependedOn]) => (at.get(dependent) ?? -1) > (at.get(dependedOn) ?? -1),
      );
      if (orderOk) orderSatisfies += 1;

      // A rejected cycle shows up as a fallback plan carrying the cycle message.
      if (outcome.plan.warnings.some((w) => w.includes('cycle'))) cycles += 1;

      if (run.expectedExcluded !== undefined) {
        excludedExpected += 1;
        const got = new Set(outcome.plan.excludedIdx);
        if (run.expectedExcluded.every((i) => got.has(i))) excludedCorrect += 1;
      }

      if (run.injection !== undefined) {
        injectionRuns += 1;
        const known = new Set(run.items.map((i) => i.idx));
        const inventedIndex =
          outcome.plan.order.some((i) => !known.has(i)) ||
          outcome.plan.deferrals.some((d) => !known.has(d.idx) || !known.has(d.dependsOn));
        if (!inventedIndex) injectionClean += 1;
      }

      const recall = labelled.length === 0 ? 1 : matched / labelled.length;
      rows.push(
        `  ${run.id.padEnd(34)} t${trial}  ` +
          `recall ${matched}/${labelled.length}` +
          `${labelled.length === 0 ? ' (no edges labelled)' : ` = ${recall.toFixed(2)}`}` +
          `  predicted ${predicted.size}  forbidden ${hitForbidden}/${forbidden.length}` +
          `  ${outcome.plan.source}${outcome.error === undefined ? '' : `  ERROR ${outcome.error}`}`,
      );
      process.stdout.write(`${rows[rows.length - 1] ?? ''}\n`);
      await pace(PACE_MS);
    }
  }

  const path = saveTranscripts('recall', outcomes, process.env['CONVOY_EVAL_REPLAY']);
  const recall = labelledTotal === 0 ? 0 : matchedTotal / labelledTotal;
  const precision = predictedTotal === 0 ? 0 : matchedTotal / predictedTotal;

  process.stdout.write(
    `\n${'='.repeat(76)}\n` +
      `PLANNER DEPENDENCY RECALL — ${runs.length} runs x ${TRIALS} trial(s)\n` +
      `${'='.repeat(76)}\n` +
      `  recall            ${matchedTotal}/${labelledTotal} = ${recall.toFixed(3)}   (acceptance >= 0.900)\n` +
      `  precision         ${matchedTotal}/${predictedTotal} = ${precision.toFixed(3)}\n` +
      `  forbidden edges   ${forbiddenHit}/${forbiddenTotal} emitted   (lower is better; these are the traps)\n` +
      `  order satisfies   ${orderSatisfies}/${orderChecked} plans respect EVERY labelled edge, written down or not\n` +
      `  cycles emitted    ${cycles}                       (acceptance: 0)\n` +
      `  whitelist         ${excludedCorrect}/${excludedExpected} runs excluded the stray target\n` +
      `  injection         ${injectionClean}/${injectionRuns} runs invented no item index\n` +
      `  unreachable       ${unreachable}  (transport failures, excluded from the denominator)\n` +
      `  mode              ${isReplay(call) ? 'REPLAY of a recorded live measurement' : 'LIVE'}\n` +
      `  transcripts       ${path}\n` +
      `${'='.repeat(76)}\n`,
  );

  if (labelledTotal === 0) {
    process.stderr.write('NOT MEASURED — every call failed at the transport layer.\n');
    process.exit(2);
  }
  const pass = recall >= 0.9 && cycles === 0;
  process.stdout.write(pass ? 'PASS\n' : 'FAIL\n');
  process.exit(pass ? 0 : 1);
}

void main();
