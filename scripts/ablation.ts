#!/usr/bin/env tsx

/**
 * CVY-016 ablation harness.
 *
 * The default command is deliberately offline: it validates the committed
 * action set, prepares the three run shapes, and prints the exact metrics and
 * live-write plan that would be used. A live run requires the explicit
 * CONVOY_ABLATION_LIVE=1 guard enabled only by an authorised session.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Prisma, unsafeRawClient as prisma } from '@convoy/db';
import { encodeArgs, payloadHash } from '@convoy/kh-client';
import type { AbiArgValue } from '@convoy/kh-client';
import type { Address } from 'viem';

import type { CriticPort, PlannerPort } from '../services/worker/src/orchestrator.js';

export const ABLE_CHAIN_ID = '84532';
export const DEFAULT_FIXTURE = 'tests/fixtures/ablation.batch.json';

export type AblationMode = 'baseline' | 'planner' | 'critic';

export interface AblationItem {
  readonly idx: number;
  readonly target: string;
  readonly functionName: string;
  readonly argTypes: readonly string[];
  readonly functionArgs: readonly unknown[];
  readonly evidence: string;
  readonly dependsOn: readonly number[];
  /** A label used only to group observed ledger outcomes. */
  readonly intendedInvalid?: boolean;
}

export interface AblationFixture {
  readonly version: 1;
  readonly chainId: string;
  readonly budgetUsdc: string;
  readonly target: { readonly name: string; readonly addressEnv: string };
  readonly items: readonly AblationItem[];
}

export interface PreparedMode {
  readonly mode: AblationMode;
  readonly plan: {
    readonly source: string;
    readonly order: readonly number[];
    readonly deferrals: readonly { idx: number; dependsOn: number }[];
  };
  readonly items: readonly AblationItem[];
  readonly gate: 'normal' | 'bypassed';
}

export interface LedgerAttempt {
  readonly itemIdx: number;
  readonly kind: 'SIMULATE' | 'COMMIT' | 'EXECUTE';
  readonly status?: string | null;
  readonly txHash?: string | null;
  readonly gasUsedWei?: string | null;
  readonly gasUsedUsdc?: string | null;
  readonly errorCode?: string | null;
}

export interface LedgerItem {
  readonly idx: number;
  readonly state: string;
  readonly dependsOn: readonly number[];
  readonly intendedInvalid?: boolean;
}

export interface LedgerSnapshot {
  readonly budgetUsdc: string;
  readonly spentGasUsdc: string;
  readonly spentPayUsdc?: string;
  readonly items: readonly LedgerItem[];
  readonly attempts: readonly LedgerAttempt[];
}

export interface AblationMetrics {
  readonly landedItemRate: number;
  readonly landedItems: number;
  readonly submittedItems: number;
  readonly failedOrRevertedItems: number;
  readonly wastedGasEvents: number;
  readonly wastedGasUsdc: string;
  readonly budgetSpentUsdc: string;
  readonly budgetDifferenceUsdc?: string;
  readonly invalidSubmissions: number;
  readonly starvedDependents: number;
}

export interface ParsedArgs {
  readonly mode: AblationMode;
  readonly fixturePath: string;
  readonly execute: boolean;
  readonly baselineSnapshot?: string;
  readonly snapshot?: string;
  readonly planInput?: string;
  readonly planOutput?: string;
  readonly output?: string;
  readonly resumeRun?: string;
}

interface LiveEvidence {
  readonly mode: AblationMode;
  readonly chainId: string;
  readonly distributorAddress: string;
  readonly runId: string;
  readonly runIdOnchain: string;
  readonly openTx?: string;
  readonly sealTx?: string;
  readonly criticConsulted: boolean;
  readonly plan: unknown;
  readonly snapshot: LedgerSnapshot;
  readonly metrics: AblationMetrics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decimal(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error(`${name} must be a decimal string with at most 6 fractional digits`);
  }
  return value;
}

function assertAcyclic(items: readonly AblationItem[]): void {
  const state = new Map<number, 0 | 1 | 2>();
  const deps = new Map(items.map((item) => [item.idx, item.dependsOn]));
  const visit = (idx: number): void => {
    const mark = state.get(idx) ?? 0;
    if (mark === 1) throw new Error(`fixture dependency cycle includes item ${idx}`);
    if (mark === 2) return;
    state.set(idx, 1);
    for (const dependency of deps.get(idx) ?? []) visit(dependency);
    state.set(idx, 2);
  };
  for (const item of items) visit(item.idx);
}

