import { describe, expect, it } from "vitest";

import type { AgingCandidate, AnomalyLine, AnomalyPayout, ReconSettings } from "./anomalies";
import { agingAnomalies, feeBand, payoutAnomalies } from "./anomalies";

// 2.9% + 0.30 with a tolerance of 0.1% of the amount.
const SETTINGS: ReconSettings = {
  feePercentBps: 290,
  feeFixedMinor: 30,
  feeToleranceBps: 10,
  agingWindowDays: 7,
};

function payout(overrides: Partial<AnomalyPayout> = {}): AnomalyPayout {
  return {
    id: "payout-1",
    status: "paid",
    currency: "USD",
    netMinor: 9_680n,
    reconStatus: "reconciled",
    computedNetMinor: 9_680n,
    varianceMinor: 0n,
    ...overrides,
  };
}

// A 100.00 charge: expected fee 2.90 + 0.30 = 3.20, tolerance 0.10.
function line(overrides: Partial<AnomalyLine> = {}): AnomalyLine {
  return {
    id: "bt-1",
    type: "charge",
    currency: "USD",
    amountMinor: 10_000n,
    feeMinor: 320n,
    matchState: "matched",
    matchReason: null,
    ...overrides,
  };
}

function types(anomalies: ReadonlyArray<{ type: string }>): string[] {
  return anomalies.map((anomaly) => anomaly.type);
}

describe("feeBand", () => {
  it("computes the expected fee and tolerance in minor units", () => {
    expect(feeBand(10_000n, SETTINGS)).toEqual({ expectedMinor: 320n, toleranceMinor: 10n });
  });

  it("uses the absolute amount", () => {
    expect(feeBand(-10_000n, SETTINGS)).toEqual(feeBand(10_000n, SETTINGS));
  });

  it("truncates the percentage part", () => {
    // 1.99 * 2.9% = 0.05771, truncated to 5 minor units.
    expect(feeBand(199n, SETTINGS)).toEqual({ expectedMinor: 35n, toleranceMinor: 0n });
  });
});

describe("payoutAnomalies", () => {
  it("raises nothing for a reconciled payout with an in-band fee", () => {
    expect(payoutAnomalies(payout(), [line()], SETTINGS)).toEqual([]);
  });

  it("raises payout_variance with the exact figures", () => {
    const anomalies = payoutAnomalies(
      payout({
        reconStatus: "variance",
        computedNetMinor: 9_680n,
        varianceMinor: -20n,
        netMinor: 9_700n,
      }),
      [],
      SETTINGS,
    );

    expect(anomalies).toEqual([
      {
        type: "payout_variance",
        subjectType: "payout",
        subjectId: "payout-1",
        detail: {
          summary: "Computed net 96.80 differs from the deposited 97.00 by -0.20 USD",
          computedNetMinor: "9680",
          reportedNetMinor: "9700",
          varianceMinor: "-20",
        },
      },
    ]);
  });

  it("raises no payout_variance when the money adds up", () => {
    // Variance status from an unmatched line, with a zero money variance.
    const anomalies = payoutAnomalies(
      payout({ reconStatus: "variance", varianceMinor: 0n }),
      [line({ matchState: "partial", matchReason: "amount_mismatch" })],
      SETTINGS,
    );

    expect(types(anomalies)).toEqual(["unmatched_transaction"]);
  });

  it("raises unmatched_transaction for every non-matched line of a paid payout", () => {
    const anomalies = payoutAnomalies(
      payout(),
      [
        line({ id: "bt-1", matchState: "unmatched", matchReason: "no_source" }),
        line({ id: "bt-2", matchState: "partial", matchReason: null }),
      ],
      SETTINGS,
    );

    expect(anomalies).toEqual([
      {
        type: "unmatched_transaction",
        subjectType: "balance_transaction",
        subjectId: "bt-1",
        detail: {
          summary: "charge line of 100.00 USD is unmatched (no_source)",
          matchState: "unmatched",
          matchReason: "no_source",
          amountMinor: "10000",
        },
      },
      {
        type: "unmatched_transaction",
        subjectType: "balance_transaction",
        subjectId: "bt-2",
        detail: {
          summary: "charge line of 100.00 USD is partial (unspecified)",
          matchState: "partial",
          matchReason: "",
          amountMinor: "10000",
        },
      },
    ]);
  });

  it("does not hold lines of an unsettled payout to their match state", () => {
    const anomalies = payoutAnomalies(
      payout({ status: "in_transit", reconStatus: "pending" }),
      [line({ matchState: "unmatched", matchReason: "no_source" })],
      SETTINGS,
    );

    expect(anomalies).toEqual([]);
  });

  it("accepts a fee exactly at either edge of the band", () => {
    for (const feeMinor of [310n, 330n]) {
      expect(payoutAnomalies(payout(), [line({ feeMinor })], SETTINGS)).toEqual([]);
    }
  });

  it("raises fee_anomaly one minor unit outside the band", () => {
    for (const feeMinor of [309n, 331n]) {
      const anomalies = payoutAnomalies(payout(), [line({ feeMinor })], SETTINGS);

      expect(types(anomalies)).toEqual(["fee_anomaly"]);
      expect(anomalies[0].subjectId).toBe("bt-1");
      expect(anomalies[0].detail).toMatchObject({
        expectedFeeMinor: "320",
        actualFeeMinor: String(feeMinor),
        toleranceMinor: "10",
        amountMinor: "10000",
      });
    }
  });

  it("checks fees only on matched charges", () => {
    const anomalies = payoutAnomalies(
      payout(),
      [
        line({ id: "bt-refund", type: "refund", amountMinor: -10_000n, feeMinor: 0n }),
        line({ id: "bt-adjust", type: "adjustment", amountMinor: -500n, feeMinor: 999n }),
        line({
          id: "bt-partial",
          feeMinor: 0n,
          matchState: "partial",
          matchReason: "amount_mismatch",
        }),
      ],
      SETTINGS,
    );

    expect(anomalies.map((anomaly) => [anomaly.type, anomaly.subjectId])).toEqual([
      ["unmatched_transaction", "bt-partial"],
    ]);
  });

  it("raises currency_mismatch for a line in another currency", () => {
    const anomalies = payoutAnomalies(
      payout(),
      [line({ id: "bt-eur", currency: "EUR" })],
      SETTINGS,
    );

    expect(anomalies).toEqual([
      {
        type: "currency_mismatch",
        subjectType: "balance_transaction",
        subjectId: "bt-eur",
        detail: {
          summary:
            "Line currency EUR differs from the payout currency USD, so the line is left out " +
            "of the payout totals",
          lineCurrency: "EUR",
          payoutCurrency: "USD",
          amountMinor: "10000",
        },
      },
    ]);
  });

  it("re-derives the same identities on every run", () => {
    const lines = [line({ feeMinor: 500n }), line({ id: "bt-2", matchState: "unmatched" })];
    const keys = () =>
      payoutAnomalies(payout(), lines, SETTINGS).map(
        (anomaly) => `${anomaly.type}:${anomaly.subjectType}:${anomaly.subjectId}`,
      );

    expect(keys()).toEqual(keys());
    expect(keys()).toEqual([
      "fee_anomaly:balance_transaction:bt-1",
      "unmatched_transaction:balance_transaction:bt-2",
    ]);
  });
});

