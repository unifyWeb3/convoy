// @convoy/kh-client — disambiguating KeeperHub's `gasUsedWei`.
//
// The field's meaning flips with sponsorship (gap G-31). Both the POST write
// response and `GET /status` carry it, so the decoding lives here once rather
// than being duplicated — and being duplicated is how one of the two branches
// would silently keep the old, wrong reading.
//
// Measured 2026-08-04 against chain receipts, `services/worker/scripts/gasfield.mjs`:
//
//   sponsored:true   gasUsedWei 66226         == receipt.gasUsed 66226
//   sponsored:false  gasUsedWei 275418000000  == 45903 * 6000000, the L2 fee
//   sponsored:false  gasUsedWei 275490000000  == 45915 * 6000000, the L2 fee
//
// Neither branch includes the OP-stack L1 data fee; that is gap G-28 and is
// composed from the receipt by the worker.

import type { ReportedGasMeaning } from './types.js';

export interface ReportedGas {
  readonly gasUsedUnits?: string;
  readonly gasFeeWeiL2?: string;
  readonly gasReportedRaw?: string;
  readonly gasReportedMeaning?: ReportedGasMeaning;
  readonly gasPriceWei?: string;
  readonly sponsored?: boolean;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Read sponsorship off an execution record.
 *
 * The top level is authoritative. `result.sponsored` is **absent** on
 * unsponsored records — reading it alone would make every unsponsored execution
 * look like `undefined` rather than `false`, which is precisely the case the
 * wallet-debited figure exists to catch. `result.executedCall.sponsored` is a
 * corroborating third copy that agreed with the top level on every measured
 * execution; it is the fallback, not the source.
 */
export function extractSponsored(body: Record<string, unknown>): boolean | undefined {
  if (typeof body['sponsored'] === 'boolean') return body['sponsored'];
  const result = body['result'];
  if (result !== null && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r['sponsored'] === 'boolean') return r['sponsored'];
    const call = r['executedCall'];
    if (call !== null && typeof call === 'object') {
      const c = call as Record<string, unknown>;
      if (typeof c['sponsored'] === 'boolean') return c['sponsored'];
    }
  }
  return undefined;
}

/**
 * Decode `gasUsedWei` into whichever of `gasUsedUnits` / `gasFeeWeiL2` it
 * actually is.
 *
 * With no `sponsored` discriminator the meaning is `ambiguous` and **neither**
 * typed field is populated. That is deliberate: an unlabelled number here is
 * exactly the input that produced the ~6.2-million-fold error, and a consumer
 * getting `undefined` falls back to the chain receipt, which is right.
 */
export function decodeReportedGas(body: Record<string, unknown>): ReportedGas {
  const raw = str(body['gasUsedWei']);
  const gasPriceWei = str(body['gasPriceWei']);
  const sponsored = extractSponsored(body);

  const meaning: ReportedGasMeaning | undefined =
    raw === undefined
      ? undefined
      : sponsored === undefined
        ? 'ambiguous'
        : sponsored
          ? 'units'
          : 'weiL2';

  return {
    ...(raw !== undefined && meaning === 'units' ? { gasUsedUnits: raw } : {}),
    ...(raw !== undefined && meaning === 'weiL2' ? { gasFeeWeiL2: raw } : {}),
    ...(raw !== undefined ? { gasReportedRaw: raw } : {}),
    ...(meaning !== undefined ? { gasReportedMeaning: meaning } : {}),
    ...(gasPriceWei !== undefined ? { gasPriceWei } : {}),
    ...(sponsored !== undefined ? { sponsored } : {}),
  };
}
