// Shared handler contract.
//
// Every handler is keyed `(runId, itemIdx, phase)` and must be safe to re-run:
// BullMQ re-picks a stalled job after ~30s (gap G-26), so "runs exactly once" is
// not available. "Re-running changes nothing" is, and that is what these
// skeletons are shaped to deliver.

import type { ConvoyJobData } from '../queue.js';
import type { CriticPort, PlannerPort } from '../orchestrator.js';

export interface HandlerContext {
  readonly data: ConvoyJobData;
  /** Cooperative abort — set when the run is aborted or the worker is shutting down. */
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
}

export interface ProductionAi {
  readonly planner?: PlannerPort;
  readonly critic?: CriticPort;
  readonly plannerFallback: boolean;
  readonly criticFallback: boolean;
}

/** Compose the existing Planner/Critic modules for the production lifecycle. */
export async function composeProductionAi(log: (message: string) => void): Promise<ProductionAi> {
  const { planRun } = await import('@convoy/ai/planner');
  const { createConfiguredLlmCaller } = await import('@convoy/ai/provider');
  const { critiqueAction } = await import('@convoy/ai/critic');
  let call: ReturnType<typeof createConfiguredLlmCaller> | undefined;
  try {
    call = createConfiguredLlmCaller();
  } catch (error) {
    log(
      `AI fallback active: ${error instanceof Error ? error.message : String(error)}; ` +
        'Planner=deterministic, Critic=simulator-only',
    );
  }
  const planner: PlannerPort = async (input) => {
    const result = await planRun(
      {
        budgetUsdc: input.budgetUsdc,
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        items: input.items.map((item) => ({
          idx: item.idx,
          target: item.target,
          functionName: item.functionName,
          functionArgs: item.functionArgs,
          evidence: item.evidence,
        })),
      },
      call,
      {
        whitelist: ['RewardDistributor', 'ConvoyRegistry'],
        declaredEdges: input.items.flatMap((item) =>
          item.dependsOn.map((dependsOn) => ({ idx: item.idx, dependsOn })),
        ),
      },
    );
    return result.plan;
  };

  const critic: CriticPort = async (action, facts) => {
    const result = await critiqueAction(action, call, facts);
    return result.final;
  };
  const fallback = call === undefined;
  return { planner, critic, plannerFallback: fallback, criticFallback: fallback };
}

/** Production handlers share the single runBatch/orchestrator path. */
export async function runProductionLifecycle(ctx: HandlerContext): Promise<HandlerResult> {
  const { runBatch, khFromEnv } = await import('../runBatch.js');
  const registryAddr = process.env['CONVOY_REGISTRY_ADDR'];
  if (registryAddr === undefined || registryAddr === '') {
    throw new Error('CONVOY_REGISTRY_ADDR is not set');
  }
  const ai = await composeProductionAi(ctx.log);
  const result = await runBatch(
    {
      kh: khFromEnv(),
      registryAddr,
      log: ctx.log,
      ...(ai.critic === undefined ? {} : { critic: ai.critic }),
    },
    ctx.data.runId,
    {
      ...(ai.planner === undefined ? {} : { planner: ai.planner }),
    },
  );
  return { outcome: 'done', detail: `${result.status} run ${result.runId}` };
}

export interface HandlerResult {
  /** `skipped` means the work was already done — the idempotent re-run path. */
  readonly outcome: 'done' | 'skipped';
  readonly detail: string;
}

export type PhaseHandler = (ctx: HandlerContext) => Promise<HandlerResult>;

/** Throw from a handler when the run was aborted mid-flight. */
export class AbortedError extends Error {
  constructor(phase: string) {
    super(`run aborted during ${phase}`);
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(ctx: HandlerContext): void {
  if (ctx.signal.aborted) throw new AbortedError(ctx.data.phase);
}
