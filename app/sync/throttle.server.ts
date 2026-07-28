import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import { UpstreamError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";

// The single Admin API path. Every Shopify call in the app goes through a
// client built here, so cost accounting and throttling are impossible to
// bypass by accident.
//
// Shopify meters GraphQL by cost, not by request count: each response reports
// what the call cost and how much of the leaky bucket is left. The client
// remembers the last actual cost of each named operation, sleeps before a call
// that the remaining budget cannot cover, and retries a rejected call once
// after the computed wait.

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ThrottleStatus;
}

interface GraphqlBody<T> {
  data?: T;
  errors?: { message?: string; extensions?: { code?: string } }[];
  extensions?: { cost?: GraphqlCost };
}

/** Runs one GraphQL document and returns the parsed response body. */
export type GraphqlExecutor = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;

export interface ThrottledClient {
  request<T>(operation: string, query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface ThrottledClientOptions {
  runId?: string;
  sleep?: (ms: number) => Promise<void>;
}

/** Cost assumed for an operation whose real cost has not been observed yet. */
export const DEFAULT_COST_ESTIMATE = 50;

/** Upper bound on a single pacing sleep, so a bad restore rate cannot stall a run. */
export const MAX_SLEEP_MS = 60_000;

/** Wait before retrying a transport failure that carried no cost information. */
export const RETRY_DELAY_MS = 1_000;

/**
 * Milliseconds to wait until `needed` cost points are available again. Pure:
 * the pacing decision is a function of the last reported throttle status and
 * the estimated cost of the next call.
 */
export function computeSleepMs(status: ThrottleStatus, needed: number): number {
  if (needed <= status.currentlyAvailable) {
    return 0;
  }

  // A missing or nonsensical restore rate must not divide by zero; one point
  // per second is the slowest rate Shopify documents.
  const restoreRate = status.restoreRate > 0 ? status.restoreRate : 1;
  const waitMs = Math.ceil(((needed - status.currentlyAvailable) / restoreRate) * 1000);

  return Math.min(waitMs, MAX_SLEEP_MS);
}

/** Budget left after waiting `waitMs`, capped at the bucket size. */
function restored(status: ThrottleStatus, waitMs: number): ThrottleStatus {
  const gained = (waitMs / 1000) * (status.restoreRate > 0 ? status.restoreRate : 1);

  return {
    ...status,
    currentlyAvailable: Math.min(status.maximumAvailable, status.currentlyAvailable + gained),
  };
}

function isThrottled(body: GraphqlBody<unknown>): boolean {
  return (body.errors ?? []).some(
    (error) => error.extensions?.code === "THROTTLED" || /throttled/i.test(error.message ?? ""),
  );
}

function errorSummary(body: GraphqlBody<unknown>): string {
  return (body.errors ?? [])
    .map((error) => error.message ?? "unknown GraphQL error")
    .join("; ")
    .slice(0, 300);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adapts the Shopify Remix admin context to the executor the client drives. */
export function adminExecutor(admin: AdminApiContext): GraphqlExecutor {
  return async (query, variables) => {
    const response = await admin.graphql(query, { variables });

    return response.json();
  };
}

export function createThrottledClient(
  execute: GraphqlExecutor,
  shop: string,
  options: ThrottledClientOptions = {},
): ThrottledClient {
  const sleep = options.sleep ?? defaultSleep;
  const runId = options.runId;
  const lastCost = new Map<string, number>();
  let status: ThrottleStatus | null = null;

  function estimateFor(operation: string): number {
    return lastCost.get(operation) ?? DEFAULT_COST_ESTIMATE;
  }

  async function callOnce<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown> | undefined,
  ): Promise<GraphqlBody<T>> {
    const needed = estimateFor(operation);

    if (status) {
      const waitMs = computeSleepMs(status, needed);

      if (waitMs > 0) {
        logger.warn("sync.throttled", {
          shop,
          runId,
          operation,
          reason: "budget",
          waitMs,
          available: status.currentlyAvailable,
          needed,
        });
        await sleep(waitMs);
        status = restored(status, waitMs);
      }
    }

    let raw: unknown;

    try {
      raw = await execute(query, variables);
    } catch (error) {
      throw new UpstreamError(
        `Shopify request ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    if (!raw || typeof raw !== "object") {
      throw new UpstreamError(`Shopify returned an unreadable response for ${operation}`, true);
    }

    const body = raw as GraphqlBody<T>;
    const cost = body.extensions?.cost;

    if (cost?.throttleStatus) {
      // The sync engine issues one request at a time per client, so the call
      // that just returned is the only writer of this budget.
      // eslint-disable-next-line require-atomic-updates
      status = cost.throttleStatus;
      lastCost.set(operation, cost.actualQueryCost ?? cost.requestedQueryCost);
    }

    return body;
  }

  async function request<T>(
    operation: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let body: GraphqlBody<T>;

      try {
        body = await callOnce<T>(operation, query, variables);
      } catch (error) {
        if (attempt === 1 && error instanceof UpstreamError && error.retryable) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        throw error;
      }

      if (isThrottled(body)) {
        if (attempt === 2) {
          throw new UpstreamError(
            `Shopify throttled ${operation} twice; the next run resumes from the last committed page.`,
          );
        }

        const waitMs = status
          ? Math.max(computeSleepMs(status, estimateFor(operation)), RETRY_DELAY_MS)
          : RETRY_DELAY_MS;

        logger.warn("sync.throttled", { shop, runId, operation, reason: "rejected", waitMs });
        await sleep(waitMs);
        continue;
      }

      if (body.errors?.length) {
        throw new UpstreamError(`Shopify rejected ${operation}: ${errorSummary(body)}`);
      }

      if (body.data === undefined || body.data === null) {
        throw new UpstreamError(`Shopify returned no data for ${operation}`);
      }

      return body.data;
    }

    throw new UpstreamError(`Shopify request ${operation} exhausted its retries`);
  }

  return { request };
}