export function validateFixture(raw: unknown): AblationFixture {
  if (!isRecord(raw)) throw new Error('fixture must be an object');
  if (raw['version'] !== 1) throw new Error('fixture version must be 1');
  if (raw['chainId'] !== ABLE_CHAIN_ID) throw new Error(`fixture chainId must be ${ABLE_CHAIN_ID}`);
  const budgetUsdc = decimal(raw['budgetUsdc'], 'budgetUsdc');
  const targetRaw = raw['target'];
  if (
    !isRecord(targetRaw) ||
    typeof targetRaw['name'] !== 'string' ||
    typeof targetRaw['addressEnv'] !== 'string'
  ) {
    throw new Error('fixture target must contain name and addressEnv');
  }
  const rawItems = raw['items'];
  if (!Array.isArray(rawItems) || rawItems.length === 0)
    throw new Error('fixture items must be non-empty');
  const items: AblationItem[] = rawItems.map((value, position) => {
    if (!isRecord(value)) throw new Error(`item ${position} must be an object`);
    const idx = value['idx'];
    if (!Number.isInteger(idx) || (idx as number) < 0)
      throw new Error(`item ${position} has invalid idx`);
    const argTypes = value['argTypes'];
    const functionArgs = value['functionArgs'];
    if (!Array.isArray(argTypes) || !argTypes.every((a) => typeof a === 'string')) {
      throw new Error(`item ${idx} argTypes must be an array of strings`);
    }
    if (!Array.isArray(functionArgs) || argTypes.length !== functionArgs.length) {
      throw new Error(`item ${idx} argTypes/functionArgs length mismatch`);
    }
    const dependsOn = value['dependsOn'] ?? [];
    if (!Array.isArray(dependsOn) || !dependsOn.every((d) => Number.isInteger(d) && d >= 0)) {
      throw new Error(`item ${idx} dependsOn must contain non-negative integer indices`);
    }
    return {
      idx: idx as number,
      target: typeof value['target'] === 'string' ? value['target'] : (targetRaw['name'] as string),
      functionName:
        typeof value['functionName'] === 'string'
          ? value['functionName']
          : (() => {
              throw new Error(`item ${idx} functionName is required`);
            })(),
      argTypes: argTypes as string[],
      functionArgs,
      evidence:
        typeof value['evidence'] === 'string'
          ? value['evidence']
          : (() => {
              throw new Error(`item ${idx} evidence is required`);
            })(),
      dependsOn: dependsOn as number[],
      ...(value['intendedInvalid'] === true ? { intendedInvalid: true } : {}),
    };
  });
  const indices = items.map((item) => item.idx);
  if (new Set(indices).size !== indices.length)
    throw new Error('fixture item indices must be unique');
  const expected = [...Array(items.length).keys()];
  if (indices.some((idx) => !expected.includes(idx)))
    throw new Error('fixture indices must be contiguous from 0');
  const known = new Set(indices);
  for (const item of items)
    for (const dependency of item.dependsOn) {
      if (!known.has(dependency))
        throw new Error(`item ${item.idx} depends on unknown item ${dependency}`);
      if (dependency === item.idx) throw new Error(`item ${item.idx} cannot depend on itself`);
    }
  assertAcyclic(items);
  return {
    version: 1,
    chainId: ABLE_CHAIN_ID,
    budgetUsdc,
    target: { name: targetRaw['name'] as string, addressEnv: targetRaw['addressEnv'] as string },
    items: items.sort((a, b) => a.idx - b.idx),
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let mode: AblationMode = 'baseline';
  let fixturePath = DEFAULT_FIXTURE;
  let execute = false;
  let baselineSnapshot: string | undefined;
  let snapshot: string | undefined;
  let planInput: string | undefined;
  let planOutput: string | undefined;
  let output: string | undefined;
  let resumeRun: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ablate-planner') {
      if (mode !== 'baseline') throw new Error('choose only one ablation mode');
      mode = 'planner';
    } else if (arg === '--ablate-critic') {
      if (mode !== 'baseline') throw new Error('choose only one ablation mode');
      mode = 'critic';
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--fixture') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--fixture requires a path');
      fixturePath = value;
    } else if (arg === '--baseline-snapshot') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--baseline-snapshot requires a path');
      baselineSnapshot = value;
    } else if (arg === '--snapshot') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--snapshot requires a path');
      snapshot = value;
    } else if (arg === '--plan-input') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--plan-input requires a path');
      planInput = value;
    } else if (arg === '--plan-output') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--plan-output requires a path');
      planOutput = value;
    } else if (arg === '--output') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--output requires a path');
      output = value;
    } else if (arg === '--resume-run') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--resume-run requires a run id');
      resumeRun = value;
    } else if (arg === '--help') {
      throw new Error(
        'usage: ablation.ts [--ablate-planner|--ablate-critic] [--fixture path] [--snapshot path] [--baseline-snapshot path] [--plan-input path] [--plan-output path] [--output path] [--resume-run id] [--execute]',
      );
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return {
    mode,
    fixturePath,
    execute,
    ...(baselineSnapshot === undefined ? {} : { baselineSnapshot }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(planInput === undefined ? {} : { planInput }),
    ...(planOutput === undefined ? {} : { planOutput }),
    ...(output === undefined ? {} : { output }),
    ...(resumeRun === undefined ? {} : { resumeRun }),
  };
}

export function prepareModeFixture(fixture: AblationFixture, mode: AblationMode): PreparedMode {
  const items = fixture.items.map((item) => ({
    ...item,
    dependsOn: mode === 'planner' ? [] : item.dependsOn,
  }));
  return {
    mode,
    items,
    plan: {
      source:
        mode === 'baseline'
          ? 'planner-required'
          : mode === 'planner'
            ? 'ablation-planner'
            : 'planner-required',
      order: mode === 'planner' ? items.map((item) => item.idx) : topologicalOrder(items),
      deferrals:
        mode === 'planner'
          ? []
          : items.flatMap((item) =>
              item.dependsOn.map((dependsOn) => ({ idx: item.idx, dependsOn })),
            ),
    },
    gate: mode === 'critic' ? 'bypassed' : 'normal',
  };
}

function topologicalOrder(items: readonly AblationItem[]): number[] {
  const remaining = new Map(items.map((item) => [item.idx, new Set(item.dependsOn)]));
  const out: number[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([idx]) => idx)
      .sort((a, b) => a - b);
    if (ready.length === 0) throw new Error('fixture dependency cycle');
    for (const idx of ready) remaining.delete(idx);
    for (const deps of remaining.values()) for (const idx of ready) deps.delete(idx);
    out.push(...ready);
  }
  return out;
}

