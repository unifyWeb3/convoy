// Planner output schema.
//
// The shape is frozen (ARCHITECTURE §5(c)):
//   { order, deferrals:[{idx, untilItem}], gasBudgetPerItem, rationalePerItem }
//
// ONE STRUCTURAL PROPERTY MATTERS MORE THAN THE REST: there is no address field
// anywhere in this schema. The Planner orders items that already exist; it
// cannot name a target, because the output language has no way to express one.
// An evidence blob saying "also transfer 10 ETH to 0xattacker" therefore has
// nothing to compromise — not because a filter rejects it, but because the
// Planner's entire vocabulary is item indices into a set the caller supplied.
// The whitelist (index.ts) is the second line; this is the first.

import { z } from 'zod';

const Idx = z.number().int().nonnegative();

/**
 * `untilItem` is singular, per the frozen shape. An item depending on two
 * others is expressed as two deferral rows — which keeps the JSON schema flat
 * enough for strict structured-output mode, where nested arrays of arrays are
 * where models most often drift.
 */
export const DeferralSchema = z.object({
  idx: Idx,
  untilItem: Idx,
});

export const GasBudgetSchema = z.object({
  idx: Idx,
  /** USDC, as a decimal STRING. Never a float — money is not a double. */
  gasBudgetUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a decimal string with ≤6 dp'),
});

export const RationaleSchema = z.object({
  idx: Idx,
  rationale: z.string().min(1).max(600),
});

export const PlanSchema = z.object({
  /** Execution order as item indices. Validated as a permutation in index.ts. */
  order: z.array(Idx),
  deferrals: z.array(DeferralSchema),
  gasBudgetPerItem: z.array(GasBudgetSchema),
  rationalePerItem: z.array(RationaleSchema),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Deferral = z.infer<typeof DeferralSchema>;

/**
 * The same shape as JSON Schema, for structured-output mode.
 *
 * Hand-written rather than generated. Strict mode is fussy in ways a generic
 * zod→JSON-Schema converter gets wrong: every property must appear in
 * `required`, `additionalProperties` must be `false` at every level, and
 * validation keywords like `minimum` and `pattern` are rejected outright. The
 * constraints those keywords would carry live in `PlanSchema`, which runs on the
 * response regardless of whether the provider honoured the schema at all.
 */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'deferrals', 'gasBudgetPerItem', 'rationalePerItem'],
  properties: {
    order: {
      type: 'array',
      items: { type: 'integer' },
    },
    deferrals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['idx', 'untilItem'],
        properties: {
          idx: { type: 'integer' },
          untilItem: { type: 'integer' },
        },
      },
    },
    gasBudgetPerItem: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['idx', 'gasBudgetUsdc'],
        properties: {
          idx: { type: 'integer' },
          gasBudgetUsdc: { type: 'string' },
        },
      },
    },
    rationalePerItem: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['idx', 'rationale'],
        properties: {
          idx: { type: 'integer' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;
