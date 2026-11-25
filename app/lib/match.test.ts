import { describe, expect, it } from "vitest";

import type { CounterpartRefund, CounterpartTransaction, MatchLine, MatchSources } from "./match";
import { isAdjustmentLine, matchTransaction } from "./match";

const SALE_GID = "gid://shopify/OrderTransaction/1";
const REFUND_GID = "gid://shopify/OrderTransaction/2";

const sale: CounterpartTransaction = {
  id: "otx-sale",
  orderId: "order-1",
  kind: "sale",
  currency: "USD",
  amountMinor: 10_000n,
};

const refundTransaction: CounterpartTransaction = {
  id: "otx-refund",
  orderId: "order-1",
  kind: "refund",
  currency: "USD",
  amountMinor: 2_500n,
};

const MIRRORED: [string, CounterpartTransaction][] = [
  [SALE_GID, sale],
  [REFUND_GID, refundTransaction],
];

function sources(
  transactions: [string, CounterpartTransaction][] = MIRRORED,
  refunds: Record<string, CounterpartRefund[]> = {},
): MatchSources {
  return {
    orderTransactionsByGid: new Map(transactions),
    refundsByOrderId: new Map(Object.entries(refunds)),
  };
}

function charge(overrides: Partial<MatchLine> = {}): MatchLine {
  return {
    type: "charge",
    currency: "USD",
    amountMinor: 10_000n,
    sourceOrderTransactionId: SALE_GID,
    ...overrides,
  };
}

function refundLine(overrides: Partial<MatchLine> = {}): MatchLine {
  return {
    type: "refund",
    currency: "USD",
    amountMinor: -2_500n,
    sourceOrderTransactionId: REFUND_GID,
    ...overrides,
  };
}

describe("isAdjustmentLine", () => {
  it("treats every type other than charge and refund as an adjustment", () => {
    expect(isAdjustmentLine("charge")).toBe(false);
    expect(isAdjustmentLine("refund")).toBe(false);
    expect(isAdjustmentLine("adjustment")).toBe(true);
    expect(isAdjustmentLine("dispute")).toBe(true);
    expect(isAdjustmentLine("reserved_funds")).toBe(true);
    expect(isAdjustmentLine("a_type_shopify_adds_later")).toBe(true);
  });
});

describe("matchTransaction: charges", () => {
  it("matches a charge whose source has the same currency and amount", () => {
    expect(matchTransaction(charge(), sources())).toEqual({
      matchState: "matched",
      matchTargetType: "order_transaction",
      matchTargetId: "otx-sale",
      matchReason: null,
    });
  });

  it("leaves a charge without a source identifier unmatched", () => {
    expect(matchTransaction(charge({ sourceOrderTransactionId: null }), sources())).toEqual({
      matchState: "unmatched",
      matchTargetType: null,
      matchTargetId: null,
      matchReason: "no_source",
    });
  });

  it("marks a charge partial when the mirror does not have its source", () => {
    expect(matchTransaction(charge(), sources([]))).toEqual({
      matchState: "partial",
      matchTargetType: "order_transaction",
      matchTargetId: null,
      matchReason: "source_missing",
    });
  });

  it("reports an amount mismatch against the linked source", () => {
    expect(matchTransaction(charge({ amountMinor: 9_999n }), sources())).toEqual({
      matchState: "partial",
      matchTargetType: "order_transaction",
      matchTargetId: "otx-sale",
      matchReason: "amount_mismatch",
    });
  });

  it("does not take the absolute value of a charge amount", () => {
    const result = matchTransaction(charge({ amountMinor: -10_000n }), sources());

    expect(result.matchReason).toBe("amount_mismatch");
  });

  it("reports a currency mismatch before comparing amounts", () => {
    const result = matchTransaction(charge({ currency: "EUR", amountMinor: 1n }), sources());

    expect(result.matchState).toBe("partial");
    expect(result.matchReason).toBe("currency_mismatch");
  });
});