function positive(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && Number(value) > 0;
}

export function computeMetrics(
  snapshot: LedgerSnapshot,
  baseline?: LedgerSnapshot,
): AblationMetrics {
  const submitted = new Set(
    snapshot.attempts
      .filter((attempt) => attempt.kind === 'EXECUTE')
      .map((attempt) => attempt.itemIdx),
  );
  const landedItems = snapshot.items.filter(
    (item) => item.state === 'LANDED' && submitted.has(item.idx),
  ).length;
  const failedOrRevertedItems = new Set([
    ...snapshot.items.filter((item) => item.state === 'FAILED').map((item) => item.idx),
    ...snapshot.attempts
      .filter((attempt) => attempt.kind === 'EXECUTE' && attempt.status === 'failed')
      .map((attempt) => attempt.itemIdx),
  ]).size;
  const failedExec = snapshot.attempts.filter(
    (attempt) => attempt.kind === 'EXECUTE' && attempt.status === 'failed',
  );
  const wastedGasEvents = failedExec.filter(
    (attempt) => positive(attempt.gasUsedUsdc) || positive(attempt.gasUsedWei),
  ).length;
  const wastedGasUsdc = failedExec
    .reduce((sum, attempt) => sum + Number(attempt.gasUsedUsdc ?? 0), 0)
    .toFixed(6);
  const landed = new Set(
    snapshot.items.filter((item) => item.state === 'LANDED').map((item) => item.idx),
  );
  const starvedDependents = snapshot.items.filter(
    (item) =>
      item.dependsOn.length > 0 &&
      item.state !== 'LANDED' &&
      item.dependsOn.some((dependency) => !landed.has(dependency)),
  ).length;
  // The persisted run meter includes open, commit, target and seal writes.
  // `spentPayUsdc` is reserved for the future x402 leg and must not be folded
  // into the gas-consumption metric.
  const budgetSpentUsdc = new Prisma.Decimal(snapshot.spentGasUsdc).toFixed(6);
  const baselineSpent =
    baseline === undefined ? undefined : new Prisma.Decimal(baseline.spentGasUsdc);
  return {
    landedItemRate: submitted.size === 0 ? 0 : landedItems / submitted.size,
    landedItems,
    submittedItems: submitted.size,
    failedOrRevertedItems,
    wastedGasEvents,
    wastedGasUsdc,
    budgetSpentUsdc,
    ...(baselineSpent === undefined
      ? {}
      : {
          budgetDifferenceUsdc: new Prisma.Decimal(budgetSpentUsdc).sub(baselineSpent).toFixed(6),
        }),
    invalidSubmissions: snapshot.items.filter(
      (item) =>
        item.intendedInvalid &&
        snapshot.attempts.some(
          (attempt) => attempt.itemIdx === item.idx && attempt.kind === 'EXECUTE',
        ),
    ).length,
    starvedDependents,
  };
}