describe("agingAnomalies", () => {
  const NOW = new Date("2026-07-30T00:00:00Z");
  const CUTOFF = new Date("2026-07-23T00:00:00Z");

  function candidate(overrides: Partial<AgingCandidate> = {}): AgingCandidate {
    return {
      id: "otx-1",
      kind: "sale",
      status: "success",
      gateway: "shopify_payments",
      currency: "USD",
      amountMinor: 10_000n,
      processedAt: new Date(CUTOFF.getTime() - 1),
      referenced: false,
      ...overrides,
    };
  }

  it("raises missing_from_payout for captured money older than the window", () => {
    expect(agingAnomalies([candidate()], SETTINGS, NOW)).toEqual([
      {
        type: "missing_from_payout",
        subjectType: "order_transaction",
        subjectId: "otx-1",
        detail: {
          summary: "sale of 100.00 USD has not appeared in a payout after 7 day(s)",
          amountMinor: "10000",
          processedAt: "2026-07-22T23:59:59.999Z",
          agingWindowDays: "7",
        },
      },
    ]);
  });

  it("treats a capture like a sale", () => {
    expect(types(agingAnomalies([candidate({ kind: "capture" })], SETTINGS, NOW))).toEqual([
      "missing_from_payout",
    ]);
  });

  it("does not age a row processed exactly on the boundary", () => {
    expect(agingAnomalies([candidate({ processedAt: CUTOFF })], SETTINGS, NOW)).toEqual([]);
  });

  it("skips rows that are referenced, failed, off-gateway, or not captures", () => {
    const skipped = [
      candidate({ id: "referenced", referenced: true }),
      candidate({ id: "failed", status: "failure" }),
      candidate({ id: "manual", gateway: "manual" }),
      candidate({ id: "refund", kind: "refund" }),
      candidate({ id: "authorization", kind: "authorization" }),
    ];

    expect(agingAnomalies(skipped, SETTINGS, NOW)).toEqual([]);
  });

  it("follows the configured window", () => {
    const recent = candidate({ processedAt: new Date("2026-07-28T00:00:00Z") });

    expect(agingAnomalies([recent], SETTINGS, NOW)).toEqual([]);
    expect(types(agingAnomalies([recent], { ...SETTINGS, agingWindowDays: 1 }, NOW))).toEqual([
      "missing_from_payout",
    ]);
  });
});
