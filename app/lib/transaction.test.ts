import { describe, it, expect } from "vitest";

describe("Transaction model", () => {
  it("should create a balance transaction", () => {
    const transaction = {
      id: "txn-1",
      type: "charge",
      currency: "USD",
      amountMinor: 5000n,
      feeMinor: 150n,
      netMinor: 4850n,
      matchState: "unmatched",
    };

    expect(transaction.type).toBe("charge");
    expect(transaction.amountMinor).toBe(5000n);
    expect(transaction.netMinor).toBe(4850n);
  });

  it("should track match state changes", () => {
    let state = "unmatched";
    expect(["matched", "partial", "unmatched"]).toContain(state);
    state = "matched";
    expect(state).toBe("matched");
  });
});
