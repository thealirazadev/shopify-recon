import { describe, expect, it } from "vitest";

import { UnknownCurrencyError } from "./money";
import type { RollupLine, RollupPayout } from "./rollup";
import { rollupPayout } from "./rollup";

const SYNCED_AT = new Date("2026-07-24T12:00:00Z");

function payout(overrides: Partial<RollupPayout> = {}): RollupPayout {
  return {
    status: "paid",
    currency: "USD",
    netMinor: 7_200n,
    transactionsSyncedAt: SYNCED_AT,
    ...overrides,
  };
}

function line(overrides: Partial<RollupLine> = {}): RollupLine {
  return {
    type: "charge",
    currency: "USD",
    amountMinor: 10_000n,
    feeMinor: 300n,
    netMinor: 9_700n,
    matchState: "matched",
    ...overrides,
  };
}

// A charge, a refund, and a reserve adjustment whose nets add up to 72.00.
const LINES: RollupLine[] = [
  line(),
  line({ type: "refund", amountMinor: -2_000n, feeMinor: 0n, netMinor: -2_000n }),
  line({ type: "reserved_funds", amountMinor: -500n, feeMinor: 0n, netMinor: -500n }),
];

describe("rollupPayout", () => {
  it("is pending with no totals until the payout is paid", () => {
    for (const status of ["scheduled", "in_transit", "failed", "canceled"]) {
      expect(rollupPayout(payout({ status }), LINES)).toEqual({
        reconStatus: "pending",
        totals: null,
      });
    }
  });

  it("is pending while the transaction set has not been fully synced", () => {
    expect(rollupPayout(payout({ transactionsSyncedAt: null }), LINES)).toEqual({
      reconStatus: "pending",
      totals: null,
    });
  });

  it("reconciles when the computed net equals the deposit and every line matched", () => {
    expect(rollupPayout(payout(), LINES)).toEqual({
      reconStatus: "reconciled",
      totals: {
        computedGrossMinor: 10_000n,
        computedFeesMinor: 300n,
        computedRefundsMinor: -2_000n,
        computedAdjustmentsMinor: -500n,
        computedNetMinor: 7_200n,
        varianceMinor: 0n,
      },
    });
  });

  it("keeps the exact variance as computed net minus deposited net", () => {
    const short = rollupPayout(payout({ netMinor: 7_300n }), LINES);
    const over = rollupPayout(payout({ netMinor: 7_150n }), LINES);

    expect(short.reconStatus).toBe("variance");
    expect(short.totals?.varianceMinor).toBe(-100n);
    expect(over.reconStatus).toBe("variance");
    expect(over.totals?.varianceMinor).toBe(50n);
  });

  it("reports variance when the money adds up but a line is not matched", () => {
    for (const matchState of ["partial", "unmatched"] as const) {
      const lines = [LINES[0], { ...LINES[1], matchState }, LINES[2]];
      const result = rollupPayout(payout(), lines);

      expect(result.reconStatus).toBe("variance");
      expect(result.totals?.varianceMinor).toBe(0n);
    }
  });

  it("sums fees from every line and gross only from charges", () => {
    const lines = [
      line(),
      line({ amountMinor: 5_000n, feeMinor: 175n, netMinor: 4_825n }),
      line({ type: "dispute", amountMinor: -1_500n, feeMinor: 1_500n, netMinor: -3_000n }),
    ];
    const result = rollupPayout(payout({ netMinor: 11_525n }), lines);

    expect(result.totals).toEqual({
      computedGrossMinor: 15_000n,
      computedFeesMinor: 1_975n,
      computedRefundsMinor: 0n,
      computedAdjustmentsMinor: -3_000n,
      computedNetMinor: 11_525n,
      varianceMinor: 0n,
    });
    expect(result.reconStatus).toBe("reconciled");
  });

  it("leaves a line in another currency out of the sums and never reconciles", () => {
    const lines = [...LINES, line({ currency: "EUR", netMinor: 1_000n })];
    // Deposit includes the converted EUR money: the gap shows as variance.
    const withMoney = rollupPayout(payout({ netMinor: 8_200n }), lines);
    // Deposit happens to equal the USD lines alone: still not reconciled.
    const coincidence = rollupPayout(payout(), lines);

    expect(withMoney.reconStatus).toBe("variance");
    expect(withMoney.totals?.computedNetMinor).toBe(7_200n);
    expect(withMoney.totals?.computedGrossMinor).toBe(10_000n);
    expect(withMoney.totals?.varianceMinor).toBe(-1_000n);
    expect(coincidence.reconStatus).toBe("variance");
    expect(coincidence.totals?.varianceMinor).toBe(0n);
  });

  it("reconciles an empty paid payout that deposited nothing", () => {
    const result = rollupPayout(payout({ netMinor: 0n }), []);

    expect(result.reconStatus).toBe("reconciled");
    expect(result.totals?.computedNetMinor).toBe(0n);
  });

  it("refuses a payout in a currency it cannot sum in", () => {
    expect(() => rollupPayout(payout({ currency: "XYZ" }), [])).toThrow(UnknownCurrencyError);
  });
});
