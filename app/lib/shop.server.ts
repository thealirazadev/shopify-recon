import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import db from "~/db.server";
import { InvalidTimeZoneError, payoutDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { currencyExponent, UnknownCurrencyError } from "~/lib/money";

// Reads the shop's payout currency and IANA timezone once, on the first
// authenticated load, and stores them on Shop. Both are needed before any
// amount can be parsed or any payout date derived, so they are fetched
// before the sync engine exists.
//
// Phase 2 moves this call behind the cost-aware client in
// sync/throttle.server.ts, which is where every Admin API call belongs.

const SHOP_INFO_QUERY = `#graphql
  query ShopInfo {
    shop {
      myshopifyDomain
      ianaTimezone
      currencyCode
    }
  }`;

interface ShopInfoResponse {
  data?: {
    shop?: {
      myshopifyDomain?: string;
      ianaTimezone?: string;
      currencyCode?: string;
    };
  };
  errors?: unknown;
}

/**
 * Ensures a Shop row exists for this shop. Re-entry is a no-op: once the row
 * exists nothing is fetched and nothing is written, so an existing shop's
 * settings are never overwritten by a page load. A failure here is logged and
 * swallowed; the next authenticated load retries.
 */
export async function ensureShopSettings(admin: AdminApiContext, shop: string): Promise<void> {
  try {
    const existing = await db.shop.findUnique({ where: { shop }, select: { id: true } });

    if (existing) {
      return;
    }
  } catch (error) {
    logger.error("shop.bootstrap_failed", {
      shop,
      stage: "read",
      error: error instanceof Error ? error.message : String(error),
    });

    return;
  }

  let body: ShopInfoResponse;

  try {
    const response = await admin.graphql(SHOP_INFO_QUERY);
    body = (await response.json()) as ShopInfoResponse;
  } catch (error) {
    logger.error("shop.bootstrap_failed", {
      shop,
      stage: "fetch",
      error: error instanceof Error ? error.message : String(error),
    });

    return;
  }

  const info = body.data?.shop;

  if (body.errors || !info?.currencyCode || !info.ianaTimezone) {
    logger.error("shop.bootstrap_failed", {
      shop,
      stage: "fetch",
      error: "ShopInfo returned no currency or timezone",
    });

    return;
  }

  // Store nothing we cannot compute with: a currency with no known exponent
  // or an unusable timezone would silently corrupt every later amount and
  // payout date.
  try {
    currencyExponent(info.currencyCode);
    payoutDate(new Date(0), info.ianaTimezone);
  } catch (error) {
    if (error instanceof UnknownCurrencyError || error instanceof InvalidTimeZoneError) {
      logger.error("shop.bootstrap_failed", {
        shop,
        stage: "validate",
        currency: info.currencyCode,
        ianaTimezone: info.ianaTimezone,
        error: error.message,
      });

      return;
    }

    throw error;
  }

  try {
    await db.shop.upsert({
      where: { shop },
      create: { shop, currency: info.currencyCode, ianaTimezone: info.ianaTimezone },
      update: {},
    });

    logger.info("shop.bootstrapped", {
      shop,
      currency: info.currencyCode,
      ianaTimezone: info.ianaTimezone,
    });
  } catch (error) {
    logger.error("shop.bootstrap_failed", {
      shop,
      stage: "write",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
