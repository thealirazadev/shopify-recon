import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { boundary } from "@shopify/shopify-app-remix/server";

import { ensureShopSettings } from "~/lib/shop.server";
import { adminExecutor, createThrottledClient } from "~/sync/throttle.server";
import { authenticate } from "~/shopify.server";

// Every embedded route under app.* authenticates via authenticate.admin,
// which redirects into OAuth when there is no valid session token.
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  await ensureShopSettings(createThrottledClient(adminExecutor(admin), session.shop), session.shop);

  return json({ apiKey: process.env.SHOPIFY_API_KEY ?? "" });
}

export default function AppLayout() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey} i18n={polarisTranslations}>
      <NavMenu>
        <Link to="/app" rel="home">
          Payouts
        </Link>
        <Link to="/app/discrepancies">Discrepancies</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Required so the package can convert auth redirects into the headers the
// embedded iframe understands.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
