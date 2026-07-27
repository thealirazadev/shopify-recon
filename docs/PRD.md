# Product Requirements: shopify-recon

## What we're building

An embedded Shopify app that reconciles Shopify Payments payouts against the orders, refunds,
and adjustments that produced them. It syncs payouts, their balance transactions, orders, and
refunds from the Admin GraphQL API into local tables; matches every balance transaction to its
source and every payout to the sum of its balance transactions; computes per-payout gross sales,
fees, refunds, adjustments, and net; and asserts that the computed net equals the amount Shopify
deposited. Anything that does not add up becomes an explicit discrepancy in a work queue:
unmatched transactions, orders missing from payouts beyond an aging window, fee percentages
outside the expected band, and currency mismatches. A reconciliation dashboard shows every payout
with its match status and a line-by-line breakdown, and a CSV export produces a journal-style
summary row set per payout that an accountant can post directly.

## The problem

Shopify deposits a lump sum and merchants take it on faith. The payout report in Shopify Admin
shows totals but does not prove them: nothing ties each deposit line back to specific orders,
verifies the fee taken on each charge, or surfaces an order whose money never arrived. Merchants
and their accountants reconcile by hand in spreadsheets each month, and errors (a missed refund,
a fee overcharge, a charge that never reached a payout) go unnoticed because nothing is looking.

## Target user

A merchant on Shopify Payments, or the bookkeeper/accountant closing their books, who needs to
verify every deposit and post clean journal entries. Single store per install; the person doing
month-end close is the primary user. Not a finance suite and not a multi-store consolidation tool.

## Core user stories

1. As a merchant, I open the app and see every payout with a clear reconciled / variance /
   pending status, so I know instantly whether my deposits check out.
2. As a bookkeeper, I open one payout and see every balance transaction with the order or refund
   it came from, so I can trace any line to its source in one click.
3. As a merchant, I see a queue of discrepancies (unmatched transaction, missing order, fee
   anomaly, currency mismatch) and can resolve each one with a note, so nothing silently slips.
4. As an accountant, I export a CSV for a payout period whose rows form balanced journal entries
   per payout, so I can post to my ledger without re-keying.
5. As a merchant, new payouts appear shortly after Shopify creates them without me doing
   anything, and a manual sync button exists when I want it now.

## Functional requirements (prioritized)

1. **Incremental sync** - Payouts, balance transactions, orders, and refunds pulled via the
   Admin GraphQL API with persisted cursors, cost-aware throttling, and idempotent upserts keyed
   by Shopify GID. A re-run against unchanged upstream data changes nothing locally.
2. **Deterministic matching** - Every balance transaction gets an explicit match state
   (`matched`, `partial`, `unmatched`) computed by a staged, rule-based pipeline. No fuzzy
   scoring; every state has a stated reason.
3. **Per-payout reconciliation** - Gross, fees, refunds, adjustments, and net computed from the
   payout's balance transactions in integer minor units and compared against the deposited
   amount. Status per payout: `pending`, `reconciled`, or `variance` with the exact difference.
4. **Discrepancy queue** - Unmatched transactions, orders missing from payouts beyond a
   configurable aging window, fee anomalies outside a configurable expected band, and currency
   mismatches, each persisted once, re-detected idempotently, and resolvable with an annotation.
5. **Dashboard** - Payout list with status filters; payout detail with the line-by-line
   breakdown; discrepancy queue with resolve and annotate actions; settings for the fee band and
   aging window.
6. **CSV export** - Per payout and per date range, one balanced journal-style row set per payout
   (gross sales, fees, refunds, adjustments, net deposit), with a formula-injection guard.
7. **Freshness** - Payout webhook triggers a sync when the topic is available; a scheduled
   poller guarantees convergence regardless of webhook delivery.

## Non-goals

- Multi-store aggregation - one shop per install, no cross-shop views.
- Direct accounting-software push - QuickBooks/Xero integration is CSV export only.
- Tax filing logic, VAT/GST returns, or any tax advice.
- Gateways other than Shopify Payments - third-party gateway transactions are out of scope.
- Editing Shopify data - the app is read-only against the store; the only writes are local.
- Dispute/chargeback case management - disputes appear as adjustment lines, nothing more.
- Real-time streaming updates - the dashboard reflects the last completed sync.

## Success criteria per requirement

- **Sync** - After a full sync of a seeded dev store, local payout, transaction, order, and
  refund counts match Shopify Admin exactly; running sync again immediately produces zero row
  changes; killing the process mid-sync and re-running converges to the same state.
- **Matching** - Every balance transaction in a paid payout has a match state and a reason;
  a charge whose order exists locally is `matched`; deleting the local order row and re-matching
  yields `partial` with reason `source_missing`; no transaction is ever left without a state.
- **Reconciliation** - For a payout whose transactions are fully synced, computed net equals the
  deposited amount and the payout shows `reconciled`; artificially altering one local amount
  flips it to `variance` showing the exact minor-unit difference.
- **Discrepancies** - Each rule fires on a store seeded with its trigger case and does not fire
  otherwise; re-running detection never duplicates an open discrepancy; a resolved discrepancy
  stays resolved; one whose cause disappears auto-resolves.
- **Dashboard** - Filters combine correctly with pagination; every screen has an explicit empty
  state; a payout detail traces each line to its order or refund.
- **CSV export** - Each payout's row set balances (debits equal credits) and the export is
  refused with a logged error if it would not; amounts are exact decimal strings derived from
  minor units; cells never begin with a formula character.
- **Freshness** - With the poller interval elapsed or a webhook received, a new payout appears
  without user action; a duplicate webhook causes no duplicate rows and no duplicate sync runs.
