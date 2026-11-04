import { describe, expect, it } from "vitest";

import type { AnomalyLine, AnomalyPayout, ReconSettings } from "./anomalies";
import { feeBand, payoutAnomalies } from "./anomalies";

const SETTINGS: ReconSettings = {
  feePercentBps: 290,
  feeFixedMinor: 30,
  feeToleranceBps: 0,
  agingWindowDays: 7,
};

const PAYOUT: AnomalyPayout = {
  id: "payout-1",
  status: "paid",
  currency: "USD",
  netMinor: 0n,
  reconStatus: "reconciled",
  computedNetMinor: 0n,
  varianceMinor: 0n,
};

function charge(amountMinor: bigint, feeMinor: bigint): AnomalyLine {
  return {
    id: "line-1",
    type: "charge",
    currency: "USD",
    amountMinor,
    feeMinor,
    matchState: "matched",
    matchReason: null,
  };
}

describe("feeBand", () => {
  it("rounds the percentage part to the nearest minor unit", () => {
    // 2.9% of 10.60 is 0.3074, billed as 0.31; plus 0.30 fixed.
    expect(feeBand(1060n, SETTINGS).expectedMinor).toBe(61n);
    // 2.9% of 10.40 is 0.3016, billed as 0.30.
    expect(feeBand(1040n, SETTINGS).expectedMinor).toBe(60n);
    // 2.9% of 10.50 is 0.3045, billed as 0.30.
    expect(feeBand(1050n, SETTINGS).expectedMinor).toBe(60n);
  });

  it("rounds an exact half up", () => {
    // 1% of 0.50 is exactly half a cent.
    expect(feeBand(50n, { ...SETTINGS, feePercentBps: 100, feeFixedMinor: 0 }).expectedMinor).toBe(
      1n,
    );
  });

  it("uses the absolute amount", () => {
    expect(feeBand(-1060n, SETTINGS)).toStrictEqual(feeBand(1060n, SETTINGS));
  });

  it("derives the tolerance from the amount", () => {
    expect(feeBand(10_000n, { ...SETTINGS, feeToleranceBps: 50 }).toleranceMinor).toBe(50n);
  });
});

describe("fee_anomaly rule", () => {
  const feeTypes = (fee: bigint, settings = SETTINGS) =>
    payoutAnomalies(PAYOUT, [charge(1060n, fee)], settings).map((anomaly) => anomaly.type);

  it("does not flag a correctly rounded fee at zero tolerance", () => {
    expect(feeTypes(61n)).toStrictEqual([]);
  });

  it("flags a fee one minor unit off at zero tolerance", () => {
    expect(feeTypes(60n)).toStrictEqual(["fee_anomaly"]);
    expect(feeTypes(62n)).toStrictEqual(["fee_anomaly"]);
  });

  it("accepts a fee exactly at the band edge and flags one unit past it", () => {
    // 50 bps of 10.60 is 0.053, so the tolerance is 5 minor units.
    const settings = { ...SETTINGS, feeToleranceBps: 50 };

    expect(feeTypes(66n, settings)).toStrictEqual([]);
    expect(feeTypes(56n, settings)).toStrictEqual([]);
    expect(feeTypes(67n, settings)).toStrictEqual(["fee_anomaly"]);
    expect(feeTypes(55n, settings)).toStrictEqual(["fee_anomaly"]);
  });
});
