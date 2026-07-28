import type { Prisma } from "@prisma/client";

import type { SyncContext } from "./run.server";

import db from "~/db.server";
import { payoutDate as toPayoutDate } from "~/lib/dates";
import { isUnchanged } from "~/lib/diff";
import { UpstreamError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { parseMoney } from "~/lib/money";

// Payouts page newest-first and stop once past the watermark minus a fixed
// overlap, so a payout that Shopify back-dates or amends inside that window is
// still re-read. Locally non-terminal payouts are refreshed by node lookup
// however old they are, because a status flip to paid or failed is what makes
// a payout reconcilable.

export const PAYOUT_PAGE_SIZE = 50;

export const TRANSACTION_PAGE_SIZE = 250;

/** How far back past the watermark a run re-reads payouts. */
export const PAYOUT_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;

/** Safety bound on node lookups for payouts still awaiting a terminal status. */
export const NON_TERMINAL_REFRESH_LIMIT = 200;

const TERMINAL_STATUSES = ["paid", "failed", "canceled"];

// Anything outside this list is stored verbatim and logged; the matcher
// categorizes it as an adjustment. An unfamiliar type is never a crash.
const KNOWN_TRANSACTION_TYPES = [
  "charge",
  "refund",
  "adjustment",
  "dispute",
  "reserve",
  "transfer",
];

// One selection for both payout documents: every column payoutFields maps has
// to be present in each of them, or a refresh would blank what the page pass
// stored.
const PAYOUT_NODE_FIELDS = `
  id
  issuedAt
  status
  net { amount currencyCode }
  summary {
    chargesGross { amount currencyCode }
    chargesFee { amount currencyCode }
    refundsGross { amount currencyCode }
    refundsFee { amount currencyCode }
    adjustmentsGross { amount currencyCode }
    adjustmentsFee { amount currencyCode }
  }`;

const PAYOUTS_PAGE_QUERY = `#graphql
  query PayoutsPage($first: Int!, $after: String) {
    shopifyPaymentsAccount {
      payouts(first: $first, after: $after, reverse: true) {
        edges {
          node {${PAYOUT_NODE_FIELDS}
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const PAYOUT_BY_ID_QUERY = `#graphql
  query PayoutById($id: ID!) {
    node(id: $id) {
      ... on ShopifyPaymentsPayout {${PAYOUT_NODE_FIELDS}
      }
    }
  }`;

const PAYOUT_TRANSACTIONS_QUERY = `#graphql
  query PayoutTransactionsPage($first: Int!, $after: String, $query: String) {
    shopifyPaymentsAccount {
      balanceTransactions(first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            type
            transactionDate
            amount { amount currencyCode }
            fee { amount currencyCode }
            net { amount currencyCode }
            sourceId
            sourceType
            sourceOrderTransactionId
            associatedOrder { id name }
            associatedPayout { id status }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface PayoutNode {
  id: string;
  issuedAt: string;
  status: string;
  net: MoneyV2;
  summary?: Record<string, unknown> | null;
}

interface PayoutsPageData {
  shopifyPaymentsAccount?: {
    payouts: {
      edges: { node: PayoutNode }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

interface PayoutByIdData {
  node?: (Partial<PayoutNode> & { id?: string }) | null;
}

interface BalanceTransactionNode {
  id: string;
  type?: string | null;
  transactionDate: string;
  amount: MoneyV2;
  fee?: MoneyV2 | null;
  net: MoneyV2;
  sourceId?: string | number | null;
  sourceType?: string | null;
  sourceOrderTransactionId?: string | number | null;
  associatedOrder?: { id: string; name?: string } | null;
}

interface TransactionsPageData {
  shopifyPaymentsAccount?: {
    balanceTransactions: {
      edges: { node: BalanceTransactionNode }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

interface BalanceTransactionFields {
  payoutId: string;
  type: string;
  currency: string;
  transactionDate: Date;
  amountMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  sourceType: string | null;
  sourceId: string | null;
  sourceOrderTransactionId: string | null;
  associatedOrderGid: string | null;
}

interface PayoutFields {
  legacyId: string;
  status: string;
  currency: string;
  netMinor: bigint;
  issuedAt: Date;
  payoutDate: string;
  summaryJson: string;
}

function legacyIdOf(gid: string): string {
  const tail = gid.split("/").pop() ?? "";

  if (!/^\d+$/.test(tail)) {
    throw new UpstreamError(`Payout id is not a Shopify gid: ${gid}`);
  }

  return tail;
}

function instantOf(value: string, gid: string, field: string): Date {
  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    throw new UpstreamError(`${gid} has an unreadable ${field}`);
  }

  return instant;
}

/** Shopify's own breakdown, stored verbatim but converted to minor units. */
function summaryToMinor(summary: Record<string, unknown> | null | undefined): string {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(summary ?? {})) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const money = value as MoneyV2;

    if (typeof money.amount === "string" && typeof money.currencyCode === "string") {
      out[key] = parseMoney(money.amount, money.currencyCode).toString();
    }
  }

  return JSON.stringify(out);
}

function payoutFields(node: PayoutNode, ianaTimezone: string): PayoutFields {
  const currency = node.net.currencyCode;
  const issuedAt = instantOf(node.issuedAt, node.id, "issuedAt");

  return {
    legacyId: legacyIdOf(node.id),
    status: String(node.status).toLowerCase(),
    currency,
    netMinor: parseMoney(node.net.amount, currency),
    issuedAt,
    payoutDate: toPayoutDate(issuedAt, ianaTimezone),
    summaryJson: summaryToMinor(node.summary),
  };
}

/**
 * Writes one payout, skipping the update entirely when nothing changed. The
 * derived rollup columns are never touched here; only the recon pass owns
 * them.
 */
async function upsertPayout(
  tx: Prisma.TransactionClient,
  ctx: SyncContext,
  node: PayoutNode,
): Promise<void> {
  const fields = payoutFields(node, ctx.ianaTimezone);
  const where = { shop_shopifyGid: { shop: ctx.shop, shopifyGid: node.id } };
  const existing = await tx.payout.findUnique({ where });

  if (!existing) {
    await tx.payout.create({ data: { shop: ctx.shop, shopifyGid: node.id, ...fields } });

    return;
  }

  if (isUnchanged(existing, fields)) {
    return;
  }

  await tx.payout.update({ where: { id: existing.id }, data: fields });
}

/**
 * Commits one page of payouts. The watermark advances in the same transaction
 * as the last page of the pass, never earlier: paging runs newest-first, so
 * advancing on page one would let a crash skip everything behind it.
 */
async function commitPayoutPage(
  ctx: SyncContext,
  nodes: PayoutNode[],
  watermark: Date | null,
): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const node of nodes) {
      await upsertPayout(tx, ctx, node);
    }

    if (watermark) {
      const cursor = await tx.syncCursor.findUnique({
        where: { shop_resource: { shop: ctx.shop, resource: "payouts" } },
      });

      if (!cursor) {
        await tx.syncCursor.create({ data: { shop: ctx.shop, resource: "payouts", watermark } });
      } else if (cursor.watermark?.getTime() !== watermark.getTime()) {
        await tx.syncCursor.update({ where: { id: cursor.id }, data: { watermark } });
      }
    }
  });

  ctx.counters.payoutsSeen += nodes.length;

  logger.info("sync.page_committed", {
    shop: ctx.shop,
    runId: ctx.runId,
    resource: "payouts",
    rows: nodes.length,
    watermark: watermark?.toISOString(),
  });
}

/**
 * Shopify reports the source order transaction as a legacy numeric id; the
 * mirror joins on OrderTransaction.shopifyGid, so it is promoted to a gid
 * here, at the edge, and stored ready to join.
 */
function orderTransactionGid(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const raw = String(value);

  return /^\d+$/.test(raw) ? `gid://shopify/OrderTransaction/${raw}` : raw;
}

function transactionFields(
  ctx: SyncContext,
  node: BalanceTransactionNode,
  payoutId: string,
): BalanceTransactionFields {
  const currency = node.amount.currencyCode;
  const type = String(node.type ?? "adjustment").toLowerCase();

  if (!KNOWN_TRANSACTION_TYPES.includes(type)) {
    logger.warn("sync.unknown_type", {
      shop: ctx.shop,
      runId: ctx.runId,
      type,
      transaction: node.id,
    });
  }

  return {
    payoutId,
    type,
    currency,
    transactionDate: instantOf(node.transactionDate, node.id, "transactionDate"),
    amountMinor: parseMoney(node.amount.amount, currency),
    feeMinor: node.fee ? parseMoney(node.fee.amount, node.fee.currencyCode) : 0n,
    netMinor: parseMoney(node.net.amount, node.net.currencyCode),
    sourceType: node.sourceType ? String(node.sourceType).toLowerCase() : null,
    sourceId: node.sourceId === null || node.sourceId === undefined ? null : String(node.sourceId),
    sourceOrderTransactionId: orderTransactionGid(node.sourceOrderTransactionId),
    associatedOrderGid: node.associatedOrder?.id ?? null,
  };
}

/** Writes one balance transaction. Never touches the derived match columns. */
async function upsertBalanceTransaction(
  tx: Prisma.TransactionClient,
  ctx: SyncContext,
  node: BalanceTransactionNode,
  payoutId: string,
): Promise<void> {
  const fields = transactionFields(ctx, node, payoutId);
  const where = { shop_shopifyGid: { shop: ctx.shop, shopifyGid: node.id } };
  const existing = await tx.balanceTransaction.findUnique({ where });

  if (!existing) {
    await tx.balanceTransaction.create({
      data: { shop: ctx.shop, shopifyGid: node.id, ...fields },
    });

    return;
  }

  if (isUnchanged(existing, fields)) {
    return;
  }

  await tx.balanceTransaction.update({ where: { id: existing.id }, data: fields });
}

/**
 * Pages one payout's balance transactions. transactionsSyncedAt is stamped in
 * the same transaction as the final page and only while it is still null, so a
 * crash mid-payout leaves it null and the next run refetches from page one,
 * and a re-run over an already complete payout writes nothing at all.
 */
async function syncTransactionsFor(
  ctx: SyncContext,
  payout: { id: string; legacyId: string; shopifyGid: string; transactionsSyncedAt: Date | null },
): Promise<void> {
  let after: string | null = null;

  for (;;) {
    const data: TransactionsPageData = await ctx.client.request<TransactionsPageData>(
      "PayoutTransactionsPage",
      PAYOUT_TRANSACTIONS_QUERY,
      { first: TRANSACTION_PAGE_SIZE, after, query: `payout_id:${payout.legacyId}` },
    );
    const connection = data.shopifyPaymentsAccount?.balanceTransactions;

    if (!connection) {
      logger.warn("sync.payouts_unavailable", { shop: ctx.shop, runId: ctx.runId });

      return;
    }

    const nodes = connection.edges.map((edge) => edge.node);
    const endCursor = connection.pageInfo.endCursor;
    const isLastPage = !connection.pageInfo.hasNextPage || !endCursor;

    await db.$transaction(async (tx) => {
      for (const node of nodes) {
        await upsertBalanceTransaction(tx, ctx, node, payout.id);
      }

      if (isLastPage && payout.transactionsSyncedAt === null) {
        await tx.payout.update({
          where: { id: payout.id },
          data: { transactionsSyncedAt: new Date() },
        });
      }
    });

    ctx.counters.transactionsSeen += nodes.length;

    logger.info("sync.page_committed", {
      shop: ctx.shop,
      runId: ctx.runId,
      resource: "balance_transactions",
      payout: payout.shopifyGid,
      rows: nodes.length,
      complete: isLastPage,
    });

    await ctx.heartbeat();

    if (isLastPage) {
      return;
    }

    after = endCursor;
  }
}

/**
 * Fetches transactions for every payout that is incomplete locally or has not
 * settled yet. A settled, fully stamped payout is never refetched.
 */
async function syncPayoutTransactions(ctx: SyncContext): Promise<void> {
  const targets = await db.payout.findMany({
    where: {
      shop: ctx.shop,
      OR: [{ transactionsSyncedAt: null }, { status: { notIn: TERMINAL_STATUSES } }],
    },
    orderBy: { issuedAt: "desc" },
    select: { id: true, legacyId: true, shopifyGid: true, transactionsSyncedAt: true },
  });

  for (const payout of targets) {
    await syncTransactionsFor(ctx, payout);
  }
}

/** Re-reads payouts that have not reached a terminal status yet. */
async function refreshNonTerminalPayouts(ctx: SyncContext): Promise<void> {
  const pending = await db.payout.findMany({
    where: { shop: ctx.shop, status: { notIn: TERMINAL_STATUSES } },
    orderBy: { issuedAt: "desc" },
    take: NON_TERMINAL_REFRESH_LIMIT,
  });

  for (const payout of pending) {
    const data = await ctx.client.request<PayoutByIdData>("PayoutById", PAYOUT_BY_ID_QUERY, {
      id: payout.shopifyGid,
    });
    const node = data.node;

    if (!node?.id || !node.net || !node.issuedAt || !node.status) {
      logger.warn("sync.payout_unreadable", {
        shop: ctx.shop,
        runId: ctx.runId,
        payout: payout.shopifyGid,
      });
      continue;
    }

    const fields = payoutFields(node as PayoutNode, ctx.ianaTimezone);

    if (!isUnchanged(payout, fields)) {
      await db.payout.update({ where: { id: payout.id }, data: fields });
      logger.info("sync.payout_refreshed", {
        shop: ctx.shop,
        runId: ctx.runId,
        payout: payout.shopifyGid,
        status: fields.status,
      });
    }

    await ctx.heartbeat();
  }
}

export async function syncPayouts(ctx: SyncContext): Promise<void> {
  const cursor = await db.syncCursor.findUnique({
    where: { shop_resource: { shop: ctx.shop, resource: "payouts" } },
  });
  const stopBefore = cursor?.watermark
    ? new Date(cursor.watermark.getTime() - PAYOUT_OVERLAP_MS)
    : null;

  let after: string | null = null;
  let newest: Date | null = null;

  for (;;) {
    // Annotated because `after` is fed back from this response, which would
    // otherwise make the inference circular.
    const data: PayoutsPageData = await ctx.client.request<PayoutsPageData>(
      "PayoutsPage",
      PAYOUTS_PAGE_QUERY,
      { first: PAYOUT_PAGE_SIZE, after },
    );
    const connection = data.shopifyPaymentsAccount?.payouts;

    if (!connection) {
      logger.warn("sync.payouts_unavailable", { shop: ctx.shop, runId: ctx.runId });

      return;
    }

    const nodes = connection.edges.map((edge) => edge.node);
    let reachedWatermark = false;

    for (const node of nodes) {
      const issuedAt = instantOf(node.issuedAt, node.id, "issuedAt");

      if (!newest || issuedAt > newest) {
        newest = issuedAt;
      }

      if (stopBefore && issuedAt < stopBefore) {
        reachedWatermark = true;
      }
    }

    const endCursor = connection.pageInfo.endCursor;
    const isLastPage = !connection.pageInfo.hasNextPage || !endCursor || reachedWatermark;

    await commitPayoutPage(ctx, nodes, isLastPage ? newest : null);
    await ctx.heartbeat();

    if (isLastPage) {
      break;
    }

    after = endCursor;
  }

  await refreshNonTerminalPayouts(ctx);
  await syncPayoutTransactions(ctx);
}
