# API Contracts: shopify-recon

Every route the app exposes, the webhooks it consumes, the shared JSON shapes, the Admin
GraphQL operations the sync engine runs, and the CSV format. Embedded routes authenticate via
Shopify session token (JWT from App Bridge) validated by `authenticate.admin(request)`;
webhooks authenticate via HMAC validated by `authenticate.webhook(request)`. This contract is
agreed before any code is written.

All amounts in JSON payloads are decimal strings formatted from minor units in the shop
currency (BigInt does not serialize to JSON); minor units appear only inside `detailJson`
values, as strings. Timestamps are ISO-8601 UTC; `payoutDate` and date-range params are
shop-local `YYYY-MM-DD`.

## Consistent error format

All JSON error responses use one shape:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Aging window must be between 1 and 90 days.",
    "requestId": "req_4f8a2c"
  }
}
```

| Code | When |
| --- | --- |
| `UNAUTHENTICATED` | Session token or HMAC validation failed. |
| `INVALID_INPUT` | Failed server-side validation; `message` names the field and rule. |
| `NOT_FOUND` | Row does not exist or belongs to another shop (indistinguishable by design). |
| `CONFLICT` | Illegal state transition: sync already running, discrepancy already resolved, export of a pending payout. |
| `UPSTREAM_ERROR` | Shopify API failure after retries. |
| `INTERNAL` | Unexpected error, including a failed CSV balance assertion. |

`message` is friendly and safe to show; `requestId` correlates with the server log line. Stack
traces, GraphQL error arrays, and upstream bodies are logged, never returned. Discrepancies and
match failures are **not** errors in this format - they are data returned by loaders, because a
payout that does not reconcile is a successful HTTP response.

## Shared JSON shapes

### Payout summary (list rows and detail header)

```json
{
  "id": "cjld2cjxh0000qzrm",
  "payoutDate": "2026-07-24",
  "status": "paid",
  "reconStatus": "variance",
  "currency": "USD",
  "net": "1450.20",
  "computed": {
    "gross": "1608.00",
    "fees": "-47.10",
    "refunds": "-110.00",
    "adjustments": "0.00",
    "net": "1450.90"
  },
  "variance": "0.70",
  "transactionsSyncedAt": "2026-07-25T02:11:04Z"
}
```

`computed` and `variance` are null while `reconStatus` is `pending`.

### Balance transaction line (payout detail rows)

```json
{
  "id": "cl3k9d0aa0001qzrm",
  "type": "charge",
  "transactionDate": "2026-07-23T14:02:11Z",
  "amount": "40.00",
  "fee": "1.46",
  "net": "38.54",
  "currency": "USD",
  "source": { "kind": "order_transaction", "orderName": "#1042", "orderGid": "gid://shopify/Order/5001" },
  "matchState": "matched",
  "matchReason": null
}
```

`source` is null when unresolved; `kind` is `order_transaction`, `refund`, or `adjustment`.

### Discrepancy (queue rows)

```json
{
  "id": "cm1a2b3c40002qzrm",
  "type": "fee_anomaly",
  "status": "open",
  "subject": { "type": "balance_transaction", "id": "cl3k9d0aa0001qzrm", "label": "#1042 charge" },
  "summary": "Fee 4.90 on 40.00 (12.25 percent) outside expected 2.90 percent + 0.30 (tolerance 0.50 percent)",
  "detail": { "expectedFeeMinor": "146", "actualFeeMinor": "490", "amountMinor": "4000" },
  "note": null,
  "firstSeenAt": "2026-07-25T02:11:05Z",
  "lastSeenAt": "2026-07-26T02:10:33Z",
  "resolvedAt": null
}
```

### Sync run (banner and history)

```json
{
  "id": "cn9x8y7z60003qzrm",
  "trigger": "poll",
  "status": "completed",
  "payoutsSeen": 4,
  "transactionsSeen": 312,
  "ordersSeen": 57,
  "startedAt": "2026-07-26T02:10:00Z",
  "finishedAt": "2026-07-26T02:10:41Z",
  "error": null
}
```

## OAuth routes

Identical to `shopify-bulk-editor`: `GET|POST /auth/*` delegates OAuth begin/callback to the
Shopify package; `GET|POST /auth/login` is the non-embedded shop-domain form. No app-specific
behavior.

## Embedded routes

All routes below require `authenticate.admin(request)`; unauthenticated requests redirect into
OAuth. Every read and write is scoped to the authenticated `session.shop`; a row id belonging
to another shop returns `NOT_FOUND`.

### `GET /app` - `app._index.tsx` payout list

- **Query params:** `reconStatus` (`pending` | `reconciled` | `variance`), `from`, `to`
  (shop-local dates over `payoutDate`), `page`.
- **Returns:**

```json
{
  "payouts": [ { "...": "payout summary" } ],
  "page": { "current": 1, "hasNext": true },
  "openDiscrepancies": 3,
  "activeRun": null,
  "lastRun": { "...": "sync run" },
  "currency": "USD"
}
```

Nonsense filter values yield an empty result set, not an error. The UI revalidates the loader
every 3 seconds while `activeRun` is non-null.

### `POST /app` - intent `syncNow`

- **Behavior:** Claims a sync run with trigger `manual`.
- **Success:** `{ "ok": true, "runId": "..." }`.
- **Errors:** `CONFLICT` when a run is already `running` for this shop (message: "A sync is
  already in progress").

### `GET /app/payouts/:id` - `app.payouts.$id.tsx`

- **Query params:** `matchState` filter, `page` (50 lines per page).
- **Returns:** `{ "payout": <payout summary>, "lines": [ <line>, ... ], "counts": { "matched": 40, "partial": 1, "unmatched": 0 }, "page": { ... } }`.
- **Errors:** `NOT_FOUND`.

### `GET /app/payouts/:id/export` - `app.payouts.$id.export.tsx` (resource route)

- Streams the payout's journal CSV. `Content-Type: text/csv`; attachment filename
  `recon-<shop>-payout-<payoutDate>.csv`.
- **Errors:** `NOT_FOUND`; `CONFLICT` while the payout's `reconStatus` is `pending`
  (incomplete data would mislead an accountant); `INTERNAL` if the balance assertion fails
  (logged with payout id and difference; no partial file is sent).

### `GET /app/export` - `app.export.tsx` (resource route)

- **Query params:** `from`, `to` (required, shop-local, `from <= to`, range <= 366 days).
- Streams one CSV containing the journal row set of every non-`pending` payout with
  `payoutDate` in range, ordered by `payoutDate`; skipped pending payouts are counted in a
  trailing comment row (see CSV contract). Filename `recon-<shop>-<from>-<to>.csv`.
- **Errors:** `INVALID_INPUT` (missing/reversed/oversized range), `INTERNAL` on a failed
  balance assertion.

### `GET /app/discrepancies` - `app.discrepancies.tsx`

- **Query params:** `type`, `status` (default `open`), `page`.
- **Returns:** `{ "discrepancies": [ <discrepancy>, ... ], "counts": { "open": 3, "resolved": 12, "auto_resolved": 5 }, "page": { ... } }`.

### `POST /app/discrepancies` - intents

Discriminated by `intent` form field, each taking `discrepancyId`:

- `resolve` - optional `note` (max 1000 chars). Valid only from `open` or `auto_resolved`.
  Sets `resolved` + `resolvedAt`. Returns `{ "ok": true }`. Already resolved: `CONFLICT`.
- `reopen` - Valid only from `resolved` or `auto_resolved`; sets `open`, clears `resolvedAt`.
  Returns `{ "ok": true }`.
- `annotate` - `note` (max 1000 chars, may be empty to clear). Any status. Returns
  `{ "ok": true }`.

### `GET /app/settings` - `app.settings.tsx`

- **Returns:** `{ "settings": { "feePercentBps": 290, "feeFixedMinor": 30, "feeToleranceBps": 50, "agingWindowDays": 7 }, "shop": { "currency": "USD", "ianaTimezone": "America/New_York" }, "runs": [ <sync run>, ... ] }`
  (runs: last 20, newest first).

### `POST /app/settings`

- **Input:** the four settings fields. Validation: `feePercentBps` 0-2000, `feeFixedMinor`
  0-10000, `feeToleranceBps` 0-500, `agingWindowDays` 1-90; integers only.
- **Success:** `{ "ok": true }`; new values apply on the next recon pass.
- **Errors:** `INVALID_INPUT` naming the field.

## Webhook route

### `POST /webhooks` - `webhooks.tsx`

HMAC via `authenticate.webhook(request)`; invalid HMAC -> `401`, logged
`webhook.invalid_hmac`. Unknown topics -> `200`, logged at warn. Handlers are fast and
side-effect-light: they write a row or delete sessions, never run a sync inline.

| Topic | Handler action |
| --- | --- |
| `APP_UNINSTALLED` | Delete the shop's `Session` rows; mark any `running` sync run `failed`. |
| `APP_SCOPES_UPDATE` | Update stored session scope. |
| Payouts topic (per pinned API version) | Record a sync trigger for the shop; the poller loop picks it up within seconds. Idempotent: duplicate deliveries collapse in the claim path. |
| `CUSTOMERS_DATA_REQUEST` | Log and acknowledge; no customer-identifying data is stored. |
| `CUSTOMERS_REDACT` | Log and acknowledge; order rows hold no customer fields. |
| `SHOP_REDACT` | Delete every row for the shop across all tables. |

If the pinned API version exposes no payouts topic, the row is simply never registered and the
poller carries freshness alone; nothing else changes.

## Admin GraphQL operations

Representative operations the sync engine runs (API version pinned in `shopify.server.ts`).
Field availability must be verified against the pinned version at implementation time; any
divergence is flagged to the owner before coding around it. All calls go through the throttled
client; every response's `errors` array is checked.

### `PayoutsPage` (payout sync, newest first)

```graphql
query PayoutsPage($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    payouts(first: $first, after: $after, reverse: true) {
      edges {
        node {
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
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

### `PayoutTransactionsPage` (per-payout balance transactions)

```graphql
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
}
```

`$query` is `"payout_id:<legacyId>"` where `legacyId` is the numeric tail of the payout GID.

### `PayoutById` (non-terminal payout refresh)

```graphql
query PayoutById($id: ID!) {
  node(id: $id) {
    ... on ShopifyPaymentsPayout { id issuedAt status net { amount currencyCode } }
  }
}
```

### `OrdersDelta` (incremental order/refund sync)

```graphql
query OrdersDelta($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    edges {
      node {
        id
        name
        processedAt
        updatedAt
        currencyCode
        displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        transactions(first: 50) {
          id kind status gateway processedAt
          amountSet { shopMoney { amount currencyCode } }
        }
        refunds(first: 50) {
          id createdAt
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

`$query` is `"updated_at:>=<watermark minus 2 minutes>"`. `OrderById` (targeted fetch for
`source_missing` charges) requests the same node fields via `node(id:)`.

### `ShopInfo` (bootstrap and per-sync check)

```graphql
query ShopInfo {
  shop { myshopifyDomain ianaTimezone currencyCode }
}
```

## CSV contract

One journal row set per payout; the set balances (total debits equal total credits), asserted
before serving. Columns:

```
payout_date,payout_reference,account,description,debit,credit,currency
```

Example for one payout (USD, deposited 1450.90):

```
payout_date,payout_reference,account,description,debit,credit,currency
2026-07-24,PO-2026-07-24-1,Shopify Clearing,Gross sales,,1608.00,USD
2026-07-24,PO-2026-07-24-1,Payment Processing Fees,Shopify Payments fees,47.10,,USD
2026-07-24,PO-2026-07-24-1,Refunds,Customer refunds,110.00,,USD
2026-07-24,PO-2026-07-24-1,Bank,Payout deposit,1450.90,,USD
```

- `payout_reference` is `PO-<payoutDate>-<n>` (n disambiguates multiple payouts on one date).
- An adjustments row appears only when nonzero, as a debit when negative and a credit when
  positive; a failed or canceled payout produces no rows.
- Amounts are exact decimal strings from minor units in the payout currency (zero-decimal
  currencies render without a decimal point). Empty cell, not `0.00`, on the unused side.
- Formula-injection guard: any cell that would start with `=`, `+`, `-`, or `@` is prefixed
  with `'`.
- Range exports concatenate row sets ordered by `payoutDate` and append a final comment line
  `# skipped N pending payouts` only when N > 0.

## Access summary

`/auth/*` and `POST /webhooks` are the only routes reachable without an admin session token.
Everything under `/app` requires it, and every row it returns or mutates belongs to the
authenticated shop.
