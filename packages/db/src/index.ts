// @convoy/db — Prisma client singleton and exported ledger types.
//
// Convoy's ledger of record and the third leg of the manifest's three-way
// reconciliation. Money is numeric(20,6) -> Prisma Decimal; wei is bigint or
// string, never a float. `events` is append-only and its bigserial id is the
// SSE event id used for Last-Event-ID replay.
//
// Scaffold only. Schema, migrations, seed and the client singleton land in CVY-005.
export {};
