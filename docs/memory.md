# Project Memory: shopify-recon

Running log of what is done, in progress, and decided. Update after every meaningful chunk of
work; log every non-obvious decision with its reason. Keep entries short and dated.

## Completed

- 2026-07-27 - Planning documentation created (README, PRD, architecture, rules, phases,
  design, testing, api-contracts, launch-checklist, memory). No code yet; docs under owner
  review. Implementation follows `docs/phases.md` starting with Phase 1 once approved.

## Project status

- Planning stage. Nothing implemented; the repository contains documentation only.

## Decisions log

- 2026-07-27 - Balance transactions are fetched per payout (`payout_id:` query filter), not
  via one global transaction-stream cursor. Reason: the product's core assertion is per-payout
  completeness, and a per-payout fetch makes "fully synced" a checkable local fact
  (`transactionsSyncedAt`); a global stream can see transactions before their payout exists
  and would need a re-association sweep. Trade-off accepted: pending-balance transactions are
  not mirrored, which is fine because they cannot be reconciled yet and aging detection works
  from the order side.
- 2026-07-27 - Money is integer minor units (`BigInt`) end to end, parsed from Shopify's
  decimal strings with integer string math against an ISO 4217 exponent table. Unknown
  currencies and over-long fractions fail the sync run instead of guessing. Reason: a
  reconciliation tool that is off by one minor unit is worse than one that stops; floats and
  silent defaults are the two classic ways to be wrong quietly.
- 2026-07-27 - Match fields on `BalanceTransaction` are derived state, recomputed from scratch
  every recon pass; operator input (notes, resolutions) lives only on `Discrepancy`. Reason:
  this makes the matcher freely re-runnable and idempotent by construction, and no recompute
  can ever destroy human work. Corollary: the detector auto-resolves open discrepancies that
  stop reproducing but never reopens a manually resolved one.
- 2026-07-27 - The payouts webhook is treated strictly as a latency optimization: the handler
  only records a trigger, and the poller alone guarantees convergence. Reason: payout webhook
  topic availability varies by API version, and webhooks are best-effort delivery anyway; the
  design must not depend on them, so if the pinned version lacks the topic nothing breaks.
  Flagged in api-contracts.md for verification at implementation time.
- 2026-07-27 - `payoutDate` is a stored string derived once at sync time in the shop's IANA
  timezone, rather than converting `issuedAt` at query time. Reason: list filters, grouping,
  and CSV period boundaries all need one stable shop-local calendar date, and deriving at
  query time would make an index on it impossible; the cost is that a shop timezone change
  requires a full re-sync to recompute, which is logged and rare.
