/**
 * No-write GenLayer provider preflight.
 *
 * Runs the real Convoy Planner and Critic prompts through the configured
 * accountless simulation provider. It never opens a database run, calls
 * KeeperHub, touches Base, or submits a GenLayer transaction.
 */
import { critiqueAction } from '../src/critic/index.js';
import { createConfiguredLlmCaller } from '../src/provider.js';
import { planRun } from '../src/planner/index.js';

const call = createConfiguredLlmCaller();
const planner = await planRun(
  {
    budgetUsdc: '1.000000',
    items: [
      {
        idx: 0,
        target: 'RewardDistributor',
        functionName: 'setRoot',
        functionArgs: ['0x' + '11'.repeat(32)],
        evidence: 'Publish the new root before any funding action.',
      },
      {
        idx: 1,
        target: 'RewardDistributor',
        functionName: 'fund',
        functionArgs: ['1000000'],
        evidence: 'Fund 1.000000 USDC after the new root is published.',
      },
    ],
  },
  call,
  {
    whitelist: ['RewardDistributor'],
    declaredEdges: [{ idx: 1, dependsOn: 0 }],
  },
);
if (planner.plan.source !== 'planner') {
  throw new Error(`Planner preflight degraded to ${planner.plan.source}`);
}

const critic = await critiqueAction(
  {
    idx: 1,
    target: 'RewardDistributor',
    functionName: 'fund',
    functionArgs: ['1000000'],
    evidence: 'Fund 1.000000 USDC after the new root is published.',
    dependsOn: [{ idx: 0, landed: true }],
    gasBudgetUsdc: '0.500000',
    simulator: { wouldRevert: false, gasEstimate: '50000', budget: 'affordable' },
  },
  call,
  { wouldRevert: false, targetWhitelisted: true, budget: 'affordable' },
);
if (critic.model !== 'genlayer/bradbury-consensus') {
  throw new Error(`Critic preflight did not return a GenLayer model (${critic.model ?? 'none'})`);
}

console.log(
  JSON.stringify(
    {
      provider: 'genlayer',
      network: 'testnetBradbury',
      planner: { source: planner.plan.source, attempts: planner.plan.attempts },
      critic: { model: critic.model, consulted: critic.transcript.length > 0 },
      writes: 0,
      database: false,
      keeperHub: false,
      baseChain: false,
    },
    null,
    2,
  ),
);
