# shopify-recon

Payout reconciliation for Shopify Payments merchants, built as an embedded Shopify app. It
syncs payouts, their balance transactions, orders, and refunds from the Admin GraphQL API into
local tables. The goal is to match every balance transaction to its source, prove that each
payout's computed net equals the amount Shopify deposited, and turn everything that does not add
up into an explicit, workable discrepancy queue, with a journal-style CSV export an accountant can
post directly.

## The problem

Shopify deposits a lump sum and merchants take it on faith. Nothing in Shopify Admin ties each
deposit back to specific orders, verifies the fee taken on every charge, or notices an order
whose money never arrived in any payout. Merchants and bookkeepers reconcile by hand in
spreadsheets at month end, and errors - a fee overcharge, a missed refund, a charge that never
reached a payout - go unseen because nothing is looking.

## Features

Sync and freshness (the first and last items) are implemented. Matching, the payout rollup, and
the discrepancy rules exist as pure modules that are not yet wired into a reconciliation pass;
the dashboard, discrepancy queue, and CSV export are not built yet. See Status below.

- Incremental sync of payouts, balance transactions, orders, and refunds with persisted
  cursors, cost-aware GraphQL throttling, and idempotent upserts keyed by Shopify GIDs (a
  re-run changes nothing).
- Deterministic matching of every balance transaction to its order, refund, or adjustment,
  with explicit match states (matched, partial, unmatched) and stated reasons - no fuzzy
  scoring.
- Per-payout reconciliation in integer minor units: gross, fees, refunds, adjustments, and net
  computed and asserted against the deposited amount, with the exact variance when they
  disagree.
- Discrepancy queue: unmatched transactions, orders missing from payouts beyond an aging
  window, fee percentages outside a configurable expected band, and currency mismatches -
  detected idempotently, resolvable with notes.
- Reconciliation dashboard: payout list with match status, payout detail with a line-by-line
  breakdown, discrepancy queue, and settings for the fee band and aging window.
- Accountant-ready CSV export per payout or date range: one balanced journal row set per
  payout, shop-timezone period boundaries, formula-injection guarded.
- Freshness from a poller that alone guarantees convergence. The webhook route also treats any
  delivered payout topic as a sync trigger, but no payout topic is subscribed today.

Out of scope: multi-store aggregation, direct QuickBooks/Xero push (CSV only), tax logic, and
gateways other than Shopify Payments.

## Stack

- Remix (Vite) + TypeScript (strict), embedded via App Bridge, UI in Polaris
- @shopify/shopify-app-remix for OAuth, session storage, and webhook verification
- Prisma with SQLite (the datasource provider is fixed in `prisma/schema.prisma`; moving to
  PostgreSQL means changing that provider and regenerating the migrations, not only
  `DATABASE_URL`)
- Shopify Admin GraphQL API (read-only scopes)
- Vitest

## Documentation

| File | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Sync engine, matching pipeline, data model, failure modes, invariants |
| [docs/design.md](docs/design.md) | Screens, states, and Polaris usage |
| [docs/testing.md](docs/testing.md) | Test strategy, coverage map, commands, CI |
| [docs/api-contracts.md](docs/api-contracts.md) | Routes, shapes, GraphQL operations, CSV format, error envelope |
| [docs/decisions.md](docs/decisions.md) | Design decisions and the edge cases behind them |

## Status

The sync engine is implemented and tested: OAuth and session storage, incremental payout,
balance transaction, order, and refund sync with cost-aware throttling and idempotent writes,
single-flight runs per shop with crash recovery, a poller, and a manual "Sync now" action. The
pure matching (`app/lib/match.ts`), payout rollup (`app/lib/rollup.ts`), and discrepancy rules
(`app/lib/anomalies.ts`) are written and unit tested but not yet run by a reconciliation pass.
The reconciliation pass, the payout detail and discrepancy screens, settings, and the CSV export
are not built yet, and the code holds no stand-ins for them. Webhooks are subscribed in
`shopify.app.toml` and verified by `authenticate.webhook`. Everything has been tested against
stubbed Admin API responses only, not a live store.
