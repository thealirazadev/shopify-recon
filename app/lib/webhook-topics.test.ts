import { describe, expect, it } from "vitest";

import { actionForTopic } from "./webhook-topics";

describe("actionForTopic", () => {
  it("maps each lifecycle and compliance topic to its action", () => {
    expect(actionForTopic("APP_UNINSTALLED")).toBe("uninstall");
    expect(actionForTopic("APP_SCOPES_UPDATE")).toBe("update-scope");
    expect(actionForTopic("CUSTOMERS_DATA_REQUEST")).toBe("acknowledge-data-request");
    expect(actionForTopic("CUSTOMERS_REDACT")).toBe("acknowledge-customer-redact");
    expect(actionForTopic("SHOP_REDACT")).toBe("shop-redact");
  });

  it("treats any payout topic spelling as a sync trigger", () => {
    expect(actionForTopic("PAYOUTS_CREATE")).toBe("sync-trigger");
    expect(actionForTopic("shopify_payments/payouts/update")).toBe("sync-trigger");
  });

  it("leaves other topics unhandled, including near misses on known ones", () => {
    expect(actionForTopic("ORDERS_CREATE")).toBe("unhandled");
    expect(actionForTopic("app_uninstalled")).toBe("unhandled");
    expect(actionForTopic("")).toBe("unhandled");
  });
});
