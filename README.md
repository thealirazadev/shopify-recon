# shopify-recon

Payout reconciliation for Shopify Payments merchants, planned as an embedded Shopify app. It
will sync payouts, their balance transactions, orders, and refunds from the Admin GraphQL API
into local tables, match every balance transaction to its source, prove that each payout's
computed net equals the amount Shopify deposited, and turn everything that does not add up into
an explicit, workable discrepancy queue - with a journal-style CSV export an accountant can
post directly.

## The problem

Shopify deposits a lump sum and merchants take it on faith. Nothing in Shopify Admin ties each
deposit back to specific orders, verifies the fee taken on every charge, or notices an order
whose money never arrived in any payout. Merchants and bookkeepers reconcile by hand in
spreadsheets at month end, and errors - a fee overcharge, a missed refund, a charge that never
reached a payout - go unseen because nothing is looking.

## Planned features

All of the following is planned behavior; implementation has not started.

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
- Freshness via the payouts webhook where available, with a polling fallback that alone
  guarantees convergence.

Out of scope: multi-store aggregation, direct QuickBooks/Xero push (CSV only), tax logic, and
gateways other than Shopify Payments.

## Stack

- Remix (Vite) + TypeScript (strict), embedded via App Bridge, UI in Polaris
- @shopify/shopify-app-remix for OAuth, session storage, and webhook verification
- Prisma with SQLite by default (PostgreSQL supported)
- Shopify Admin GraphQL API (read-only scopes)
- Vitest

## Documentation

| File | Contents |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Problem, users, stories, requirements, success criteria |
| [docs/architecture.md](docs/architecture.md) | Sync engine, matching pipeline, data model, failure modes, invariants |
| [docs/rules.md](docs/rules.md) | Project-specific engineering rules |
| [docs/phases.md](docs/phases.md) | Implementation phases with commit plans and verification checklists |
| [docs/design.md](docs/design.md) | Screens, states, and Polaris usage |
| [docs/testing.md](docs/testing.md) | Test strategy, coverage map, commands, CI plan |
| [docs/api-contracts.md](docs/api-contracts.md) | Routes, shapes, GraphQL operations, CSV format, error envelope |
| [docs/launch-checklist.md](docs/launch-checklist.md) | Pre-production verification |
| [docs/memory.md](docs/memory.md) | Working log and decisions |

## Status

Planning stage. This repository currently contains documentation only; implementation follows
the phases in [docs/phases.md](docs/phases.md), one approved phase at a time.
