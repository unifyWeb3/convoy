/**
 * Asserts the applied Postgres schema matches docs/ARCHITECTURE.md §5(g)
 * exactly — read back from the live database, not from schema.prisma.
 *
 * Reading it back is the point: schema.prisma is what we asked for, and
 * information_schema is what we got. Only the second one is evidence.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

import { AppendOnlyViolationError, db, gasUsedUsdc, hexToBytes, bytesToHex } from '../src/index.js';

const raw = new PrismaClient();
afterAll(async () => {
  await raw.$disconnect();
});

interface Col {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
}

async function columns(table: string): Promise<Map<string, Col>> {
  const rows = await raw.$queryRaw<Col[]>`
    select table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}`;
  return new Map(rows.map((r) => [r.column_name, r]));
}

describe('the five frozen tables exist', () => {
  it('runs, items, attempts, events, manifests — and nothing invented', async () => {
    const rows = await raw.$queryRaw<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name not like '\\_prisma%'
      order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      'attempts',
      'events',
      'items',
      'manifests',
      'runs',
    ]);
  });
});

describe('type mapping — money is never a float', () => {
  it('every USDC column is numeric(20,6), not double precision', async () => {
    const money: [string, string][] = [
      ['runs', 'budget_usdc'],
      ['runs', 'spent_gas_usdc'],
      ['runs', 'spent_pay_usdc'],
      ['runs', 'run_eth_usd'],
      ['items', 'gas_budget_usdc'],
      ['attempts', 'gas_used_usdc'],
    ];
    for (const [table, col] of money) {
      const c = (await columns(table)).get(col);
      expect(c, `${table}.${col} missing`).toBeDefined();
      expect(`${table}.${col}:${c?.data_type}`).toBe(`${table}.${col}:numeric`);
      expect(c?.numeric_precision).toBe(20);
      expect(c?.numeric_scale).toBe(6);
    }
  });

  it('gas_used_wei is unconstrained numeric — wei does not fit in 20 digits', async () => {
    const c = (await columns('attempts')).get('gas_used_wei');
    expect(c?.data_type).toBe('numeric');
    expect(c?.numeric_precision).toBeNull();
  });

  it('bytea columns are bytea', async () => {
    const bytea: [string, string][] = [
      ['runs', 'run_id_onchain'],
      ['items', 'target_addr'],
      ['items', 'payload_hash'],
      ['attempts', 'tx_hash'],
      ['manifests', 'sha256'],
    ];
    for (const [table, col] of bytea) {
      expect(`${table}.${col}:${(await columns(table)).get(col)?.data_type}`).toBe(
        `${table}.${col}:bytea`,
      );
    }
  });

  it('jsonb columns are jsonb, not json or text', async () => {
    const jsonb: [string, string][] = [
      ['runs', 'plan'],
      ['items', 'function_args'],
      ['events', 'payload'],
      ['manifests', 'json'],
    ];
    for (const [table, col] of jsonb) {
      expect(`${table}.${col}:${(await columns(table)).get(col)?.data_type}`).toBe(
        `${table}.${col}:jsonb`,
      );
    }
  });

  it('depends_on is an integer array', async () => {
    expect((await columns('items')).get('depends_on')?.data_type).toBe('ARRAY');
  });

  it('events.id is bigint — it is the SSE event id, and it must not overflow', async () => {
    const c = (await columns('events')).get('id');
    expect(c?.data_type).toBe('bigint');
  });
});

describe('constraints and indexes the frozen design requires', () => {
  it('runs.run_id_onchain is unique — a run is opened exactly once', async () => {
    const rows = await raw.$queryRaw<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'runs'`;
    expect(rows.some((r) => /UNIQUE.*\(run_id_onchain\)/.test(r.indexdef))).toBe(true);
  });

  it('items is unique on (run_id, idx)', async () => {
    const rows = await raw.$queryRaw<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'items'`;
    expect(rows.some((r) => /UNIQUE.*\(run_id, idx\)/.test(r.indexdef))).toBe(true);
  });

  it('attempts is indexed on (item_id, attempt_no) — powers retry viz', async () => {
    const rows = await raw.$queryRaw<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'attempts'`;
    expect(rows.some((r) => /\(item_id, attempt_no\)/.test(r.indexdef))).toBe(true);
  });

  it('events is indexed on (run_id, at) — powers SSE replay', async () => {
    const rows = await raw.$queryRaw<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'events'`;
    expect(rows.some((r) => /\(run_id, "?at"?\)/.test(r.indexdef))).toBe(true);
  });

  it('the (run_id, idx) unique constraint actually rejects a duplicate', async () => {
    // Asserting the index exists proves the DDL ran. Asserting it *bites*
    // proves the constraint means something.
    const run = await raw.run.create({
      data: {
        status: 'RECEIVED',
        budgetUsdc: new Prisma.Decimal('1'),
        runEthUsd: new Prisma.Decimal('3400'),
      },
    });
    const item = {
      runId: run.id,
      idx: 0,
      targetAddr: Buffer.alloc(20),
      functionName: 'f',
      functionArgs: [] as Prisma.InputJsonValue,
      payloadHash: Buffer.alloc(32),
      evidence: 'e',
      state: 'PENDING',
    };
    await raw.item.create({ data: item });
    await expect(raw.item.create({ data: item })).rejects.toThrow();
    await raw.run.delete({ where: { id: run.id } });
  });
});

describe('events is append-only', () => {
  it('the SSE id is monotonic across inserts', async () => {
    const run = await raw.run.create({
      data: {
        status: 'RECEIVED',
        budgetUsdc: new Prisma.Decimal('1'),
        runEthUsd: new Prisma.Decimal('3400'),
      },
    });
    const a = await raw.event.create({
      data: { runId: run.id, type: 'RUN_RECEIVED', payload: {} },
    });
    const b = await raw.event.create({ data: { runId: run.id, type: 'RUN_OPENED', payload: {} } });
    expect(b.id > a.id).toBe(true);
    await raw.run.delete({ where: { id: run.id } });
  });

  for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const) {
    it(`event.${op} throws at RUNTIME, not just in types`, async () => {
      // A types-only restriction is one `as any` away from being ignored. This
      // is the check that survives that.
      const surface = db.event as unknown as Record<string, (a: unknown) => Promise<unknown>>;
      await expect(surface[op]?.({ where: { id: 1n } })).rejects.toBeInstanceOf(
        AppendOnlyViolationError,
      );
    });
  }

  it('create and findMany still work — append-only, not read-only', async () => {
    const run = await raw.run.create({
      data: {
        status: 'RECEIVED',
        budgetUsdc: new Prisma.Decimal('1'),
        runEthUsd: new Prisma.Decimal('3400'),
      },
    });
    await db.event.create({ data: { runId: run.id, type: 'PLAN_READY', payload: { ok: true } } });
    expect(await db.event.count({ where: { runId: run.id } })).toBe(1);
    await raw.run.delete({ where: { id: run.id } });
  });
});

describe('helpers', () => {
  it('hex round-trips through bytea', () => {
    const hex = `0x${'ab'.repeat(32)}`;
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  it('rejects malformed hex rather than silently truncating', () => {
    expect(() => hexToBytes('0xabc')).toThrow(/odd-length/);
    expect(() => hexToBytes('0xzz')).toThrow(/not hex/);
  });

  it('gasUsedUsdc computes the CVY-003 transaction correctly', () => {
    // 68400 wei at $3400. Decimal renders small magnitudes exponentially, so
    // pin the fixed form — that is what lands in the manifest and the meter.
    expect(gasUsedUsdc('68400', '3400').toFixed(20)).toBe('0.00000000023256000000');
  });

  it('keeps full precision where a float silently loses digits', () => {
    // 123456789012345678901 wei = 123.456789012345678901 ETH at $3400.
    const wei = '123456789012345678901';
    expect(gasUsedUsdc(wei, '3400').toString()).toBe('419753.08264197530826');

    // The same arithmetic in doubles. Number() cannot even hold the input:
    // the wei value is beyond 2^53, so digits are gone before the division.
    expect(Number(wei).toString()).not.toBe(wei);
    const viaFloat = ((Number(wei) / 1e18) * 3400).toString();
    expect(viaFloat).not.toBe(gasUsedUsdc(wei, '3400').toString());
  });

  it('accepts bigint and Decimal inputs, not just strings', () => {
    const fromBigint = gasUsedUsdc(68400n, '3400');
    const fromString = gasUsedUsdc('68400', '3400');
    expect(fromBigint.equals(fromString)).toBe(true);
  });
});
