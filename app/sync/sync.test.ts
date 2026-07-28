import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SyncTrigger } from "./run.server";

// The engine runs against a real SQLite file (fresh per test) and a stubbed
// GraphQL executor backed by fixture pages. No test ever reaches Shopify: the
// fixtures are shaped from docs/api-contracts.md, not recorded from a store.

const SHOP = "recon-test.myshopify.com";
const workDir = mkdtempSync(join(tmpdir(), "shopify-recon-"));
const templateFile = join(workDir, "template.sqlite");

let dbCount = 0;
let db: PrismaClient;

beforeAll(() => {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${templateFile}` },
    stdio: "pipe",
  });
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  await db?.$disconnect();
});

/** A fresh database file plus engine modules bound to it. */
async function freshEngine() {
  dbCount += 1;

  const file = join(workDir, `test-${dbCount}.sqlite`);

  copyFileSync(templateFile, file);
  process.env.DATABASE_URL = `file:${file}`;
  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
  vi.resetModules();

  const dbModule = await import("~/db.server");
  const runModule = await import("./run.server");

  db = dbModule.default;

  return runModule;
}

type Engine = Awaited<ReturnType<typeof freshEngine>>;

async function claimOrThrow(engine: Engine, trigger: SyncTrigger): Promise<string> {
  const runId = await engine.claimRun(SHOP, trigger);

  if (!runId) {
    throw new Error("expected to claim the sync slot");
  }

  return runId;
}

const noSleep = async () => {};

function money(amount: string) {
  return { amount, currencyCode: "USD" };
}

function ok(data: unknown, currentlyAvailable = 900) {
  return {
    data,
    extensions: {
      cost: {
        requestedQueryCost: 20,
        actualQueryCost: 20,
        throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate: 50 },
      },
    },
  };
}

const THROTTLED = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: {
    cost: {
      requestedQueryCost: 20,
      actualQueryCost: null,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 2, restoreRate: 50 },
    },
  },
};

const SHOP_INFO = {
  shop: { myshopifyDomain: SHOP, ianaTimezone: "America/New_York", currencyCode: "USD" },
};

const PAYOUT_PAID = {
  id: "gid://shopify/ShopifyPaymentsPayout/9001",
  issuedAt: "2026-07-24T13:00:00Z",
  status: "PAID",
  net: money("1450.90"),
  summary: {
    chargesGross: money("1608.00"),
    chargesFee: money("47.10"),
    refundsGross: money("-110.00"),
    refundsFee: money("0.00"),
    adjustmentsGross: money("0.00"),
    adjustmentsFee: money("0.00"),
  },
};

const PAYOUT_IN_TRANSIT = {
  id: "gid://shopify/ShopifyPaymentsPayout/9002",
  issuedAt: "2026-07-25T13:00:00Z",
  status: "IN_TRANSIT",
  net: money("200.00"),
  summary: { chargesGross: money("206.00"), chargesFee: money("6.00") },
};

const CHARGE_9001 = {
  id: "gid://shopify/ShopifyPaymentsBalanceTransaction/1001",
  type: "charge",
  transactionDate: "2026-07-23T14:02:11Z",
  amount: money("1608.00"),
  fee: money("47.10"),
  net: money("1560.90"),
  sourceId: "7001",
  sourceType: "charge",
  sourceOrderTransactionId: "7001",
  associatedOrder: { id: "gid://shopify/Order/5001", name: "#1001" },
};

const REFUND_9001 = {
  id: "gid://shopify/ShopifyPaymentsBalanceTransaction/1002",
  type: "refund",
  transactionDate: "2026-07-23T16:00:00Z",
  amount: money("-110.00"),
  fee: money("0.00"),
  net: money("-110.00"),
  sourceId: "7002",
  sourceType: "refund",
  sourceOrderTransactionId: "7002",
  associatedOrder: { id: "gid://shopify/Order/5001", name: "#1001" },
};

const CHARGE_9002 = {
  id: "gid://shopify/ShopifyPaymentsBalanceTransaction/1003",
  type: "charge",
  transactionDate: "2026-07-24T09:00:00Z",
  amount: money("206.00"),
  fee: money("6.00"),
  net: money("200.00"),
  sourceId: "7003",
  sourceType: "charge",
  sourceOrderTransactionId: "7003",
  associatedOrder: { id: "gid://shopify/Order/5999", name: "#1099" },
};

const ORDER_5001 = {
  id: "gid://shopify/Order/5001",
  name: "#1001",
  processedAt: "2026-07-23T13:55:00Z",
  updatedAt: "2026-07-23T16:05:00Z",
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  totalPriceSet: { shopMoney: money("1608.00") },
  transactions: [
    {
      id: "gid://shopify/OrderTransaction/7001",
      kind: "SALE",
      status: "SUCCESS",
      gateway: "shopify_payments",
      processedAt: "2026-07-23T13:55:00Z",
      amountSet: { shopMoney: money("1608.00") },
    },
    {
      id: "gid://shopify/OrderTransaction/7002",
      kind: "REFUND",
      status: "SUCCESS",
      gateway: "shopify_payments",
      processedAt: "2026-07-23T15:58:00Z",
      amountSet: { shopMoney: money("110.00") },
    },
  ],
  refunds: [
    {
      id: "gid://shopify/Refund/8001",
      createdAt: "2026-07-23T15:58:00Z",
      totalRefundedSet: { shopMoney: money("110.00") },
    },
  ],
};

const ORDER_5999 = {
  id: "gid://shopify/Order/5999",
  name: "#1099",
  processedAt: "2026-07-24T08:50:00Z",
  updatedAt: "2026-07-24T08:55:00Z",
  displayFinancialStatus: "PAID",
  totalPriceSet: { shopMoney: money("206.00") },
  transactions: [
    {
      id: "gid://shopify/OrderTransaction/7003",
      kind: "SALE",
      status: "SUCCESS",
      gateway: "shopify_payments",
      processedAt: "2026-07-24T08:50:00Z",
      amountSet: { shopMoney: money("206.00") },
    },
  ],
  refunds: [],
};

type Variables = Record<string, unknown>;
type Handler = (variables: Variables, query: string) => unknown;

/**
 * A fixture reduced to the fields its document actually selects. Shopify never
 * returns a field the query did not ask for, so neither does the stub: a query
 * that forgets a column must not be rescued by a generous fixture.
 */
function selectedFields(node: Record<string, unknown>, query: string): Record<string, unknown> {
  if (query.includes("summary")) {
    return node;
  }

  const projected = { ...node };

  delete projected.summary;

  return projected;
}

function transactionsPage(nodes: unknown[], endCursor: string | null = null) {
  return ok({
    shopifyPaymentsAccount: {
      balanceTransactions: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: Boolean(endCursor), endCursor },
      },
    },
  });
}

function payoutIdOf(variables: Variables): string {
  return String(variables.query ?? "").split(":")[1] ?? "";
}

function makeStub(overrides: Record<string, Handler> = {}) {
  const calls: { operation: string; variables: Variables }[] = [];
  const handlers: Record<string, Handler> = {
    ShopInfo: () => ok(SHOP_INFO),
    PayoutsPage: () =>
      ok({
        shopifyPaymentsAccount: {
          payouts: {
            edges: [{ node: PAYOUT_PAID }, { node: PAYOUT_IN_TRANSIT }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    PayoutById: (variables, query) =>
      ok({
        node: selectedFields(
          variables.id === PAYOUT_IN_TRANSIT.id ? PAYOUT_IN_TRANSIT : PAYOUT_PAID,
          query,
        ),
      }),
    PayoutTransactionsPage: (variables) =>
      payoutIdOf(variables) === "9001"
        ? transactionsPage([CHARGE_9001, REFUND_9001])
        : transactionsPage([CHARGE_9002]),
    OrdersDelta: () =>
      ok({
        orders: {
          edges: [{ node: ORDER_5001 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    OrderById: (variables) => ok({ node: variables.id === ORDER_5999.id ? ORDER_5999 : null }),
    ...overrides,
  };

  const execute = async (query: string, variables: Variables = {}) => {
    const operation = /query (\w+)/.exec(query)?.[1] ?? "unknown";

    calls.push({ operation, variables });

    const handler = handlers[operation];

    if (!handler) {
      throw new Error(`no stub for operation ${operation}`);
    }

    return handler(variables, query);
  };

  return { execute, calls };
}

/** Every mirrored row, serialized, so a re-run can be compared byte for byte. */
async function snapshot(): Promise<string> {
  const order = { orderBy: { id: "asc" as const } };
  const [shops, payouts, transactions, orders, orderTransactions, refunds, cursors] =
    await Promise.all([
      db.shop.findMany(order),
      db.payout.findMany(order),
      db.balanceTransaction.findMany(order),
      db.order.findMany(order),
      db.orderTransaction.findMany(order),
      db.refund.findMany(order),
      db.syncCursor.findMany(order),
    ]);

  return JSON.stringify(
    { shops, payouts, transactions, orders, orderTransactions, refunds, cursors },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
}

describe("sync engine", () => {
  it("mirrors payouts, transactions, orders and refunds from fixture pages", async () => {
    const engine = await freshEngine();
    const stub = makeStub();
    const runId = await claimOrThrow(engine, "manual");

    await engine.executeRun(stub.execute, SHOP, runId, { sleep: noSleep });

    const run = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });

    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.payoutsSeen).toBe(2);
    expect(run.transactionsSeen).toBe(3);
    expect(run.ordersSeen).toBe(2);

    const payout = await db.payout.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: PAYOUT_PAID.id },
    });

    expect(payout.legacyId).toBe("9001");
    expect(payout.status).toBe("paid");
    expect(payout.netMinor).toBe(145090n);
    // 13:00 UTC is 09:00 the same day in America/New_York.
    expect(payout.payoutDate).toBe("2026-07-24");
    expect(payout.transactionsSyncedAt).not.toBeNull();
    expect(JSON.parse(payout.summaryJson)).toStrictEqual({
      chargesGross: "160800",
      chargesFee: "4710",
      refundsGross: "-11000",
      refundsFee: "0",
      adjustmentsGross: "0",
      adjustmentsFee: "0",
    });

    const charge = await db.balanceTransaction.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: CHARGE_9001.id },
    });

    expect(charge.payoutId).toBe(payout.id);
    expect(charge.amountMinor).toBe(160800n);
    expect(charge.feeMinor).toBe(4710n);
    expect(charge.netMinor).toBe(156090n);
    // The legacy numeric source id is promoted to the gid the mirror joins on.
    expect(charge.sourceOrderTransactionId).toBe("gid://shopify/OrderTransaction/7001");
    expect(charge.associatedOrderGid).toBe("gid://shopify/Order/5001");
    expect(charge.matchState).toBe("unmatched");

    const refundLine = await db.balanceTransaction.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: REFUND_9001.id },
    });

    expect(refundLine.amountMinor).toBe(-11000n);

    // Order 5999 is only reachable through the targeted fetch: no order page
    // ever returns it, but a payout line points at it.
    const fetched = await db.order.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: ORDER_5999.id },
    });

    expect(fetched.totalMinor).toBe(20600n);
    expect(fetched.financialStatus).toBe("paid");

    expect(await db.order.count()).toBe(2);
    expect(await db.orderTransaction.count()).toBe(3);
    expect(await db.refund.count()).toBe(1);

    const cursors = await db.syncCursor.findMany({ orderBy: { resource: "asc" } });

    expect(
      cursors.map((cursor) => [cursor.resource, cursor.watermark?.toISOString()]),
    ).toStrictEqual([
      ["orders", "2026-07-23T16:05:00.000Z"],
      ["payouts", "2026-07-25T13:00:00.000Z"],
    ]);
  });

  it("keeps the stored summary when a non-terminal payout is refreshed", async () => {
    const engine = await freshEngine();

    await engine.executeRun(makeStub().execute, SHOP, await claimOrThrow(engine, "manual"), {
      sleep: noSleep,
    });

    const refreshed = await db.payout.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: PAYOUT_IN_TRANSIT.id },
    });

    // The in-transit payout is re-read by node lookup in the same run. That
    // lookup must carry the summary, or the refresh blanks a column the
    // payouts page already filled in.
    expect(JSON.parse(refreshed.summaryJson)).toStrictEqual({
      chargesGross: "20600",
      chargesFee: "600",
    });
  });

  it("changes nothing when the same fixtures are synced twice", async () => {
    const engine = await freshEngine();
    const stub = makeStub();

    await engine.executeRun(stub.execute, SHOP, await claimOrThrow(engine, "manual"), {
      sleep: noSleep,
    });

    const before = await snapshot();

    await engine.executeRun(stub.execute, SHOP, await claimOrThrow(engine, "poll"), {
      sleep: noSleep,
    });

    const after = await snapshot();

    // Byte-identical, including every updatedAt: no-op writes are skipped
    // rather than left to Prisma's @updatedAt.
    expect(after).toBe(before);
  });

  it("refetches a payout from page one after a crash mid transactions", async () => {
    const engine = await freshEngine();
    let transactionCalls = 0;
    const crashing = makeStub({
      PayoutTransactionsPage: (variables) => {
        if (payoutIdOf(variables) !== "9001") {
          return transactionsPage([CHARGE_9002]);
        }

        transactionCalls += 1;

        if (transactionCalls === 1) {
          return transactionsPage([CHARGE_9001], "cursor-page-1");
        }

        throw new Error("connection reset by peer");
      },
    });

    await engine.executeRun(crashing.execute, SHOP, await claimOrThrow(engine, "manual"), {
      sleep: noSleep,
    });

    const crashed = await db.payout.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: PAYOUT_PAID.id },
    });

    expect(crashed.transactionsSyncedAt).toBeNull();
    expect(await db.balanceTransaction.count({ where: { payoutId: crashed.id } })).toBe(1);

    const healthy = makeStub();

    await engine.executeRun(healthy.execute, SHOP, await claimOrThrow(engine, "poll"), {
      sleep: noSleep,
    });

    const resumed = healthy.calls.filter(
      (call) =>
        call.operation === "PayoutTransactionsPage" && payoutIdOf(call.variables) === "9001",
    );

    expect(resumed[0].variables.after).toBeNull();

    const converged = await db.payout.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: PAYOUT_PAID.id },
    });

    expect(converged.transactionsSyncedAt).not.toBeNull();
    expect(await db.balanceTransaction.count({ where: { payoutId: converged.id } })).toBe(2);
    expect(await db.balanceTransaction.count()).toBe(3);
  });

  it("records a failed run when a page keeps failing", async () => {
    const engine = await freshEngine();
    const broken = makeStub({
      PayoutsPage: () => {
        throw new Error("connection reset by peer");
      },
    });
    const runId = await claimOrThrow(engine, "manual");

    await engine.executeRun(broken.execute, SHOP, runId, { sleep: noSleep });

    const run = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/connection reset/);
    expect(run.finishedAt).not.toBeNull();
  });

  it("stores an unfamiliar transaction type verbatim instead of failing", async () => {
    const engine = await freshEngine();
    const odd = {
      ...CHARGE_9002,
      id: "gid://shopify/ShopifyPaymentsBalanceTransaction/1004",
      type: "PAYOUT_FEE_CORRECTION",
    };
    const stub = makeStub({
      PayoutTransactionsPage: (variables) =>
        payoutIdOf(variables) === "9001"
          ? transactionsPage([CHARGE_9001, REFUND_9001])
          : transactionsPage([odd]),
    });
    const runId = await claimOrThrow(engine, "manual");

    await engine.executeRun(stub.execute, SHOP, runId, { sleep: noSleep });

    const run = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
    const stored = await db.balanceTransaction.findFirstOrThrow({
      where: { shop: SHOP, shopifyGid: odd.id },
    });

    expect(run.status).toBe("completed");
    expect(stored.type).toBe("payout_fee_correction");
  });
});

describe("run claims", () => {
  it("collapses two concurrent triggers into one running run", async () => {
    const engine = await freshEngine();
    const [first, second] = await Promise.all([
      engine.claimRun(SHOP, "manual"),
      engine.claimRun(SHOP, "poll"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.syncRun.count({ where: { shop: SHOP, status: "running" } })).toBe(1);
  });

  it("supersedes a run whose heartbeat went stale", async () => {
    const engine = await freshEngine();
    const now = new Date();
    const stale = await db.syncRun.create({
      data: {
        shop: SHOP,
        trigger: "poll",
        status: "running",
        startedAt: new Date(now.getTime() - 3_600_000),
        heartbeatAt: new Date(now.getTime() - engine.STALE_RUN_MS - 1_000),
      },
    });
    const runId = await claimOrThrow(engine, "manual");
    const previous = await db.syncRun.findUniqueOrThrow({ where: { id: stale.id } });

    expect(previous.status).toBe("superseded");
    expect(previous.finishedAt).not.toBeNull();
    expect(await db.syncRun.count({ where: { shop: SHOP, status: "running" } })).toBe(1);
    expect(runId).not.toBe(stale.id);
  });

  it("keeps a live run and refuses the second claim", async () => {
    const engine = await freshEngine();

    await claimOrThrow(engine, "poll");

    expect(await engine.claimRun(SHOP, "manual")).toBeNull();
  });
});

describe("throttling", () => {
  it("fails the run with cursors intact after a second throttle", async () => {
    const engine = await freshEngine();

    await engine.executeRun(makeStub().execute, SHOP, await claimOrThrow(engine, "manual"), {
      sleep: noSleep,
    });

    const before = await db.syncCursor.findMany({ orderBy: { resource: "asc" } });
    const slept: number[] = [];
    const throttled = makeStub({ PayoutsPage: () => THROTTLED });
    const runId = await claimOrThrow(engine, "poll");

    await engine.executeRun(throttled.execute, SHOP, runId, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const run = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
    const after = await db.syncCursor.findMany({ orderBy: { resource: "asc" } });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/throttled/i);
    expect(slept.length).toBeGreaterThan(0);
    expect(after.map((cursor) => cursor.watermark?.toISOString())).toStrictEqual(
      before.map((cursor) => cursor.watermark?.toISOString()),
    );
  });
});