describe("matchTransaction: refunds", () => {
  it("compares a negative payout line with the positive order-side amount", () => {
    expect(matchTransaction(refundLine(), sources())).toEqual({
      matchState: "matched",
      matchTargetType: "order_transaction",
      matchTargetId: "otx-refund",
      matchReason: null,
    });
  });

  it("links the Refund row when exactly one refund on the order has that amount", () => {
    const refunds = {
      "order-1": [
        { id: "refund-a", currency: "USD", amountMinor: 1_000n },
        { id: "refund-b", currency: "USD", amountMinor: 2_500n },
      ],
    };

    expect(matchTransaction(refundLine(), sources(undefined, refunds))).toEqual({
      matchState: "matched",
      matchTargetType: "refund",
      matchTargetId: "refund-b",
      matchReason: null,
    });
  });

  it("stays on the order transaction when two refunds have the same amount", () => {
    const refunds = {
      "order-1": [
        { id: "refund-a", currency: "USD", amountMinor: 2_500n },
        { id: "refund-b", currency: "USD", amountMinor: 2_500n },
      ],
    };
    const result = matchTransaction(refundLine(), sources(undefined, refunds));

    expect(result.matchTargetType).toBe("order_transaction");
    expect(result.matchTargetId).toBe("otx-refund");
  });

  it("ignores a refund of the same amount in another currency", () => {
    const refunds = { "order-1": [{ id: "refund-eur", currency: "EUR", amountMinor: 2_500n }] };
    const result = matchTransaction(refundLine(), sources(undefined, refunds));

    expect(result.matchTargetType).toBe("order_transaction");
    expect(result.matchTargetId).toBe("otx-refund");
  });

  it("leaves a refund without a source identifier unmatched", () => {
    const result = matchTransaction(refundLine({ sourceOrderTransactionId: null }), sources());

    expect(result).toEqual({
      matchState: "unmatched",
      matchTargetType: null,
      matchTargetId: null,
      matchReason: "no_source",
    });
  });

  it("marks a refund partial when its source is missing or is not a refund", () => {
    const missing = {
      matchState: "partial",
      matchTargetType: "refund",
      matchTargetId: null,
      matchReason: "source_missing",
    };

    expect(matchTransaction(refundLine(), sources([]))).toEqual(missing);
    expect(matchTransaction(refundLine({ sourceOrderTransactionId: SALE_GID }), sources())).toEqual(
      missing,
    );
  });

  it("reports an amount mismatch on a refund", () => {
    const result = matchTransaction(refundLine({ amountMinor: -2_400n }), sources());

    expect(result.matchState).toBe("partial");
    expect(result.matchReason).toBe("amount_mismatch");
    expect(result.matchTargetId).toBe("otx-refund");
  });

  it("reports a currency mismatch on a refund", () => {
    const result = matchTransaction(refundLine({ currency: "CAD" }), sources());

    expect(result.matchState).toBe("partial");
    expect(result.matchReason).toBe("currency_mismatch");
  });
});

describe("matchTransaction: other types", () => {
  it("categorizes self-describing types as matched adjustments", () => {
    for (const type of ["adjustment", "dispute", "reserved_funds", "unknown_future_type"]) {
      expect(
        matchTransaction(
          { type, currency: "USD", amountMinor: -500n, sourceOrderTransactionId: null },
          sources(),
        ),
      ).toEqual({
        matchState: "matched",
        matchTargetType: "adjustment",
        matchTargetId: null,
        matchReason: null,
      });
    }
  });
});

describe("matchTransaction: determinism", () => {
  it("returns the same result for the same input, whatever the refund order", () => {
    const forward = {
      "order-1": [
        { id: "refund-a", currency: "USD", amountMinor: 1_000n },
        { id: "refund-b", currency: "USD", amountMinor: 2_500n },
      ],
    };
    const reversed = { "order-1": [...forward["order-1"]].reverse() };
    const first = matchTransaction(refundLine(), sources(undefined, forward));

    expect(matchTransaction(refundLine(), sources(undefined, forward))).toEqual(first);
    expect(matchTransaction(refundLine(), sources(undefined, reversed))).toEqual(first);
  });
});
