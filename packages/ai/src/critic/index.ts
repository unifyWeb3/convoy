// Critic agent — APPROVE/VETO grounded by a real KeeperHub simulate.
//
// A SECOND LLM, NOT A SECOND OPINION FROM THE FIRST. The Planner is asked what
// order to run things in; the Critic is asked whether one action is justified by
// its evidence, under its own instruction, with no sight of the Planner's. The
// two share a transport (planner/llm.ts) and nothing else.
//
// What this component adds over the simulator alone is one specific thing: the
// simulator answers "does this revert against current state", which funding 2x
// the amount the evidence names does not. That case simulates perfectly and is
// still wrong, and catching it is the entire justification for spending a model
// call here (Gou et al., CRITIC, ICLR 2024 — an external verifier plus a critic,
// because intrinsic self-correction is unreliable on its own).
//
// EVERYTHING THE MODEL SAYS PASSES THROUGH `corroborate` (corroborate.ts). The
// simulator wins every disagreement, in both directions. This file's job is to
// get a well-formed verdict out of a provider and hand it over; it decides
// nothing by itself.

import {
  buildRepairMessage,
  buildUserMessage,
  newFenceToken,
  SYSTEM_INSTRUCTION,
  type CriticInput,
} from './prompt.js';
import { CriticVerdictSchema, CRITIC_JSON_SCHEMA, type CriticVerdict } from './schema.js';
import { corroborate, type DeterministicFacts, type FinalVerdict } from './corroborate.js';
import { stripCodeFence } from '../planner/repair.js';
import type { LlmCaller } from '../planner/llm.js';

export type { CriticInput, SimulatorFinding } from './prompt.js';
export type { CriticVerdict, VetoReason } from './schema.js';
export { CriticVerdictSchema, CRITIC_JSON_SCHEMA, VETO_REASONS, NO_REASON } from './schema.js';
export { corroborate } from './corroborate.js';
export type { DeterministicFacts, FinalVerdict, VerdictSource } from './corroborate.js';
export {
  SYSTEM_INSTRUCTION,
  buildUserMessage,
  buildRepairMessage,
  fenceEvidence,
} from './prompt.js';

export interface ParseOutcome {
  readonly ok: boolean;
  readonly verdict?: CriticVerdict;
  readonly error?: string;
  readonly raw: string;
}

export function parseVerdict(raw: string): ParseOutcome {
  const text = stripCodeFence(raw);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      raw,
      error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = CriticVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, raw, error: `schema violation: ${detail}` };
  }

  return { ok: true, raw, verdict: parsed.data };
}

export interface CritiqueResult {
  readonly final: FinalVerdict;
  /** Did the FIRST response parse and validate? */
  readonly firstPassValid: boolean;
  /** Why the model verdict is missing, when it is. */
  readonly unavailableReason?: string;
  readonly transcript: readonly { role: string; content: string }[];
  readonly model?: string;
}

/**
 * Critique one action.
 *
 * NEVER THROWS FOR A MODEL FAILURE. An unreachable provider, a malformed
 * response twice over, a timeout — all degrade to `corroborate(undefined, …)`,
 * which is the simulator-only gate the card names as the fallback. The veto that
 * costs zero gas survives losing the model; the evidence judgement does not, and
 * `criticConsulted:false` says which one happened.
 *
 * Exactly one repair pass, for the same reason the Planner has exactly one: a
 * model that failed twice on the same input is not converging, and CRITIQUING
 * sits in front of every item in the batch.
 */
export async function critiqueAction(
  input: CriticInput,
  call: LlmCaller | undefined,
  facts: DeterministicFacts,
): Promise<CritiqueResult> {
  if (call === undefined) {
    return {
      final: corroborate(undefined, facts),
      firstPassValid: false,
      unavailableReason: 'no LLM caller configured',
      transcript: [],
    };
  }

  const fenceToken = newFenceToken();
  const messages = [
    { role: 'system' as const, content: SYSTEM_INSTRUCTION },
    { role: 'user' as const, content: buildUserMessage(input, fenceToken) },
  ];
  const transcript: { role: string; content: string }[] = [];

  let first: Awaited<ReturnType<LlmCaller>>;
  try {
    first = await call({
      messages,
      schemaName: 'convoy_critic_verdict',
      jsonSchema: CRITIC_JSON_SCHEMA,
    });
  } catch (e) {
    return {
      final: corroborate(undefined, facts),
      firstPassValid: false,
      unavailableReason: e instanceof Error ? e.message : String(e),
      transcript,
    };
  }
  transcript.push({ role: 'assistant', content: first.content });

  const firstParse = parseVerdict(first.content);
  if (firstParse.ok && firstParse.verdict !== undefined) {
    return {
      final: corroborate(firstParse.verdict, facts),
      firstPassValid: true,
      transcript,
      ...(first.model === undefined ? {} : { model: first.model }),
    };
  }

  // EXACTLY ONE repair pass.
  let repaired: Awaited<ReturnType<LlmCaller>>;
  try {
    repaired = await call({
      messages: [
        ...messages,
        { role: 'assistant' as const, content: first.content },
        {
          role: 'user' as const,
          content: buildRepairMessage(first.content, firstParse.error ?? 'unknown'),
        },
      ],
      schemaName: 'convoy_critic_verdict',
      jsonSchema: CRITIC_JSON_SCHEMA,
    });
  } catch (e) {
    return {
      final: corroborate(undefined, facts),
      firstPassValid: false,
      unavailableReason: `repair failed: ${e instanceof Error ? e.message : String(e)}`,
      transcript,
    };
  }
  transcript.push({ role: 'assistant', content: repaired.content });

  const second = parseVerdict(repaired.content);
  if (second.ok && second.verdict !== undefined) {
    return {
      final: corroborate(second.verdict, facts),
      firstPassValid: false,
      transcript,
      ...(repaired.model === undefined ? {} : { model: repaired.model }),
    };
  }

  // Two failures. The deterministic gate stands alone, and says so.
  return {
    final: corroborate(undefined, facts),
    firstPassValid: false,
    unavailableReason: `verdict invalid after repair: ${second.error ?? 'unknown'}`,
    transcript,
  };
}
