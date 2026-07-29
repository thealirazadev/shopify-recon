// The per-payout assertion the whole product rests on: gross sales minus fees
// minus refunds plus or minus adjustments equals the amount Shopify deposited.
// Every total is integer minor units, and the difference between the computed
// net and the reported deposit is kept as varianceMinor rather than absorbed.
//
// Pure: no Prisma, no clock. The recon pass supplies the payout and its lines.

import type { MatchState } from "./match";
import { isAdjustmentLine } from "./match";
import { sumMinor } from "./money";

export type ReconStatus = "pending" | "reconciled" | "variance";

/** The balance transaction fields the rollup reads. */
export interface RollupLine {
  readonly type: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly netMinor: bigint;
  readonly matchState: MatchState;
}

export interface RollupPayout {
  readonly status: string;
  readonly currency: string;
  /** What Shopify reports having deposited. */
  readonly netMinor: bigint;
  readonly transactionsSyncedAt: Date | null;
}

export interface RollupTotals {
  readonly computedGrossMinor: bigint;
  readonly computedFeesMinor: bigint;
  readonly computedRefundsMinor: bigint;
  readonly computedAdjustmentsMinor: bigint;
  readonly computedNetMinor: bigint;
  readonly varianceMinor: bigint;
}

export type RollupResult =
  | { readonly reconStatus: "pending"; readonly totals: null }
  | { readonly reconStatus: "reconciled" | "variance"; readonly totals: RollupTotals };

const PENDING: RollupResult = { reconStatus: "pending", totals: null };

/** Every total goes through the currency-asserting sum, never a bare reduce. */
function sumOf(
  currency: string,
  lines: ReadonlyArray<RollupLine>,
  amountOf: (line: RollupLine) => bigint,
): bigint {
  return sumMinor(
    currency,
    lines.map((line) => ({ minor: amountOf(line), currency: line.currency })),
  );
}

function totalsFor(payout: RollupPayout, lines: ReadonlyArray<RollupLine>): RollupTotals {
  const charges = lines.filter((line) => line.type === "charge");
  const refunds = lines.filter((line) => line.type === "refund");
  const adjustments = lines.filter((line) => isAdjustmentLine(line.type));
  const computedNetMinor = sumOf(payout.currency, lines, (line) => line.netMinor);

  return {
    computedGrossMinor: sumOf(payout.currency, charges, (line) => line.amountMinor),
    computedFeesMinor: sumOf(payout.currency, lines, (line) => line.feeMinor),
    computedRefundsMinor: sumOf(payout.currency, refunds, (line) => line.amountMinor),
    computedAdjustmentsMinor: sumOf(payout.currency, adjustments, (line) => line.netMinor),
    computedNetMinor,
    varianceMinor: computedNetMinor - payout.netMinor,
  };
}

/**
 * Totals and reconciliation status for one payout, or `pending` with no totals
 * when the payout has not settled or its transaction set is incomplete: a
 * rollup over a partial set would assert something it cannot know.
 *
 * A line denominated in another currency is left out of the sums, because no
 * total may cross currencies. Its amount is then missing from the computed net,
 * which surfaces as variance, and the line itself surfaces as a
 * currency_mismatch discrepancy.
 */
export function rollupPayout(payout: RollupPayout, lines: ReadonlyArray<RollupLine>): RollupResult {
  if (payout.status !== "paid" || payout.transactionsSyncedAt === null) {
    return PENDING;
  }

  const totals = totalsFor(
    payout,
    lines.filter((line) => line.currency === payout.currency),
  );
  const reconciled =
    totals.varianceMinor === 0n && lines.every((line) => line.matchState === "matched");

  return { reconStatus: reconciled ? "reconciled" : "variance", totals };
}
