# Architecture: shopify-recon

Follows the conventions of `shopify-bulk-editor` (same OAuth, Prisma session storage, webhook
verification, Polaris, and in-process worker patterns). This document covers what is different:
the sync engine, the matching pipeline, money and timezone handling, and the invariants. A
coding agent must be able to implement the project from this file alone.

## App flow

1. **Install / OAuth** - `@shopify/shopify-app-remix` handles OAuth and persists the session
   via the Prisma session storage adapter. Scopes: `read_orders,read_shopify_payments_payouts`.
   First authenticated load fetches the shop's payout currency and IANA timezone into `Shop`.
2. **Embedded app** - Runs inside Shopify Admin behind App Bridge; every `app.*` route
   authenticates with `authenticate.admin(request)`. All UI is Polaris.
3. **Sync** - A run (webhook, poller, or manual) pulls payouts, per-payout balance
   transactions, and changed orders with transactions and refunds: idempotent upserts keyed by
   `(shop, shopifyGid)`, persisted cursors, cost-aware throttling.
4. **Recon** - After every sync: matching recomputes match states, the rollup recomputes payout
   totals and status, detection upserts the discrepancy queue; all deterministic, re-runnable.
5. **Browse and export** - Payout list, payout detail with the line-by-line breakdown,
   discrepancy queue, settings; resource routes serve journal CSV per payout or date range.
6. **Webhooks** - Single HMAC-verified endpoint: `app/uninstalled`, `app/scopes_update`, the
   three compliance topics, and the payouts topic where the pinned API version offers it.

## Decision: per-payout balance transaction fetch, not a global stream

Balance transactions are fetched per payout (the `shopifyPaymentsAccount.balanceTransactions`
connection filtered by `payout_id:<legacy id>`), not by paging one global transaction stream.

- The core assertion is per-payout completeness: computed net equals deposited net. A
  per-payout fetch makes "this payout's transaction set is fully synced" a local, checkable
  fact (`transactionsSyncedAt`) instead of a property inferred from a global cursor position.
- A global stream can observe a transaction before its payout exists (the association is
  assigned when Shopify creates the payout), forcing a re-association sweep; the per-payout
  fetch reads transactions only when their payout already exists.
- Volume per payout is small (tens to low thousands of lines), so cost is bounded, and only
  payouts not yet reconciled are fetched, so the fetch is naturally incremental.

Trade-off: transactions not yet in any payout (pending balance) are not mirrored. Acceptable:
they cannot be reconciled until they land in a payout, and aging detection is order-side.

## Decision: matching is a deterministic staged pipeline

No fuzzy scoring, no amount-window heuristics: each stage resolves a link by identifier or
records an explicit reason why it could not.

**Stage 1 - payout attachment.** Each fetched transaction carries its payout; rows store
`payoutId`.

**Stage 2 - source resolution**, by the transaction's `type`:

| Type | Resolution | Matched when |
| --- | --- | --- |
| `charge` | `sourceOrderTransactionId` -> local `OrderTransaction.shopifyGid` | Counterpart exists, currency equal, `amountMinor` equal |
| `refund` | `sourceOrderTransactionId` -> local `OrderTransaction` of kind `refund`; its order links the `Refund` row | Same, comparing absolute amounts |
| `adjustment`, `dispute`, `reserve`, `transfer`, any other | Self-describing; categorized as an adjustment line | Always `matched`, `matchTargetType: "adjustment"` |

**States.** `matched` (link resolved, amounts agree), `partial` (counterpart row missing
locally or amounts/currency disagree; `matchReason` is `source_missing`, `amount_mismatch`, or
`currency_mismatch`), `unmatched` (no source identifier at all; `matchReason: "no_source"`).
A charge in `partial` with `source_missing` triggers a targeted order fetch on the next sync
(bounded at 25 per run); if the order still cannot be fetched it stays `partial`.

**Recompute safety.** Match fields are derived state, recomputed from scratch on every run.
Operator input (annotations, resolutions) lives only on `Discrepancy` rows, so recomputation
never destroys it.

## Rollup and reconciliation status

Per payout, from its local balance transactions, in integer minor units: `computedGrossMinor`
= sum of `amountMinor` over `charge` lines; `computedFeesMinor` = sum of `feeMinor` over all
lines; `computedRefundsMinor` = sum of `amountMinor` over `refund` lines (negative);
`computedAdjustmentsMinor` = sum of `netMinor` over adjustment-category lines;
`computedNetMinor` = sum of `netMinor` over all lines; `varianceMinor` = `computedNetMinor -
netMinor` (reported deposit).

