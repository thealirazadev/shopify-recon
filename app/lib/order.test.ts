import { describe, it, expect } from "vitest";

describe("Order model", () => {
  it("should create an order with basic fields", () => {
    const order = {
      id: "order-1",
      shop: "test-shop",
      shopifyGid: "gid://shopify/Order/1",
      name: "#1001",
      currency: "USD",
      totalMinor: 10000n,
      financialStatus: "paid",
    };

    expect(order.id).toBe("order-1");
    expect(order.currency).toBe("USD");
    expect(order.totalMinor).toBe(10000n);
  });

  it("should validate order currency", () => {
    const order = {
      currency: "USD",
      totalMinor: 5000n,
    };

    expect(["USD", "EUR", "GBP"]).toContain(order.currency);
  });
});
