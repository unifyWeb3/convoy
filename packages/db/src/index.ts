// @convoy/db — Prisma client singleton and exported ledger types.
//
// Convoy's ledger of record and the third leg of the manifest's three-way
// reconciliation. Money is numeric(20,6) -> Prisma Decimal; wei is Decimal,
// never a float. `events` is append-only and its bigserial id is the SSE event
// id used for Last-Event-ID replay.

import { PrismaClient, Prisma } from '@prisma/client';

export { Prisma } from '@prisma/client';
export type {
  Run,
  Item,
  Attempt,
  Event,
  Manifest,
  PrismaClient as RawPrismaClient,
} from '@prisma/client';

/** Mutations forbidden on `events`. The log is append-only. */
const FORBIDDEN_EVENT_OPS = ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const;

export class AppendOnlyViolationError extends Error {
  constructor(operation: string) {
    super(
      `events is append-only — \`event.${operation}\` is not permitted. ` +
        'The bigserial id is the SSE event id used for Last-Event-ID replay; mutating or ' +
        'removing a row would silently corrupt every client replaying from that point, and the ' +
        'audit trail would no longer be a record of what happened.',
    );
    this.name = 'AppendOnlyViolationError';
  }
}

/**
 * Build the client with the append-only rule enforced at **runtime**.
 *
 * A types-only restriction is a suggestion: one `as any` and the log is
 * mutable. This throws instead, so the invariant survives contact with code
 * that has not read the comment.
 */