| `reconStatus` | Condition |
| --- | --- |
| `pending` | Payout not yet `paid`, or `transactionsSyncedAt` is null |
| `reconciled` | `paid`, transactions fully synced, `varianceMinor == 0`, every line `matched` |
| `variance` | `paid`, transactions fully synced, and `varianceMinor != 0` or any line not `matched` |

The rollup skips payouts whose `transactionsSyncedAt` is null, so it never sees a partial set.

## Discrepancy detection

Rules run after matching, upserting rows keyed by `(shop, type, subjectType, subjectId)`:

| Type | Subject | Fires when |
| --- | --- | --- |
| `payout_variance` | payout | `reconStatus` is `variance` with `varianceMinor != 0` |
| `unmatched_transaction` | balance_transaction | Line in a paid payout is `partial` or `unmatched` |
| `missing_from_payout` | order_transaction | Successful `sale`/`capture` via gateway `shopify_payments`, `processedAt` older than `agingWindowDays`, and no balance transaction references it |
| `fee_anomaly` | balance_transaction | Matched `charge` whose `feeMinor` falls outside `amount * feePercentBps / 10000 + feeFixedMinor`, plus or minus `feeToleranceBps` of the amount |
| `currency_mismatch` | balance_transaction | Line currency differs from its payout's currency |

**Idempotency.** Detection upserts on the unique key: existing rows get `lastSeenAt` and
`detailJson` refreshed, never duplicated; an `open` discrepancy whose condition stops
reproducing closes as `auto_resolved`; a manually `resolved` one is never reopened.

## Sync engine

**Single flight per shop.** A run is claimed by writing a `SyncRun` row inside a transaction
that first checks no other run for the shop is `running` with a heartbeat younger than 5
minutes; a stale run (crashed process) is marked `superseded` by the claimant. The claim
transaction is the only lock; exactly one app instance runs in production (launch checklist).

**Cursors.** `SyncCursor` rows per `(shop, resource)`:

- `payouts` - a `watermark` (newest fully processed `issuedAt`). Runs page newest-first,
  stopping once past `watermark` minus a 3-day overlap; locally non-terminal payouts are also
  refreshed by node lookup so status flips to `paid`/`failed` are caught however old the payout.
- `orders` - an `updated_at` watermark. Each run queries
  `orders(query: "updated_at:>=<watermark minus 2 minutes>", sortKey: UPDATED_AT)` and pages
  forward; transactions and refunds come inline. Upserts make the overlap harmless.

**Page commit rule.** Each page's upserts and its cursor advance commit in one database
transaction; the running sync updates `heartbeatAt` between pages. A crash loses at most the
in-flight page; the next run re-reads it and the upserts converge (at-least-once page
processing, exactly-once effect).

**Per-payout transactions.** For each payout that is new, non-terminal, or has
`transactionsSyncedAt` null, the run pages its balance transactions (250 per page, one commit
per page) and stamps `transactionsSyncedAt` only after the final page; a crash mid-payout
leaves the stamp null, so the next run refetches that payout from page one.

**Cost-aware throttling.** Every Admin GraphQL response includes `extensions.cost`. The client
tracks `throttleStatus.currentlyAvailable` and `restoreRate` per shop, estimates the next
call's cost from the last actual cost of the same operation (default 50 points until observed),
and sleeps `(needed - available) / restoreRate` seconds when short. A `THROTTLED` error retries
once after the computed wait, then fails the run. Same pattern as `shopify-bulk-editor`.

**Freshness.** Primary: the Shopify Payments payouts webhook topic, registered when the pinned
API version exposes it; the handler validates HMAC, records a pending trigger, and returns 200
immediately. Fallback: an in-process poller singleton (module-level, guarded against Vite HMR
re-instantiation like the Prisma client) starting a run per shop every `RECON_POLL_MINUTES`
(default 360). The poller alone is sufficient for correctness; the webhook only reduces
latency; manual "Sync now" uses the same claim path.

## Money precision

- All amounts are integer minor units (8-byte `BigInt` columns); no floats in the money path.
- Shopify returns decimal strings (`MoneyV2.amount`). `lib/money.ts` parses them with integer
  string math against an ISO 4217 exponent table (2 for most currencies, 0 for JPY/KRW, 3 for
  BHD/KWD/OMR/JOD/TND). A fraction longer than the currency's exponent, or an unknown currency
  code, is a hard error: the sync run fails loudly rather than storing silently wrong money.
