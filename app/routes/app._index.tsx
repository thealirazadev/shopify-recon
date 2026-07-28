import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { BlockStack, Card, EmptyState, Page, Text } from "@shopify/polaris";

import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return json({});
}

// Placeholder payout list. Phase 4 replaces the empty state with the filtered
// IndexTable described in docs/design.md.
export default function PayoutList() {
  return (
    <Page title="Payouts">
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
    </Page>
  );
}
