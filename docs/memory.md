# Project Memory: shopify-recon

Running log of what is done, in progress, and decided. Update after every meaningful chunk of
work; log every non-obvious decision with its reason. Keep entries short and dated.

## Completed

- 2026-07-27 - Planning documentation created (README, PRD, architecture, rules, phases,
  design, testing, api-contracts, launch-checklist, memory). No code yet; docs under owner
  review. Implementation follows `docs/phases.md` starting with Phase 1 once approved.
- 2026-07-28 - Phase 1 implemented in the nine commits listed in `docs/phases.md`: Remix (Vite)
  and TypeScript strict scaffold with `@shopify/shopify-app-remix` OAuth and Prisma session
  storage, Polaris shell with the three NavMenu items and a payouts empty state, `.env.example`
  plus a fail-fast env assertion, the full Prisma schema and its initial migration,
  `lib/money.ts`, `lib/dates.ts`, `lib/logger.server.ts`, `lib/errors.ts`, first-load shop
  bootstrap, the webhook route with the uninstall, scopes, and compliance topics, and unit tests
  for the two pure libraries.

## Project status

- Phase 1 complete and awaiting owner approval. Phase 2 (sync engine) not started.

### Phase 1 verification, actually observed on 2026-07-28

Ran and passed locally:

- `npm run typecheck`, `npm run lint`, and `npm run build`: clean.
- `npm test`: 31 tests across `money.test.ts` (17) and `dates.test.ts` (14), all passing. They
  cover every checklist case: "10.00" USD to 1000n, "1000" JPY to 1000n, "1.234" BHD to 1234n,
  "10.001" USD throws, "10.00" in "XYZ" throws, mixed-currency sum throws; a payout at 03:00 UTC
  in America/New_York landing on the previous calendar day; and both DST transition days.
- The initial migration applied cleanly to a fresh empty SQLite file, and the resulting schema
  has all ten tables plus all twenty-one unique keys and indexes from `docs/architecture.md`.
- Env fail-fast confirmed by importing `lib/env.server.ts` with one variable removed; it throws
  naming the missing variable.

Not verified, because no dev store and no Shopify credentials are available on this machine:

- `npm run dev` booting against a dev store, OAuth completing, and the embedded shell rendering
  inside the Admin iframe with its three nav items.
- Live webhook delivery: uninstall deleting the shop's sessions, and an invalid HMAC returning
  401 while logging `webhook.invalid_hmac`. Those code paths compile and have been read, but
  have never been exercised against Shopify.
- The `ShopInfo` bootstrap query against a real shop. Field availability on API version 2025-01
  was taken from `docs/api-contracts.md`, not confirmed against a live schema.

Everything that passed above is a pure unit test over local functions. Nothing in this phase has
been run against a live store, and no test in this phase uses a mocked Admin API either.

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
- 2026-07-28 - Admin API version pinned to 2025-01 (`ApiVersion.January25`), matching
  `shopify-bulk-editor`. Reason: it is the version already proven in the sibling app and it
  exposes `shopifyPaymentsAccount.payouts` and `balanceTransactions`. The payouts webhook topic
  is deliberately not registered in Phase 1; it is a Phase 2 item and, per the design, only a
  latency optimization over the poller.
- 2026-07-28 - The ISO 4217 exponent table in `lib/money.ts` is an explicit allowlist, stored as
  whitespace-delimited code strings rather than string arrays. Reason: an allowlist is what makes
  an unknown currency a hard error instead of a guessed exponent of 2, and Prettier expands a
  180-element array to one code per line, which would bury the module's logic. Exponent 4 (CLF,
  UYW) is included alongside 0, 2, and 3 for completeness.
- 2026-07-28 - `shopDateRange` resolves a shop-local midnight to a UTC instant with two offset
  passes rather than a date library. Reason: the offset that applies depends on the instant being
  computed, so one pass is wrong near a DST boundary. On a spring-forward day whose local midnight
  does not exist (America/Santiago, tested) the result lands on the first local moment that does,
  which is the correct start-of-day semantic.
- 2026-07-28 - `lib/shop.server.ts` calls `admin.graphql` directly instead of going through the
  throttled client that `docs/rules.md` mandates, because `sync/throttle.server.ts` does not exist
  until Phase 2. Flagged: Phase 2 must move this one call behind that client. Bootstrap failures
  are logged and swallowed so a transient Admin API error never blocks the embedded shell, and the
  next authenticated load retries. A currency with no known exponent or an unusable timezone is
  refused rather than stored, since either would silently corrupt every later amount or payout
  date.
- 2026-07-28 - Added `createdAt` and `updatedAt` to `BalanceTransaction`, `Order`,
  `OrderTransaction`, and `Refund`, which `docs/architecture.md` lists only on `Payout`. Reason:
  Phase 2's idempotency check asserts that a second sync run leaves updated timestamps untouched,
  which needs the column to exist. Caveat for Phase 2: Prisma's `@updatedAt` bumps on every
  `update` call even when no value changes, so the sync must skip no-op writes rather than rely on
  the column alone to prove idempotency.
- 2026-07-28 - `prisma/schema.prisma` carries only the `Session` model in the scaffold commit and
  gains the nine recon tables in the schema commit, which is where the single `init` migration is
  created. Reason: the Prisma session storage adapter needs `Session` for the scaffold commit to
  be in a working state, and the commit order in `docs/phases.md` is fixed.
- 2026-07-28 - The Discrepancies and Settings nav items link to routes that do not exist until
  Phase 4, so clicking them 404s today. Kept because the Phase 1 definition of done requires all
  three nav items, and stub routes would be speculative work.
- 2026-07-28 - `prisma migrate reset` from the Phase 1 checklist was not run: the Prisma CLI
  requires explicit human consent for that destructive command and none was given. Verified the
  same property non-destructively by applying the migration to a fresh throwaway SQLite file and
  inspecting the resulting tables and indexes.