- Formatting back to decimal strings is the exact inverse, done only at the UI/CSV edge, and
  aggregation helpers take `(currency, values)` and throw on mixed currencies.

## Timezone handling

Payout period boundaries are calendar dates in the shop's timezone, not UTC. `issuedAt` is a
stored UTC instant; `payoutDate` (`YYYY-MM-DD`) is derived at sync time from `issuedAt` in the
shop's IANA timezone (via `Intl.DateTimeFormat`, no timezone library) and is what the list,
filters, and CSV period boundaries use; date-range export inputs are shop-local dates against
it. A shop timezone change is detected at sync start and logged; existing `payoutDate` values
are recomputed only by a full re-sync.

## Failure modes

| Failure | Handling |
| --- | --- |
| Shopify 5xx / network error mid-page | Retry the page once; then fail the run with the error on `SyncRun`. Cursors hold at the last committed page; the next trigger resumes. |
| Process crash mid-run | Heartbeat goes stale; the next claimant marks the run `superseded` and starts fresh; upserts absorb re-read pages; a payout with `transactionsSyncedAt` null refetches from page one. |
| Webhook missed, delayed, or duplicated | Poller converges within `RECON_POLL_MINUTES`; the claim path collapses concurrent triggers; upserts are no-ops. |
| Unknown currency code | Run fails with a named error; no guessed exponent, no wrong money. |
| Unknown balance transaction type | Stored verbatim, categorized as adjustment, logged `sync.unknown_type`; never a crash. |
| Charge references an unreadable order | Targeted fetch fails; line stays `partial` (`source_missing`); surfaces via `unmatched_transaction`. |
| CSV journal set does not balance | Export refuses with `INTERNAL`, logs payout id and difference; never serves a wrong file. |
| Webhook HMAC invalid | 401, logged `webhook.invalid_hmac`; nothing processed. |
| App uninstalled | Sessions deleted; local data kept until `shop/redact` wipes it. |

## Correctness invariants

1. Money is integer minor units end to end; parsing and formatting live only in `lib/money.ts`;
   no sum ever crosses currencies (aggregation helpers throw on mixed input).
2. Every mirrored row is keyed unique on `(shop, shopifyGid)`; re-syncing unchanged upstream
   data is a byte-level no-op.
3. Page upserts and cursor advances commit atomically; at-least-once page processing yields
   exactly-once effects.
4. At most one sync run per shop is `running` (claim + heartbeat + supersede), and rollup only
   runs over complete transaction sets (`transactionsSyncedAt` set).
5. Match fields are derived and recomputable; operator input lives only on `Discrepancy`.
6. Discrepancy identity is `(shop, type, subjectType, subjectId)`; detection is idempotent,
   auto-resolves stale open rows, and never reopens a manual resolution.
7. Each payout's CSV journal row set balances to zero, asserted before serving.
8. The poller alone guarantees convergence; webhooks are an optimization.
9. Every query and mutation on app data filters by the authenticated session's shop, and the
   app never writes to Shopify (all Admin API access is read-only).

## Folder and file tree

```
shopify-recon/
  app/
    entry.server.tsx              Remix server entry (embedding headers, poller bootstrap)
    root.tsx                      App Bridge + Polaris AppProvider, ErrorBoundary
    routes/
      _index/, auth.$.tsx, auth.login/   Landing + OAuth routes, as in shopify-bulk-editor
      webhooks.tsx                HMAC verify + topic dispatch
      app.tsx                     Embedded layout: authenticate.admin, NavMenu
      app._index.tsx              Payout list: status filters, sync banner, sync-now action
      app.payouts.$id.tsx         Payout detail: rollup card, line-by-line table
      app.payouts.$id.export.tsx  Resource route: single-payout journal CSV
      app.export.tsx              Resource route: date-range journal CSV
      app.discrepancies.tsx       Discrepancy queue: filters, resolve/reopen/annotate
      app.settings.tsx            Fee band, aging window, sync run history
    shopify.server.ts / db.server.ts   shopifyApp() config; Prisma client singleton
    lib/
      money.ts                    Minor-unit parse/format per currency, safe sums (pure)
      dates.ts                    Shop-timezone payout dates, range boundaries (pure)
      match.ts                    Matching pipeline stages and states (pure)
      rollup.ts                   Payout totals, variance, recon status (pure)
      anomalies.ts                Discrepancy rules (pure)
      csv.server.ts               Journal CSV rows, balance assertion, injection guard
      logger.server.ts / errors.ts   Structured JSON-lines logger; shared error shape
    sync/
      run.server.ts               Claim, heartbeat, supersede, orchestration
      payouts.server.ts           Payout pages, non-terminal refresh, per-payout transactions
      orders.server.ts            Incremental order/refund sync, targeted order fetch
      recon.server.ts             Post-sync match + rollup + detection pass
      throttle.server.ts          Cost-aware pacing from extensions.cost (pure core)
      poller.server.ts            Interval singleton, HMR-guarded
  prisma/                         schema.prisma, migrations/, dev.sqlite (gitignored)
  docs/  public/  .env.example
  package.json / package-lock.json / tsconfig.json / vite.config.ts / vitest.config.ts
  shopify.app.toml / eslint.config.js / .prettierrc
```