export function expectedWriteCount(fixture: AblationFixture): number {
  return 2 + fixture.items.length * 2;
}

function printPrepared(
  prepared: PreparedMode,
  fixture: AblationFixture,
  metrics?: AblationMetrics,
): void {
  console.log(`mode=${prepared.mode} chainId=${fixture.chainId}`);
  console.log(
    `plan source=${prepared.plan.source} order=${JSON.stringify(prepared.plan.order)} deferrals=${JSON.stringify(prepared.plan.deferrals)}`,
  );
  console.log(`gate=${prepared.gate}`);
  if (metrics === undefined) {
    console.log('metrics=NOT MEASURED — no ledger snapshot supplied; live authorization required');
  } else {
    console.log(JSON.stringify(metrics, null, 2));
  }
  console.log(
    `expected KeeperHub writes for this run=${expectedWriteCount(fixture)} (open + seal + commit/target per item)`,
  );
}

function loadEnvFile(): void {
  try {
    for (const raw of readFileSync(resolve('.env'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const equals = line.indexOf('=');
      if (equals < 1) continue;
      const key = line.slice(0, equals);
      if (process.env[key] === undefined) process.env[key] = line.slice(equals + 1).trim();
    }
  } catch {
    // The live operator may provide all values through the environment.
  }
}

function writeJson(path: string, value: unknown): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function distributorAddress(value: string | undefined): Address {
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('MOCK_DISTRIBUTOR_ADDR must be a deployed address for this mode');
  }
  return value as Address;
}

async function createLiveRun(
  fixture: AblationFixture,
  prepared: PreparedMode,
  storedPlan: unknown,
  distributor: Address,
): Promise<string> {
  const items = prepared.items.map((item) => ({
    idx: item.idx,
    targetAddr: Buffer.from(distributor.slice(2), 'hex'),
    functionName: item.functionName,
    functionArgs: item.functionArgs as Prisma.InputJsonValue,
    payloadHash: Buffer.from(
      payloadHash({
        target: distributor,
        functionName: item.functionName,
        encodedArgs: encodeArgs(item.argTypes, item.functionArgs as readonly AbiArgValue[]),
        idx: item.idx,
      }).slice(2),
      'hex',
    ),
    evidence: item.evidence,
    state: 'PENDING',
    dependsOn: [...item.dependsOn],
  }));
  const run = await prisma.run.create({
    data: {
      status: 'RECEIVED',
      budgetUsdc: new Prisma.Decimal(fixture.budgetUsdc),
      runEthUsd: new Prisma.Decimal(process.env['CONVOY_ETH_USD'] ?? '3400'),
      ...(storedPlan === undefined ? {} : { plan: storedPlan as Prisma.InputJsonValue }),
      items: { create: items },
      events: {
        create: {
          type: 'RUN_RECEIVED',
          payload: {
            itemCount: items.length,
            budgetUsdc: fixture.budgetUsdc,
            ablation: prepared.mode,
          },
        },
      },
    },
  });
  return run.id;
}

async function readLiveSnapshot(
  runId: string,
  fixture: AblationFixture,
): Promise<{
  readonly snapshot: LedgerSnapshot;
  readonly plan: unknown;
  readonly runIdOnchain?: string;
  readonly openTx?: string;
  readonly sealTx?: string;
  readonly criticConsulted: boolean;
}> {
  const [run, items, attempts, events] = await Promise.all([
    prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    prisma.item.findMany({ where: { runId }, orderBy: { idx: 'asc' } }),
    prisma.attempt.findMany({
      where: { item: { runId } },
      include: { item: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.event.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
  ]);
  const snapshot: LedgerSnapshot = {
    budgetUsdc: run.budgetUsdc.toString(),
    spentGasUsdc: run.spentGasUsdc.toString(),
    spentPayUsdc: run.spentPayUsdc.toString(),
    items: items.map((item) => ({
      idx: item.idx,
      state: item.state,
      dependsOn: item.dependsOn,
      ...(fixture.items[item.idx]?.intendedInvalid === true ? { intendedInvalid: true } : {}),
    })),
    attempts: attempts.map((attempt) => ({
      itemIdx: attempt.item.idx,
      kind: attempt.kind as LedgerAttempt['kind'],
      status: attempt.khStatus,
      txHash: attempt.txHash === null ? null : `0x${attempt.txHash.toString('hex')}`,
      gasUsedWei: attempt.gasUsedWei?.toString() ?? null,
      gasUsedUsdc: attempt.gasUsedUsdc?.toString() ?? null,
      errorCode: attempt.errorCode,
    })),
  };
  const payloadFor = (types: readonly string[]): Record<string, unknown> | undefined => {
    const event = [...events].reverse().find((candidate) => types.includes(candidate.type));
    return event?.payload !== null &&
      typeof event?.payload === 'object' &&
      !Array.isArray(event?.payload)
      ? (event.payload as Record<string, unknown>)
      : undefined;
  };
  const opened = payloadFor(['RUN_OPENED']);
  const sealed = payloadFor(['RUN_SEALED', 'RUN_SEALED_PARTIAL']);
  const executionReady = [...events]
    .reverse()
    .find((event) => event.itemIdx === null && event.type === 'PLAN_READY');
  const executionPayload =
    executionReady?.payload !== null &&
    typeof executionReady?.payload === 'object' &&
    !Array.isArray(executionReady?.payload)
      ? (executionReady.payload as Record<string, unknown>)
      : undefined;
  const stringValue = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    snapshot,
    plan: run.plan,
    criticConsulted: executionPayload?.['criticConsulted'] === true,
    ...(run.runIdOnchain === null ? {} : { runIdOnchain: `0x${run.runIdOnchain.toString('hex')}` }),
    ...(stringValue(opened?.['txHash']) === undefined
      ? {}
      : { openTx: stringValue(opened?.['txHash']) }),
    ...(stringValue(sealed?.['txHash']) === undefined
      ? {}
      : { sealTx: stringValue(sealed?.['txHash']) }),
  };
}

async function composeLiveAi(log: (message: string) => void): Promise<{
  readonly planner: PlannerPort;
  readonly critic: CriticPort;
}> {
  const { planRun } = await import('../packages/ai/dist/planner/index.js');
  const { createConfiguredLlmCaller } = await import('../packages/ai/dist/provider.js');
  const { critiqueAction } = await import('../packages/ai/dist/critic/index.js');
  const base = createConfiguredLlmCaller();
  const call: Parameters<typeof planRun>[1] = async (request) => {
    let last: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await base(request);
      } catch (error) {
        last = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable =
          message.includes('429') ||
          message.includes('fetch failed') ||
          /aborted|timeout/i.test(message);
        if (!retryable || attempt === 5) throw error;
        const waitMs = 5_000 * (attempt + 1);
        log(`AI transport unavailable (${message.slice(0, 80)}); retrying in ${waitMs / 1000}s`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
      }
    }
    throw last;
  };
  if (call === undefined) throw new Error('LLM caller unavailable');
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
  return { planner, critic };
}

async function executeLive(
  fixture: AblationFixture,
  prepared: PreparedMode,
  storedPlan: PreparedMode['plan'] | undefined,
  baseline: LedgerSnapshot | undefined,
  args: ParsedArgs,
): Promise<LiveEvidence> {
  loadEnvFile();
  if (process.env['CONVOY_ABLATION_LIVE'] !== '1') {
    throw new Error('live ablation requires CONVOY_ABLATION_LIVE=1');
  }
  const registry = process.env['CONVOY_REGISTRY_ADDR'];
  if (registry === undefined || registry === '') throw new Error('CONVOY_REGISTRY_ADDR is not set');
  const distributor = distributorAddress(process.env['MOCK_DISTRIBUTOR_ADDR']);
  const { runBatch, khFromEnv } = await import('../services/worker/src/runBatch.js');
  const log = (message: string): void => console.log(`[${prepared.mode}] ${message}`);
  const ai = await composeLiveAi(log);
  if (prepared.mode === 'critic' && storedPlan === undefined) {
    throw new Error('critic ablation requires --plan-input from the baseline run');
  }

  // Prove the real Planner path before opening a fresh onchain run. Production
  // may safely degrade to a deterministic plan, but that fallback is not valid
  // CVY-016 baseline evidence and must not consume fresh distributor state.
  let livePlan: unknown = storedPlan;
  if (prepared.mode === 'baseline' && args.resumeRun === undefined && storedPlan === undefined) {
    const planned = await ai.planner({
      runId: 'cvy-016-planner-preflight',
      budgetUsdc: fixture.budgetUsdc,
      items: fixture.items.map((item) => ({
        idx: item.idx,
        target: item.target,
        functionName: item.functionName,
        functionArgs: item.functionArgs,
        evidence: item.evidence,
        dependsOn: item.dependsOn,
      })),
    });
    if (!isRecord(planned) || planned['source'] !== 'planner') {
      const source = isRecord(planned) ? String(planned['source']) : 'invalid';
      throw new Error(`baseline Planner preflight did not produce a real plan (source=${source})`);
    }
    livePlan = planned;
  }

  const runId = args.resumeRun ?? (await createLiveRun(fixture, prepared, livePlan, distributor));
  if (args.resumeRun !== undefined) {
    const resume = await prisma.run.findUniqueOrThrow({
      where: { id: runId },
      include: { items: { orderBy: { idx: 'asc' } } },
    });
    const target = Buffer.from(distributor.slice(2), 'hex');
    if (
      resume.items.length !== fixture.items.length ||
      resume.items.some((item) => !item.targetAddr.equals(target))
    ) {
      throw new Error(`resume run ${runId} does not match this ablation fixture/distributor`);
    }
  }
  const result = await runBatch(
    {
      kh: khFromEnv(),
      registryAddr: registry,
      log,
      ...(prepared.mode === 'critic' || ai.critic === undefined ? {} : { critic: ai.critic }),
    },
    runId,
    {
      ...(prepared.mode === 'baseline' ? {} : { ablation: prepared.mode }),
      ...(prepared.mode === 'planner' || storedPlan !== undefined || ai.planner === undefined
        ? {}
        : { planner: ai.planner }),
    },
  );
  const live = await readLiveSnapshot(runId, fixture);
  const metrics = computeMetrics(live.snapshot, baseline);
  const plan = live.plan;
  if (prepared.mode === 'baseline') {
    const source = isRecord(plan) ? plan['source'] : undefined;
    if (source !== 'planner')
      throw new Error(`baseline did not use the Planner (source=${String(source)})`);
  }
  if (prepared.mode !== 'critic' && !live.criticConsulted) {
    throw new Error(`${prepared.mode} run completed without a real Critic verdict`);
  }
  if (prepared.mode === 'critic' && live.criticConsulted) {
    throw new Error('critic ablation unexpectedly consulted the Critic');
  }
  const evidence: LiveEvidence = {
    mode: prepared.mode,
    chainId: fixture.chainId,
    distributorAddress: distributor,
    runId,
    runIdOnchain: live.runIdOnchain ?? result.runIdOnchain,
    ...(live.openTx === undefined ? {} : { openTx: live.openTx }),
    ...(live.sealTx === undefined ? {} : { sealTx: live.sealTx }),
    criticConsulted: live.criticConsulted,
    plan,
    snapshot: live.snapshot,
    metrics,
  };
  if (args.output !== undefined) writeJson(args.output, evidence);
  if (args.planOutput !== undefined) writeJson(args.planOutput, plan);
  return evidence;
}

function loadPreparedPlan(path: string, fixture: AblationFixture): PreparedMode['plan'] {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw['order']) || !Array.isArray(raw['deferrals'])) {
    throw new Error('plan input must contain validated order and deferrals arrays');
  }
  const known = new Set(fixture.items.map((item) => item.idx));
  const order = raw['order'];
  if (!order.every((idx) => Number.isInteger(idx) && known.has(idx as number))) {
    throw new Error('plan input order contains an unknown item');
  }
  const deferrals = raw['deferrals'].map((value, at) => {
    if (
      !isRecord(value) ||
      !Number.isInteger(value['idx']) ||
      !Number.isInteger(value['dependsOn'])
    ) {
      throw new Error(`plan input deferral ${at} is invalid`);
    }
    const edge = { idx: value['idx'] as number, dependsOn: value['dependsOn'] as number };
    if (!known.has(edge.idx) || !known.has(edge.dependsOn))
      throw new Error('plan input contains an unknown dependency');
    return edge;
  });
  return {
    source: typeof raw['source'] === 'string' ? raw['source'] : 'planner',
    order: order as number[],
    deferrals,
  };
}

