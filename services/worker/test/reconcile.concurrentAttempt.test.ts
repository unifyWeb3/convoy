import { describe, expect, it } from 'vitest';
import { unsafeRawClient as prisma } from '@convoy/db';

import { getOrCreateAttempt } from '../src/reconcile.js';

describe('CVY-015 concurrent recovery', () => {
  it('prepares one EXECUTE row when several resumed workers race', async () => {
    const run = await prisma.run.create({
      data: {
        status: 'RECEIVED',
        budgetUsdc: '1.000000',
        runEthUsd: '3400.000000',
        items: {
          create: {
            idx: 0,
            targetAddr: Buffer.alloc(20),
            functionName: 'enableMarket',
            functionArgs: ['1'],
            payloadHash: Buffer.alloc(32),
            evidence: 'concurrent recovery test',
            state: 'COMMITTED',
          },
        },
      },
      include: { items: true },
    });

    try {
      const rows = await Promise.all(
        Array.from(
          { length: 8 },
          async () => await getOrCreateAttempt(run.items[0]!.id, 0, 'EXECUTE'),
        ),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      await expect(
        prisma.attempt.count({
          where: { itemId: run.items[0]!.id, attemptNo: 0, kind: 'EXECUTE' },
        }),
      ).resolves.toBe(1);
    } finally {
      await prisma.run.delete({ where: { id: run.id } });
    }
  });
});