## Tech stack with rationale

Same core stack as `shopify-bulk-editor`; exact versions pinned at install time, lockfile
committed. Node 20 LTS; Shopify CLI for dev tunneling.

- **Remix 2 (Vite) + TypeScript 5 (strict)** - Loader/action model fits per-request Shopify
  auth; the official Shopify package targets it.
- **@shopify/shopify-app-remix** - OAuth, session token validation, webhook verification and
  registration. **@shopify/polaris + @shopify/app-bridge-react** - native Admin look, embedded
  framing. No hand-rolled auth, no other UI framework.
- **Prisma + SQLite (dev, default) / PostgreSQL (supported)** - First-class session adapter;
  the mirror tables need nothing beyond a relational store; same schema on both engines via
  `DATABASE_URL`.
- **Vitest** - Unit tests for the pure logic carrying the correctness guarantees; integration
  tests for the sync engine against a stubbed GraphQL client.
- **No queue library, no Redis** - Sync volume is one run per shop every few hours; the
  `SyncRun` table plus an in-process poller is the whole engine.

## Data model

Tables and columns named here are the contract; the coding agent must not rename them. SQLite
does not support Prisma enums, so status/type fields are strings enforced in code. All `*Minor`
columns are `BigInt` (8-byte) integer minor units. Primary keys are `cuid()` strings, omitted
below. `Session` is the Prisma session storage adapter model, verbatim as in
`shopify-bulk-editor`.

### Shop
`shop` (string, unique), `currency` (payout currency, ISO 4217), `ianaTimezone` (e.g.
America/New_York), `feePercentBps` (int, 290), `feeFixedMinor` (int, 30), `feeToleranceBps`
(int, 50), `agingWindowDays` (int, 7), `createdAt`, `updatedAt`. Ints are defaults.

### SyncCursor
`shop` + `resource` (unique together; `payouts` or `orders`), `watermark` (datetime, nullable:
newest processed `issuedAt` for payouts, `updated_at` horizon for orders), `updatedAt`.

### SyncRun
`shop`, `trigger` (`webhook` | `poll` | `manual`), `status` (`running` | `completed` | `failed`
| `superseded`), `error` (nullable), `payoutsSeen` / `transactionsSeen` / `ordersSeen` (int,
default 0), `startedAt`, `heartbeatAt` (updated between pages), `finishedAt` (nullable).
Indexes: `(shop, status)`, `(shop, startedAt)`.

### Payout
| Column | Type | Notes |
|---|---|---|
| shop | string | unique with shopifyGid |
| shopifyGid | string | gid://shopify/ShopifyPaymentsPayout/123 |
| legacyId | string | numeric tail of the gid; used in `payout_id:` query filters |
| status | string | `scheduled` \| `in_transit` \| `paid` \| `failed` \| `canceled` |
| currency / netMinor | string / bigint | reported deposit amount in payout currency |
| issuedAt / payoutDate | datetime / string | UTC instant; YYYY-MM-DD in the shop timezone |
| summaryJson | string | Shopify's own summary breakdown, minor units |
| computedGrossMinor / computedFeesMinor / computedRefundsMinor / computedAdjustmentsMinor / computedNetMinor | bigint, nullable | rollup outputs |
| varianceMinor | bigint, nullable | computedNetMinor - netMinor |
| reconStatus | string, default `pending` | `pending` \| `reconciled` \| `variance` |
| transactionsSyncedAt | datetime, nullable | null until the full transaction set is fetched |
| reconciledAt / createdAt / updatedAt | datetime | reconciledAt nullable |

