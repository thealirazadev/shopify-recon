import type { GraphqlExecutor, ThrottledClient } from "./throttle.server";
import { syncOrders } from "./orders.server";
import { syncPayouts } from "./payouts.server";
import { createThrottledClient } from "./throttle.server";

import db from "~/db.server";
import { logger } from "~/lib/logger.server";
import { loadShopSettings } from "~/lib/shop.server";

// Single flight per shop. A run is claimed by writing a SyncRun row inside a
// transaction that first checks no other run for the shop is still alive; a
// run whose heartbeat went stale (crashed process) is marked superseded by the
// claimant. That claim transaction is the only lock in the system.

/** A run whose heartbeat is older than this is treated as dead. */
export const STALE_RUN_MS = 5 * 60 * 1000;

export type SyncTrigger = "webhook" | "poll" | "manual";

export interface SyncCounters {
  payoutsSeen: number;
  transactionsSeen: number;
  ordersSeen: number;
}

/** Everything a sync module needs; passed down instead of re-read per page. */
export interface SyncContext {
  readonly shop: string;
  readonly runId: string;
  readonly client: ThrottledClient;
  readonly currency: string;
  readonly ianaTimezone: string;
  readonly counters: SyncCounters;
  heartbeat(): Promise<void>;
}

export function newCounters(): SyncCounters {
  return { payoutsSeen: 0, transactionsSeen: 0, ordersSeen: 0 };
}

/**
 * Claims the shop's sync slot. Returns the new run id, or null when another
 * run is alive, which is the CONFLICT every trigger path reports. Throws only
 * when the database itself fails, so a lost claim is never mistaken for a
 * busy shop.
 */
export async function claimRun(
  shop: string,
  trigger: SyncTrigger,
  now: Date = new Date(),
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const active = await tx.syncRun.findMany({
      where: { shop, status: "running" },
      select: { id: true, heartbeatAt: true },
    });
    const staleBefore = new Date(now.getTime() - STALE_RUN_MS);

    if (active.some((run) => run.heartbeatAt > staleBefore)) {
      return null;
    }

    if (active.length > 0) {
      await tx.syncRun.updateMany({
        where: { id: { in: active.map((run) => run.id) } },
        data: {
          status: "superseded",
          error: "Superseded after a stale heartbeat",
          finishedAt: now,
        },
      });

      logger.warn("sync.superseded", { shop, superseded: active.length });
    }

    const run = await tx.syncRun.create({
      data: { shop, trigger, status: "running", startedAt: now, heartbeatAt: now },
      select: { id: true },
    });

    return run.id;
  });
}

/**
 * Marks the run alive between pages. A failure here is logged, not thrown: a
 * missed heartbeat costs at most a supersede on the next trigger, whereas
 * aborting the run would throw away committed progress.
 */
export async function heartbeat(runId: string, now: Date = new Date()): Promise<void> {
  try {
    await db.syncRun.update({ where: { id: runId }, data: { heartbeatAt: now } });
  } catch (error) {
    logger.warn("sync.heartbeat_failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function completeRun(
  shop: string,
  runId: string,
  counters: SyncCounters,
): Promise<void> {
  await db.syncRun.update({
    where: { id: runId },
    data: { status: "completed", finishedAt: new Date(), ...counters },
  });

  logger.info("sync.completed", { shop, runId, ...counters });
}

/** Records the terminal failure state. Never throws: the caller already has one error. */
export async function failRun(
  shop: string,
  runId: string,
  counters: SyncCounters,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  logger.error("sync.failed", { shop, runId, error: message, ...counters });

  try {
    await db.syncRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: message.slice(0, 500),
        finishedAt: new Date(),
        ...counters,
      },
    });
  } catch (writeError) {
    logger.error("sync.status_write_failed", {
      shop,
      runId,
      error: writeError instanceof Error ? writeError.message : String(writeError),
    });
  }
}

export interface ExecuteRunOptions {
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs an already-claimed sync to a terminal state. Never throws: the outcome
 * of a run is the SyncRun row, and a background caller has nowhere to put an
 * exception. Cursors hold at the last committed page, so the next trigger
 * resumes rather than restarts.
 */
export async function executeRun(
  execute: GraphqlExecutor,
  shop: string,
  runId: string,
  options: ExecuteRunOptions = {},
): Promise<void> {
  const client = createThrottledClient(execute, shop, { runId, sleep: options.sleep });
  const counters = newCounters();

  logger.info("sync.started", { shop, runId });

  try {
    const settings = await loadShopSettings(client, shop);
    const ctx: SyncContext = {
      shop,
      runId,
      client,
      currency: settings.currency,
      ianaTimezone: settings.ianaTimezone,
      counters,
      heartbeat: () => heartbeat(runId),
    };

    await syncPayouts(ctx);
    await syncOrders(ctx);
    await completeRun(shop, runId, counters);
  } catch (error) {
    await failRun(shop, runId, counters, error);
  }
}

/**
 * Claims the shop's sync slot and runs it in the background. Returns the run
 * id, or null when a run is already active, which every trigger path reports
 * as CONFLICT.
 */
export async function startRun(
  execute: GraphqlExecutor,
  shop: string,
  trigger: SyncTrigger,
): Promise<string | null> {
  const runId = await claimRun(shop, trigger);

  if (!runId) {
    return null;
  }

  // Deliberately not awaited: the trigger answers immediately and the SyncRun
  // row carries the outcome. executeRun records its own failures, so this
  // catch only guards against an unexpected rejection escaping it.
  executeRun(execute, shop, runId).catch((error: unknown) => {
    logger.error("sync.failed", {
      shop,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return runId;
}