function createClient(): PrismaClient {
  const base = new PrismaClient({
    log: process.env['CONVOY_DB_LOG'] === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  return base.$extends({
    query: {
      event: Object.fromEntries(
        FORBIDDEN_EVENT_OPS.map((op) => [
          op,
          () => {
            throw new AppendOnlyViolationError(op);
          },
        ]),
      ),
    },
    // `$extends` returns a structurally different type; the append-only surface
    // is expressed separately by ConvoyDb below.
  }) as unknown as PrismaClient;
}

/**
 * The append-only view of `event`. Read and create; nothing else.
 *
 * Declared as a type as well as enforced at runtime so the restriction shows up
 * in editor completion rather than only at the moment something throws.
 */
export type AppendOnlyEventDelegate = Pick<
  PrismaClient['event'],
  'create' | 'createMany' | 'findFirst' | 'findMany' | 'findUnique' | 'count' | 'aggregate'
>;

/** Convoy's database surface: the full client, minus every path that mutates `events`. */
export type ConvoyDb = Omit<PrismaClient, 'event'> & { readonly event: AppendOnlyEventDelegate };

declare global {
  // Reused across hot reloads in dev so Next.js does not open a new pool per edit.
  // eslint-disable-next-line no-var
  var __convoyPrisma: PrismaClient | undefined;
}

const client = globalThis.__convoyPrisma ?? createClient();
if (process.env['NODE_ENV'] !== 'production') globalThis.__convoyPrisma = client;

export const db: ConvoyDb = client as ConvoyDb;

/**
 * The full `PrismaClient` surface — `$transaction`, `$queryRaw`, and every model
 * delegate — for migrations, seeds, orchestration and tests.
 *
 * **The append-only rule still applies.** This is the same underlying client, so
 * `event.update`/`delete` throw here too; the name says "unsafe" because it
 * bypasses the *typed* narrowing, not because it bypasses the guard. To remove
 * events, delete the owning run — the cascade is the only sanctioned path, and
 * it removes the whole audit trail rather than editing it.
 */
export const unsafeRawClient: PrismaClient = client;

// ---------------------------------------------------------------------------
// Ledger vocabulary — the frozen state and event names, in one place so a typo
// cannot invent a state that nothing else understands.
// ---------------------------------------------------------------------------

/**
 * Run statuses — verbatim from the frozen §5(i) machine:
 * `RECEIVED → OPENING → PLANNING → CRITIQUING → EXECUTING → SEALING →
 *  { SEALED_OK | SEALED_PARTIAL }`, `any → ABORTED`,
 * `OPENING/SEALING → FAILED_FATAL` (401/422).
 *
 * Corrected at CVY-007: the CVY-005 array omitted OPENING, CRITIQUING, SEALING
 * and FAILED_FATAL, and used `SEALED` where the machine says `SEALED_OK`.
 */
export const RUN_STATUS = [
  'RECEIVED',
  'OPENING',
  'PLANNING',
  'CRITIQUING',
  'EXECUTING',
  'SEALING',
  'SEALED_OK',
  'SEALED_PARTIAL',
  'ABORTED',
  'FAILED_FATAL',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/**
 * Item states — frozen §5(i). Terminal: LANDED, VETOED, FAILED,
 * **SKIPPED (budget-exhausted)**.
 *
 * Corrected at CVY-007: the CVY-005 array omitted `RETRYING` and `SKIPPED`.
 * `SKIPPED` is not an addition — §5(i) names it explicitly — and CVY-007 is the
 * milestone that produces it.
 */
export const ITEM_STATE = [
  'PENDING',
  'PLANNED',
  'SIMULATED',
  'VETOED',
  'COMMITTED',
  'SUBMITTED',
  'RETRYING',
  'LANDED',
  'FAILED',
  'DEFERRED',
  'SKIPPED',
] as const;

/** States from which no further work is attempted. */
export const TERMINAL_ITEM_STATES = ['LANDED', 'VETOED', 'FAILED', 'SKIPPED'] as const;
export type ItemState = (typeof ITEM_STATE)[number];

/** Attempt kinds. */
export const ATTEMPT_KIND = ['SIMULATE', 'COMMIT', 'EXECUTE'] as const;
export type AttemptKind = (typeof ATTEMPT_KIND)[number];

/** Event types, verbatim from architecture §5(h). */
export const EVENT_TYPE = [
  'RUN_RECEIVED',
  'RUN_OPENED',
  'PLAN_READY',
  'ITEM_SIMULATED',
  'ITEM_VETOED',
  'ITEM_COMMITTED',
  'ITEM_SUBMITTED',
  'ITEM_RETRY',
  'ITEM_LANDED',
  'ITEM_FAILED',
  'ITEM_DEFERRED',
  'BUDGET_LOW',
  'RUN_SEALED',
  'RUN_SEALED_PARTIAL',
] as const;
export type EventType = (typeof EVENT_TYPE)[number];

/** Veto reasons the Critic may return (architecture §5(d)). */
export const VETO_REASON = [
  'would_revert',
  'over_budget',
  'unmet_dependency',
  'evidence_mismatch',
] as const;
export type VetoReason = (typeof VETO_REASON)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `0x…` hex -> Bytes, for bytea columns (addresses, hashes, runIds). */
export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hexToBytes: odd-length hex ${JSON.stringify(hex)}`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`hexToBytes: not hex ${JSON.stringify(hex)}`);
  return Buffer.from(clean, 'hex');
}

/** Bytes -> `0x…` hex, for reads that cross back into the viem/KeeperHub world. */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/**
 * gas_used_usdc = (gasUsedWei / 1e18) * runEthUsd, in Decimal throughout.
 *
 * Deliberately not floating point: the intermediate `gasUsedWei / 1e18` is
 * exactly where a double silently loses precision, and this figure lands in the
 * budget meter and the exported manifest. On Base Sepolia the USD result is
 * notional (gap G-18) — the gas units are the real part.
 */
export function gasUsedUsdc(
  gasUsedWei: Prisma.Decimal | string | bigint,
  runEthUsd: Prisma.Decimal | string,
): Prisma.Decimal {
  const wei = new Prisma.Decimal(gasUsedWei.toString());
  const rate = new Prisma.Decimal(runEthUsd.toString());
  return wei.div(new Prisma.Decimal('1e18')).mul(rate);
}
