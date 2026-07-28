import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Banner, BlockStack, Card, EmptyState, Page, Text } from "@shopify/polaris";

import db from "~/db.server";
import { apiError, newRequestId } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { liveRun, startRun } from "~/sync/run.server";
import { adminExecutor } from "~/sync/throttle.server";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const runs = await db.syncRun.findMany({
    where: { shop: session.shop },
    orderBy: { startedAt: "desc" },
    take: 5,
  });

  // A run left `running` by a crashed process is not in progress, and must not
  // sit on the manual trigger until the next poll supersedes it.
  return json({
    activeRun: liveRun(runs),
    lastRun: runs.find((run) => run.status !== "running") ?? null,
  });
}

/**
 * Manual trigger. It shares the claim path with the poller and the webhook,
 * so a second press while a run is alive is a CONFLICT rather than a second
 * run.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const requestId = newRequestId();
  const form = await request.formData();

  if (form.get("intent") !== "syncNow") {
    return json(apiError("INVALID_INPUT", "Unknown action.", requestId), { status: 400 });
  }

  try {
    const runId = await startRun(adminExecutor(admin), session.shop, "manual");

    if (!runId) {
      return json(apiError("CONFLICT", "A sync is already in progress", requestId), {
        status: 409,
      });
    }

    return json({ ok: true, runId });
  } catch (error) {
    logger.error("sync.manual_failed", {
      shop: session.shop,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });

    return json(apiError("INTERNAL", "Could not start a sync. Try again in a moment.", requestId), {
      status: 500,
    });
  }
}

// Placeholder payout list. Phase 4 replaces the empty state with the filtered
// IndexTable described in docs/design.md.
export default function PayoutList() {
  const { activeRun, lastRun } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const failure = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const busy = fetcher.state !== "idle" || Boolean(activeRun);

  return (
    <Page
      title="Payouts"
      primaryAction={{
        content: busy ? "Syncing" : "Sync now",
        loading: busy,
        disabled: busy,
        onAction: () => fetcher.submit({ intent: "syncNow" }, { method: "post" }),
      }}
    >
      <BlockStack gap="400">
        {failure ? (
          <Banner tone="warning" title="Sync not started">
            <Text as="p">{failure.message}</Text>
          </Banner>
        ) : null}
        {lastRun && !activeRun ? (
          <Banner tone={lastRun.status === "completed" ? "info" : "critical"}>
            <Text as="p">
              {`Last sync ${lastRun.status}: ${lastRun.payoutsSeen} payouts, ${lastRun.transactionsSeen} transactions, ${lastRun.ordersSeen} orders.`}
            </Text>
          </Banner>
        ) : null}
        <Card>
          <BlockStack gap="400">
            <EmptyState heading="No payouts synced yet" image="">
              <Text as="p">
                Once a sync runs, every Shopify Payments payout appears here with its reconciliation
                status.
              </Text>
            </EmptyState>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
