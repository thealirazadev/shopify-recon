import type { ActionFunctionArgs } from "@remix-run/node";

import db from "~/db.server";
import { logger } from "~/lib/logger.server";
import { actionForTopic } from "~/lib/webhook-topics";
import { requestSync } from "~/sync/poller.server";
import { authenticate } from "~/shopify.server";

// Single endpoint for every registered topic. authenticate.webhook verifies
// the HMAC before the dispatch below runs and answers 401 itself on a bad
// signature; the catch only exists so the rejection is logged. Handlers stay
// fast and side-effect-light: they write or delete rows, never sync inline.
export async function action({ request }: ActionFunctionArgs) {
  let webhook;

  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response && error.status === 401) {
      logger.warn("webhook.invalid_hmac", {
        shop: request.headers.get("x-shopify-shop-domain") ?? undefined,
        topic: request.headers.get("x-shopify-topic") ?? undefined,
      });
    }

    throw error;
  }

  const { topic, shop, payload } = webhook;

  logger.info("webhook.received", { shop, topic });

  try {
    switch (actionForTopic(topic)) {
      case "uninstall": {
        await db.session.deleteMany({ where: { shop } });
        await db.syncRun.updateMany({
          where: { shop, status: "running" },
          data: { status: "failed", error: "App uninstalled", finishedAt: new Date() },
        });
        logger.info("webhook.uninstall_handled", { shop, topic });
        break;
      }

      case "update-scope": {
        const scopes = (payload as { current?: string[] }).current;

        if (scopes) {
          await db.session.updateMany({ where: { shop }, data: { scope: scopes.join(",") } });
        }

        break;
      }

      case "sync-trigger": {
        // Fast and side-effect-light by design: record the trigger and answer
        // 200. The poller starts the run within seconds.
        requestSync(shop);
        logger.info("webhook.sync_requested", { shop, topic });
        break;
      }

      case "acknowledge-data-request":
      case "acknowledge-customer-redact": {
        // The mirror stores no customer-identifying fields, so there is
        // nothing to hand over or erase; acknowledge the request.
        logger.info("webhook.compliance_acknowledged", { shop, topic });
        break;
      }

      case "shop-redact": {
        // Children before parents: BalanceTransaction references Payout, and
        // OrderTransaction and Refund reference Order.
        await db.discrepancy.deleteMany({ where: { shop } });
        await db.balanceTransaction.deleteMany({ where: { shop } });
        await db.payout.deleteMany({ where: { shop } });
        await db.orderTransaction.deleteMany({ where: { shop } });
        await db.refund.deleteMany({ where: { shop } });
        await db.order.deleteMany({ where: { shop } });
        await db.syncRun.deleteMany({ where: { shop } });
        await db.syncCursor.deleteMany({ where: { shop } });
        await db.shop.deleteMany({ where: { shop } });
        await db.session.deleteMany({ where: { shop } });
        logger.info("webhook.shop_redacted", { shop, topic });
        break;
      }

      default: {
        logger.warn("webhook.unhandled_topic", { shop, topic });
      }
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    logger.error("webhook.processing_failed", {
      shop,
      topic,
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(null, { status: 500 });
  }
}
