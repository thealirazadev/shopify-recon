import type { SyncTrigger } from "./run.server";
import { startRun } from "./run.server";
import { adminExecutor } from "./throttle.server";

import db from "~/db.server";
import { logger } from "~/lib/logger.server";
import { unauthenticated } from "~/shopify.server";

// The poller alone guarantees convergence; the payouts webhook only shortens
// the wait. Both funnel into the same claim path, so a duplicate delivery or
// an overlapping tick collapses into one run.
//
// State is module-level and HMR-guarded the same way the Prisma client is:
// exactly one app instance runs in production, so an in-memory pending set is
// enough and nothing is lost by a restart that the interval does not redo.

const TICK_MS = 15_000;
const DEFAULT_POLL_MINUTES = 360;

interface PollerState {
  timer: NodeJS.Timeout | null;
  pending: Set<string>;
  lastStartedAt: Map<string, number>;
}

declare global {
  // eslint-disable-next-line no-var
  var reconPollerGlobal: PollerState | undefined;
}

const state: PollerState = global.reconPollerGlobal ?? {
  timer: null,
  pending: new Set<string>(),
  lastStartedAt: new Map<string, number>(),
};

global.reconPollerGlobal = state;

function pollIntervalMs(): number {
  const minutes = Number(process.env.RECON_POLL_MINUTES);

  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_POLL_MINUTES) * 60_000;
}

/** Records that a shop should sync soon. The next tick picks it up. */
export function requestSync(shop: string): void {
  state.pending.add(shop);
}

async function beginRun(shop: string, trigger: SyncTrigger): Promise<void> {
  // Recorded before the attempt, not after it: a refused claim, a revoked
  // token, or any other failure has to back the shop off to the poll interval
  // as well, or a shop the app can no longer authenticate for is retried on
  // every tick forever.
  state.lastStartedAt.set(shop, Date.now());

  try {
    const { admin } = await unauthenticated.admin(shop);
    const runId = await startRun(adminExecutor(admin), shop, trigger);

    if (!runId) {
      logger.info("sync.trigger_skipped", { shop, trigger });
    }
  } catch (error) {
    logger.error("sync.trigger_failed", {
      shop,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One pass: the shops a webhook asked for, then every shop that is due. */
export async function tick(): Promise<void> {
  const requested = [...state.pending];

  state.pending.clear();

  for (const shop of requested) {
    await beginRun(shop, "webhook");
  }

  let installed: { shop: string }[];

  try {
    installed = await db.session.findMany({ distinct: ["shop"], select: { shop: true } });
  } catch (error) {
    logger.error("sync.poll_failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return;
  }

  const dueBefore = Date.now() - pollIntervalMs();

  for (const { shop } of installed) {
    const lastStartedAt = state.lastStartedAt.get(shop);

    if (lastStartedAt === undefined || lastStartedAt <= dueBefore) {
      await beginRun(shop, "poll");
    }
  }
}

/** Starts the interval once per process. Safe to call on every module reload. */
export function startPoller(): void {
  if (state.timer || process.env.NODE_ENV === "test") {
    return;
  }

  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      logger.error("sync.poll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, TICK_MS);

  // The poller must never be the reason the process stays alive.
  timer.unref();
  state.timer = timer;

  logger.info("sync.poller_started", { intervalMinutes: pollIntervalMs() / 60_000 });
}
