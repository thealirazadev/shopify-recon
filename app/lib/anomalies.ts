// The five detection rules from docs/architecture.md, one function per subject
// kind. Each rule states a condition and produces an anomaly identified by
// (type, subjectType, subjectId), which is the key the discrepancy queue
// upserts on, so re-running detection re-derives the same identities.
//
// Pure: no Prisma, no clock. Settings and the current time are parameters.

import type { MatchReason, MatchState } from "./match";
import { formatMoney } from "./money";
import type { ReconStatus } from "./rollup";

export type DiscrepancyType =
  | "payout_variance"
  | "unmatched_transaction"
  | "missing_from_payout"
  | "fee_anomaly"
  | "currency_mismatch";

export type SubjectType = "payout" | "balance_transaction" | "order_transaction";

export interface Anomaly {
  readonly type: DiscrepancyType;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  /** Stored as detailJson: a human summary plus the minor units behind it. */
  readonly detail: Record<string, string>;
}

/** The operator-tunable part of the rules, read from the Shop row. */
export interface ReconSettings {
  readonly feePercentBps: number;
  readonly feeFixedMinor: number;
  readonly feeToleranceBps: number;
  readonly agingWindowDays: number;
}

export interface AnomalyPayout {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly netMinor: bigint;
  readonly reconStatus: ReconStatus;
  readonly computedNetMinor: bigint | null;
  readonly varianceMinor: bigint | null;
}

export interface AnomalyLine {
  readonly id: string;
  readonly type: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly matchState: MatchState;
  readonly matchReason: MatchReason | null;
}

export interface AgingCandidate {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly gateway: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly processedAt: Date;
  /** Whether any balance transaction names this row as its source. */
  readonly referenced: boolean;
}

export interface FeeBand {
  readonly expectedMinor: bigint;
  readonly toleranceMinor: bigint;
}

const MS_PER_DAY = 86_400_000;

const CAPTURING_KINDS = ["sale", "capture"];

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * The expected fee for an amount: amount * feePercentBps / 10000 plus the fixed
 * fee, with a tolerance of feeToleranceBps of the amount. Integer division
 * truncates, which can move the expected fee by at most one minor unit, so a
 * tolerance of zero makes the band exact to within that truncation.
 */
export function feeBand(amountMinor: bigint, settings: ReconSettings): FeeBand {
  const amount = absolute(amountMinor);

  return {
    expectedMinor:
      (amount * BigInt(settings.feePercentBps)) / 10_000n + BigInt(settings.feeFixedMinor),
    toleranceMinor: (amount * BigInt(settings.feeToleranceBps)) / 10_000n,
  };
}

/**
 * Rules for one payout and its lines: variance on the payout itself, and the
 * unmatched, fee-band, and currency rules on each line.
 */
export function payoutAnomalies(
  payout: AnomalyPayout,
  lines: ReadonlyArray<AnomalyLine>,
  settings: ReconSettings,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  if (
    payout.reconStatus === "variance" &&
    payout.varianceMinor &&
    payout.computedNetMinor !== null
  ) {
    anomalies.push({
      type: "payout_variance",
      subjectType: "payout",
      subjectId: payout.id,
      detail: {
        summary:
          `Computed net ${formatMoney(payout.computedNetMinor, payout.currency)} differs from ` +
          `the deposited ${formatMoney(payout.netMinor, payout.currency)} by ` +
          `${formatMoney(payout.varianceMinor, payout.currency)} ${payout.currency}`,
        computedNetMinor: payout.computedNetMinor.toString(),
        reportedNetMinor: payout.netMinor.toString(),
        varianceMinor: payout.varianceMinor.toString(),
      },
    });
  }

  for (const line of lines) {
    // A line of a payout that has not settled is still being written by
    // Shopify, so only a paid payout's lines are held to their match state.
    if (payout.status === "paid" && line.matchState !== "matched") {
      anomalies.push({
        type: "unmatched_transaction",
        subjectType: "balance_transaction",
        subjectId: line.id,
        detail: {
          summary:
            `${line.type} line of ${formatMoney(line.amountMinor, line.currency)} ` +
            `${line.currency} is ${line.matchState} (${line.matchReason ?? "unspecified"})`,
          matchState: line.matchState,
          matchReason: line.matchReason ?? "",
          amountMinor: line.amountMinor.toString(),
        },
      });
    }

    if (line.type === "charge" && line.matchState === "matched") {
      const band = feeBand(line.amountMinor, settings);
      const drift = absolute(line.feeMinor - band.expectedMinor);

      if (drift > band.toleranceMinor) {
        anomalies.push({
          type: "fee_anomaly",
          subjectType: "balance_transaction",
          subjectId: line.id,
          detail: {
            summary:
              `Fee ${formatMoney(line.feeMinor, line.currency)} on ` +
              `${formatMoney(line.amountMinor, line.currency)} is outside the expected ` +
              `${formatMoney(band.expectedMinor, line.currency)} plus or minus ` +
              `${formatMoney(band.toleranceMinor, line.currency)} ${line.currency}`,
            expectedFeeMinor: band.expectedMinor.toString(),
            actualFeeMinor: line.feeMinor.toString(),
            toleranceMinor: band.toleranceMinor.toString(),
            amountMinor: line.amountMinor.toString(),
          },
        });
      }
    }

    if (line.currency !== payout.currency) {
      anomalies.push({
        type: "currency_mismatch",
        subjectType: "balance_transaction",
        subjectId: line.id,
        detail: {
          summary:
            `Line currency ${line.currency} differs from the payout currency ` +
            `${payout.currency}, so the line is left out of the payout totals`,
          lineCurrency: line.currency,
          payoutCurrency: payout.currency,
          amountMinor: line.amountMinor.toString(),
        },
      });
    }
  }

  return anomalies;
}

/**
 * Money that left the store through Shopify Payments and has not turned up in
 * any payout after the aging window. A row processed exactly on the boundary is
 * not yet aged; one minor step older is.
 */
export function agingAnomalies(
  candidates: ReadonlyArray<AgingCandidate>,
  settings: ReconSettings,
  now: Date,
): Anomaly[] {
  const cutoff = now.getTime() - settings.agingWindowDays * MS_PER_DAY;

  return candidates
    .filter(
      (candidate) =>
        !candidate.referenced &&
        candidate.status === "success" &&
        candidate.gateway === "shopify_payments" &&
        CAPTURING_KINDS.includes(candidate.kind) &&
        candidate.processedAt.getTime() < cutoff,
    )
    .map((candidate) => ({
      type: "missing_from_payout" as const,
      subjectType: "order_transaction" as const,
      subjectId: candidate.id,
      detail: {
        summary:
          `${candidate.kind} of ${formatMoney(candidate.amountMinor, candidate.currency)} ` +
          `${candidate.currency} has not appeared in a payout after ` +
          `${settings.agingWindowDays} day(s)`,
        amountMinor: candidate.amountMinor.toString(),
        processedAt: candidate.processedAt.toISOString(),
        agingWindowDays: String(settings.agingWindowDays),
      },
    }));
}
