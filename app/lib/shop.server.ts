import db from "~/db.server";
import { InvalidTimeZoneError, payoutDate } from "~/lib/dates";
import { UpstreamError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { currencyExponent, UnknownCurrencyError } from "~/lib/money";
import type { ThrottledClient } from "~/sync/throttle.server";

// The shop's payout currency and IANA timezone gate everything else: no
// amount can be parsed and no payout date derived without them. They are read
// once on the first authenticated load and re-checked at the start of every
// sync run, both through the throttled client that owns the Admin API path.

const SHOP_INFO_QUERY = `#graphql
  query ShopInfo {
    shop {
      myshopifyDomain
      ianaTimezone
      currencyCode
    }
  }`;

interface ShopInfoData {
  shop?: {
    myshopifyDomain?: string;
    ianaTimezone?: string;
    currencyCode?: string;
  };
}

export interface ShopIdentity {
  currency: string;
  ianaTimezone: string;
}

/**
 * Reads the shop's currency and timezone from Shopify and refuses anything
 * this app cannot compute with: an unknown currency exponent or an unusable
 * timezone would silently corrupt every later amount and payout date.
 */
async function fetchShopIdentity(client: ThrottledClient): Promise<ShopIdentity> {
  const data = await client.request<ShopInfoData>("ShopInfo", SHOP_INFO_QUERY);
  const currency = data.shop?.currencyCode;
  const ianaTimezone = data.shop?.ianaTimezone;

  if (!currency || !ianaTimezone) {
    throw new UpstreamError("ShopInfo returned no currency or timezone");
  }

  try {
    currencyExponent(currency);
    payoutDate(new Date(0), ianaTimezone);
  } catch (error) {
    if (error instanceof UnknownCurrencyError || error instanceof InvalidTimeZoneError) {
      throw new UpstreamError(`Unusable shop settings: ${error.message}`);
    }

    throw error;
  }

  return { currency, ianaTimezone };
}

/**
 * Ensures a Shop row exists. Re-entry is a no-op: once the row exists nothing
 * is fetched and nothing is written, so a page load never overwrites settings.
 * A failure here is logged and swallowed so a transient Admin API error cannot
 * block the embedded shell; the next authenticated load retries.
 */
export async function ensureShopSettings(client: ThrottledClient, shop: string): Promise<void> {
  try {
    const existing = await db.shop.findUnique({ where: { shop }, select: { id: true } });

    if (existing) {
      return;
    }

    const identity = await fetchShopIdentity(client);

    await db.shop.upsert({
      where: { shop },
      create: { shop, currency: identity.currency, ianaTimezone: identity.ianaTimezone },
      update: {},
    });

    logger.info("shop.bootstrapped", { shop, ...identity });
  } catch (error) {
    logger.error("shop.bootstrap_failed", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Shop settings for a sync run, re-checked against Shopify first. A currency
 * or timezone change is logged loudly: stored payoutDate values were derived
 * in the old zone and only a full re-sync recomputes them. Unlike the
 * bootstrap path this throws, because a run that cannot read the shop's
 * currency must fail rather than guess.
 */
export async function loadShopSettings(client: ThrottledClient, shop: string) {
  const identity = await fetchShopIdentity(client);
  const existing = await db.shop.findUnique({ where: { shop } });

  if (!existing) {
    return db.shop.create({
      data: { shop, currency: identity.currency, ianaTimezone: identity.ianaTimezone },
    });
  }

  if (existing.currency === identity.currency && existing.ianaTimezone === identity.ianaTimezone) {
    return existing;
  }

  logger.warn("shop.settings_changed", {
    shop,
    fromCurrency: existing.currency,
    toCurrency: identity.currency,
    fromTimezone: existing.ianaTimezone,
    toTimezone: identity.ianaTimezone,
  });

  return db.shop.update({
    where: { shop },
    data: { currency: identity.currency, ianaTimezone: identity.ianaTimezone },
  });
}
