import type { Prisma } from "@prisma/client";

import type { SyncContext } from "./run.server";

import db from "~/db.server";
import { isUnchanged } from "~/lib/diff";
import { UpstreamError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { parseMoney } from "~/lib/money";

// Orders sync forward by an updated_at watermark, with transactions and
// refunds inline so one page is one self-contained commit. The watermark is
// rewound two minutes on every run because Shopify's updated_at has no
// ordering guarantee at the millisecond boundary; upserts make the overlap
// free.

export const ORDER_PAGE_SIZE = 25;

/** How far the order watermark is rewound before each run. */
export const ORDER_OVERLAP_MS = 2 * 60 * 1000;

const ORDER_NODE_FIELDS = `
  id
  name
  processedAt
  updatedAt
  currencyCode
  displayFinancialStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  transactions(first: 50) {
    id
    kind
    status
    gateway
    processedAt
    amountSet { shopMoney { amount currencyCode } }
  }
  refunds(first: 50) {
    id
    createdAt
    totalRefundedSet { shopMoney { amount currencyCode } }
  }`;

const ORDERS_DELTA_QUERY = `#graphql
  query OrdersDelta($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {${ORDER_NODE_FIELDS}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

interface ShopMoney {
  shopMoney?: { amount: string; currencyCode: string } | null;
}

interface OrderTransactionNode {
  id: string;
  kind?: string | null;
  status?: string | null;
  gateway?: string | null;
  processedAt?: string | null;
  amountSet?: ShopMoney | null;
}

interface RefundNode {
  id: string;
  createdAt?: string | null;
  totalRefundedSet?: ShopMoney | null;
}

export interface OrderNode {
  id: string;
  name?: string | null;
  processedAt?: string | null;
  updatedAt: string;
  displayFinancialStatus?: string | null;
  totalPriceSet?: ShopMoney | null;
  transactions?: OrderTransactionNode[] | null;
  refunds?: RefundNode[] | null;
}

interface OrdersDeltaData {
  orders: {
    edges: { node: OrderNode }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface OrderFields {
  name: string;
  currency: string;
  totalMinor: bigint;
  financialStatus: string | null;
  processedAt: Date;
  shopifyUpdatedAt: Date;
}

function instantOf(value: string, gid: string, field: string): Date {
  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    throw new UpstreamError(`${gid} has an unreadable ${field}`);
  }

  return instant;
}

function shopMoneyOf(set: ShopMoney | null | undefined, gid: string, field: string) {
  const money = set?.shopMoney;

  if (!money?.amount || !money.currencyCode) {
    throw new UpstreamError(`${gid} has no shop-currency ${field}`);
  }

  return money;
}

function orderFields(node: OrderNode): OrderFields {
  const money = shopMoneyOf(node.totalPriceSet, node.id, "total");
  const shopifyUpdatedAt = instantOf(node.updatedAt, node.id, "updatedAt");

  return {
    name: node.name ?? "",
    currency: money.currencyCode,
    totalMinor: parseMoney(money.amount, money.currencyCode),
    financialStatus: node.displayFinancialStatus
      ? String(node.displayFinancialStatus).toLowerCase()
      : null,
    // Unprocessed orders still need a date for aging detection; the last
    // update is the closest honest stand-in.
    processedAt: node.processedAt
      ? instantOf(node.processedAt, node.id, "processedAt")
      : shopifyUpdatedAt,
    shopifyUpdatedAt,
  };
}

async function upsertOrderTransaction(
  tx: Prisma.TransactionClient,
  ctx: SyncContext,
  node: OrderTransactionNode,
  orderId: string,
  fallbackProcessedAt: Date,
): Promise<void> {
  const money = shopMoneyOf(node.amountSet, node.id, "amount");
  const fields = {
    orderId,
    kind: String(node.kind ?? "").toLowerCase(),
    status: String(node.status ?? "").toLowerCase(),
    gateway: node.gateway ?? "",
    amountMinor: parseMoney(money.amount, money.currencyCode),
    currency: money.currencyCode,
    processedAt: node.processedAt
      ? instantOf(node.processedAt, node.id, "processedAt")
      : fallbackProcessedAt,
  };
  const existing = await tx.orderTransaction.findUnique({
    where: { shop_shopifyGid: { shop: ctx.shop, shopifyGid: node.id } },
  });

  if (!existing) {
    await tx.orderTransaction.create({
      data: { shop: ctx.shop, shopifyGid: node.id, ...fields },
    });

    return;
  }

  if (!isUnchanged(existing, fields)) {
    await tx.orderTransaction.update({ where: { id: existing.id }, data: fields });
  }
}

async function upsertRefund(
  tx: Prisma.TransactionClient,
  ctx: SyncContext,
  node: RefundNode,
  orderId: string,
  fallbackProcessedAt: Date,
): Promise<void> {
  const money = shopMoneyOf(node.totalRefundedSet, node.id, "refunded total");
  const fields = {
    orderId,
    amountMinor: parseMoney(money.amount, money.currencyCode),
    currency: money.currencyCode,
    processedAt: node.createdAt
      ? instantOf(node.createdAt, node.id, "createdAt")
      : fallbackProcessedAt,
  };
  const existing = await tx.refund.findUnique({
    where: { shop_shopifyGid: { shop: ctx.shop, shopifyGid: node.id } },
  });

  if (!existing) {
    await tx.refund.create({ data: { shop: ctx.shop, shopifyGid: node.id, ...fields } });

    return;
  }

  if (!isUnchanged(existing, fields)) {
    await tx.refund.update({ where: { id: existing.id }, data: fields });
  }
}

/** Writes an order with its inline transactions and refunds. */
export async function upsertOrder(
  tx: Prisma.TransactionClient,
  ctx: SyncContext,
  node: OrderNode,
): Promise<void> {
  const fields = orderFields(node);
  const existing = await tx.order.findUnique({
    where: { shop_shopifyGid: { shop: ctx.shop, shopifyGid: node.id } },
  });
  let orderId: string;

  if (existing) {
    orderId = existing.id;

    if (!isUnchanged(existing, fields)) {
      await tx.order.update({ where: { id: orderId }, data: fields });
    }
  } else {
    const created = await tx.order.create({
      data: { shop: ctx.shop, shopifyGid: node.id, ...fields },
      select: { id: true },
    });

    orderId = created.id;
  }

  for (const transaction of node.transactions ?? []) {
    await upsertOrderTransaction(tx, ctx, transaction, orderId, fields.processedAt);
  }

  for (const refund of node.refunds ?? []) {
    await upsertRefund(tx, ctx, refund, orderId, fields.processedAt);
  }
}

export async function syncOrders(ctx: SyncContext): Promise<void> {
  const cursor = await db.syncCursor.findUnique({
    where: { shop_resource: { shop: ctx.shop, resource: "orders" } },
  });
  const since = cursor?.watermark ? new Date(cursor.watermark.getTime() - ORDER_OVERLAP_MS) : null;
  const query = since ? `updated_at:>=${since.toISOString()}` : null;

  let after: string | null = null;

  for (;;) {
    // Annotated because `after` is fed back from this response, which would
    // otherwise make the inference circular.
    const data: OrdersDeltaData = await ctx.client.request<OrdersDeltaData>(
      "OrdersDelta",
      ORDERS_DELTA_QUERY,
      { first: ORDER_PAGE_SIZE, after, query },
    );
    const nodes = data.orders.edges.map((edge) => edge.node);
    let watermark: Date | null = null;

    for (const node of nodes) {
      const updatedAt = instantOf(node.updatedAt, node.id, "updatedAt");

      if (!watermark || updatedAt > watermark) {
        watermark = updatedAt;
      }
    }

    await db.$transaction(async (tx) => {
      for (const node of nodes) {
        await upsertOrder(tx, ctx, node);
      }

      if (watermark) {
        await tx.syncCursor.upsert({
          where: { shop_resource: { shop: ctx.shop, resource: "orders" } },
          create: { shop: ctx.shop, resource: "orders", watermark },
          update: { watermark },
        });
      }
    });

    ctx.counters.ordersSeen += nodes.length;

    logger.info("sync.page_committed", {
      shop: ctx.shop,
      runId: ctx.runId,
      resource: "orders",
      rows: nodes.length,
      watermark: watermark?.toISOString(),
    });

    await ctx.heartbeat();

    const endCursor = data.orders.pageInfo.endCursor;

    if (!data.orders.pageInfo.hasNextPage || !endCursor) {
      return;
    }

    after = endCursor;
  }
}