Indexes: unique `(shop, shopifyGid)`; `(shop, payoutDate)`, `(shop, reconStatus)`, `(shop, status)`.

### BalanceTransaction
| Column | Type | Notes |
|---|---|---|
| shop | string | unique with shopifyGid |
| shopifyGid | string | |
| payoutId | string FK -> Payout.id | `(shop, payoutId)` indexed |
| type | string | `charge` \| `refund` \| `adjustment` \| `dispute` \| others verbatim |
| currency / transactionDate | string / datetime | |
| amountMinor / feeMinor / netMinor | bigint | |
| sourceType / sourceId | string, nullable | source object gid when Shopify provides one |
| sourceOrderTransactionId | string, nullable | join key to OrderTransaction.shopifyGid |
| associatedOrderGid | string, nullable | |
| matchState | string, default `unmatched` | `matched` \| `partial` \| `unmatched`; `(shop, matchState)` indexed |
| matchTargetType / matchTargetId | string, nullable | `order_transaction` \| `refund` \| `adjustment`; local counterpart row id |
| matchReason | string, nullable | `source_missing` \| `amount_mismatch` \| `currency_mismatch` \| `no_source` |

### Order
`shop` + `shopifyGid` (unique together), `name` (e.g. #1001), `currency`, `totalMinor`
(bigint), `financialStatus` (nullable), `processedAt`, `shopifyUpdatedAt`. Index
`(shop, processedAt)`.

### OrderTransaction
`shop` + `shopifyGid` (unique together), `orderId` (FK -> Order.id, indexed), `kind` (`sale` |
`capture` | `refund` | `void` | `authorization`), `status` (`success` | `failure` | `pending`
| `error`), `gateway`, `amountMinor` (bigint), `currency`, `processedAt`. Index
`(shop, gateway, processedAt)` for aging detection.

### Refund
`shop` + `shopifyGid` (unique together), `orderId` (FK -> Order.id, indexed), `amountMinor`
(bigint), `currency`, `processedAt`.

### Discrepancy
| Column | Type | Notes |
|---|---|---|
| shop | string | unique with (type, subjectType, subjectId) |
| type | string | `payout_variance` \| `unmatched_transaction` \| `missing_from_payout` \| `fee_anomaly` \| `currency_mismatch` |
| subjectType / subjectId | string | `payout` \| `balance_transaction` \| `order_transaction`; local row id |
| status | string, default `open` | `open` \| `resolved` \| `auto_resolved`; `(shop, status)` and `(shop, type)` indexed |
| detailJson | string | expected/actual minor units + human summary |
| note | string, nullable | operator annotation |
| firstSeenAt / lastSeenAt / resolvedAt | datetime | resolvedAt nullable |

Relationships: `Payout 1-N BalanceTransaction`; `Order 1-N OrderTransaction` and `1-N Refund`.
Everything is keyed by `shop`; no cross-shop reads exist.

## Where state lives

- **Session/auth** - `Session` table via the Prisma adapter; no in-memory session cache.
- **Financial data of record** - Shopify, always; local tables are a read-only mirror.
- **Derived state** - Match fields, rollup columns, `reconStatus`: recomputed from the mirror.
- **Operator state** - `Discrepancy` status/notes, `Shop` settings: the only human-edited rows.
- **Sync state** - `SyncCursor` watermarks and `SyncRun` rows; a restart loses nothing.
- **UI state** - Remix loaders per request; the sync banner polls its loader; no client store.

## External dependencies

Shopify Admin GraphQL API (version pinned in `shopify.server.ts`, upgraded deliberately);
OAuth and webhooks via `@shopify/shopify-app-remix`; Shopify CLI tunneling in dev only;
SQLite or PostgreSQL via `DATABASE_URL`.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` | App Client ID. Public; used by App Bridge and OAuth. |
| `SHOPIFY_API_SECRET` | App Client Secret. Verifies webhook HMAC, exchanges OAuth codes. |
| `SCOPES` | `read_orders,read_shopify_payments_payouts` |
| `SHOPIFY_APP_URL` | Public HTTPS base URL (tunnel in dev). |
| `DATABASE_URL` | Prisma connection string. SQLite file in dev; PostgreSQL in prod. |
| `RECON_POLL_MINUTES` | Poller interval per shop (default 360). |

All documented with dummies in `.env.example`; startup fails fast if any is missing.
