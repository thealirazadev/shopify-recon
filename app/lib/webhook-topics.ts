// Pure mapping from webhook topic to the action it triggers. Kept separate
// from the route so the dispatch table is unit-testable without mocking
// Prisma or the Shopify webhook authenticator.
export type WebhookAction =
  | "uninstall"
  | "update-scope"
  | "acknowledge-data-request"
  | "acknowledge-customer-redact"
  | "shop-redact"
  | "sync-trigger"
  | "unhandled";

const TOPIC_ACTIONS: Record<string, WebhookAction> = {
  APP_UNINSTALLED: "uninstall",
  APP_SCOPES_UPDATE: "update-scope",
  CUSTOMERS_DATA_REQUEST: "acknowledge-data-request",
  CUSTOMERS_REDACT: "acknowledge-customer-redact",
  SHOP_REDACT: "shop-redact",
};

export function actionForTopic(topic: string): WebhookAction {
  const known = TOPIC_ACTIONS[topic];

  if (known) {
    return known;
  }

  // Payout topic names vary by API version, so any delivered topic naming
  // payouts is treated as a freshness hint rather than pinning one spelling.
  // Nothing depends on it: the poller alone guarantees convergence.
  if (/payout/i.test(topic)) {
    return "sync-trigger";
  }

  return "unhandled";
}
