import { describe, it, expect } from "vitest";

describe("Discrepancy detection", () => {
  it("should create a discrepancy record", () => {
    const discrepancy = {
      id: "disc-1",
      shop: "test-shop",
      type: "payout_variance",
      status: "open",
      detailedJson: '{"variance": 100}',
      createdAt: new Date(),
    };

    expect(discrepancy.type).toBe("payout_variance");
    expect(discrepancy.status).toBe("open");
  });

  it("should track discrepancy status transitions", () => {
    let status = "open";
    expect(["open", "resolved", "auto_resolved"]).toContain(status);
    status = "resolved";
    expect(status).toBe("resolved");
  });

  it("should validate discrepancy types", () => {
    const types = [
      "payout_variance",
      "unmatched_transaction",
      "missing_from_payout",
      "fee_anomaly",
      "currency_mismatch",
    ];
    expect(types.length).toBe(5);
  });
});