function loadLedgerSnapshot(path: string): LedgerSnapshot {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error('snapshot artifact must be an object');
  const candidate = isRecord(raw['snapshot']) ? raw['snapshot'] : raw;
  if (
    typeof candidate['budgetUsdc'] !== 'string' ||
    typeof candidate['spentGasUsdc'] !== 'string' ||
    !Array.isArray(candidate['items']) ||
    !Array.isArray(candidate['attempts'])
  ) {
    throw new Error('snapshot artifact does not contain a ledger snapshot');
  }
  return candidate as unknown as LedgerSnapshot;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const fixture = validateFixture(JSON.parse(readFileSync(resolve(args.fixturePath), 'utf8')));
  const storedPlan =
    args.mode !== 'planner' && args.planInput === undefined
      ? undefined
      : args.mode !== 'planner' && args.planInput !== undefined
        ? loadPreparedPlan(args.planInput, fixture)
        : undefined;
  let prepared = prepareModeFixture(fixture, args.mode);
  if (storedPlan !== undefined) prepared = { ...prepared, plan: storedPlan };

  const baseline =
    args.baselineSnapshot === undefined ? undefined : loadLedgerSnapshot(args.baselineSnapshot);

  if (args.execute) {
    const evidence = await executeLive(fixture, prepared, storedPlan, baseline, args);
    printPrepared(prepared, fixture, evidence.metrics);
    console.log(`runId=${evidence.runId}`);
    console.log(`distributor=${evidence.distributorAddress}`);
    console.log(`openTx=${evidence.openTx ?? 'not recorded'}`);
    console.log(`sealTx=${evidence.sealTx ?? 'not recorded'}`);
    await prisma.$disconnect();
    return;
  }

  if (args.planOutput !== undefined) {
    writeFileSync(resolve(args.planOutput), `${JSON.stringify(prepared.plan, null, 2)}\n`, 'utf8');
  }
  let metrics: AblationMetrics | undefined;
  if (args.snapshot !== undefined) {
    metrics = computeMetrics(loadLedgerSnapshot(args.snapshot), baseline);
  } else if (args.baselineSnapshot !== undefined) {
    throw new Error(
      '--baseline-snapshot requires --snapshot so the budget difference has a measured subject',
    );
  }
  if (args.output !== undefined) {
    writeFileSync(
      resolve(args.output),
      `${JSON.stringify({ mode: args.mode, chainId: fixture.chainId, plan: prepared.plan, metrics: metrics ?? null }, null, 2)}\n`,
      'utf8',
    );
  }
  printPrepared(prepared, fixture, metrics);
  console.log(
    'OFFLINE ONLY — no KeeperHub request, contract deployment, gas spend, or database mutation performed.',
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
