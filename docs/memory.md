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
- 2026-07-29 - Phase 2 implemented in the nine commits listed in `docs/phases.md`, plus one
  corrective commit (`fix: skip unchanged cursor writes`): `sync/throttle.server.ts` (cost-aware
  client, the single Admin API path), `sync/run.server.ts` (claim, heartbeat, supersede,
  counters, terminal status, orchestration), `sync/payouts.server.ts` (newest-first paging with
  a 3-day overlap, non-terminal refresh by node lookup, per-payout balance transactions),
  `sync/orders.server.ts` (incremental order, transaction and refund sync plus the targeted
  order fetch), `sync/poller.server.ts` (interval singleton and pending-trigger drain), the
  payouts webhook trigger, the "Sync now" action with its `CONFLICT` guard, `lib/diff.ts`, and
  the throttle, diff, and sync-engine test suites.

## Project status

- Phase 1 and Phase 2 complete and awaiting owner approval. Phase 3 (recon: matching, rollup,
  discrepancies) not started; `executeRun` deliberately ends after the sync and does not call a
  recon pass yet.

### Phase 2 verification, actually observed on 2026-07-29

Ran and passed locally:

- `npm run typecheck`, `npm run lint`, and `npm run build`: clean after every commit.
- `npm test`: 53 tests across five files, all passing. New in this phase: `sync/throttle.test.ts`
  (9), `lib/diff.test.ts` (4), `sync/sync.test.ts` (9).
- Idempotency: `sync.test.ts` runs the engine twice over identical fixtures and compares a
  serialization of every mirrored row (Shop, Payout, BalanceTransaction, Order, OrderTransaction,
  Refund, SyncCursor) including `updatedAt`. The two snapshots are byte-identical.
- Crash recovery: aborting the stubbed run on page two of a payout's transactions leaves
  `transactionsSyncedAt` null and one committed row; the next run re-reads that payout from page
  one (asserted on the stub's recorded `after: null`), converges to two rows, and creates no
  duplicates.
- Claims: two concurrent `claimRun` calls produce exactly one `running` run and one refusal; a
  run whose `heartbeatAt` is older than five minutes is marked `superseded` by the next claimant;
  a live run refuses the second claim.
- Throttling: a simulated `currentlyAvailable` of 5 against an observed cost of 10 at a restore
  rate of 50 produces exactly the computed 100 ms sleep; a `THROTTLED` response is retried once
  and a second one fails the run with both cursor watermarks unchanged.
- Every log key the Phase 2 definition of done lists is emitted by committed code: `sync.started`,
  `sync.page_committed`, `sync.completed`, `sync.failed`, `sync.throttled`, `sync.unknown_type`,
  `webhook.received`.
- One Admin API path confirmed by grep: `admin.graphql` appears only inside
  `sync/throttle.server.ts`.

Not verified, because no dev store and no Shopify credentials are available on this machine:

- Everything in the checklist's "Against a dev store" line: initial sync mirroring real payout and
  order counts, and a new test order appearing after the next run.
- Whether the pinned API version (2025-01) actually exposes the fields and arguments the queries
  use. `shopifyPaymentsAccount.balanceTransactions(query: "payout_id:<legacyId>")`, the six
  `payout.summary` money fields, and `Order.refunds(first:)` were taken from
  `docs/api-contracts.md`, not from a live schema. If any diverges, the run fails loudly with
  `UPSTREAM_ERROR` and the cursors hold, but the divergence itself is unproven.
- Whether Shopify returns `sourceOrderTransactionId` as a legacy numeric id (the sync promotes a
  numeric value to `gid://shopify/OrderTransaction/<id>` and passes anything else through
  unchanged).
- Payouts webhook delivery, the poller running on a real interval, and the "Sync now" button
  inside the Admin iframe. The poller interval and the manual action are exercised only through
  their shared `claimRun` path in tests.

Every fixture in the sync tests is mocked, hand-written from `docs/api-contracts.md`. Nothing in
this phase has been run against a live store.

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
- 2026-07-29 - Phase 1's flagged deviation is resolved: `lib/shop.server.ts` now takes a
  `ThrottledClient` instead of the raw admin context, so every Admin API call in the app goes
  through `sync/throttle.server.ts`. The same module gained `loadShopSettings`, which re-reads the
  shop's currency and timezone at the start of every run and logs `shop.settings_changed` when
  either moved, per the architecture's timezone section. Bootstrap still swallows failures (a page
  load must never be blocked by a transient Admin error) while `loadShopSettings` throws, because
  a run that cannot read the payout currency must fail rather than guess.
- 2026-07-29 - Added `app/lib/diff.ts` (`isUnchanged`), which is not in the architecture's file
  tree. Flagged for owner review. Reason: Phase 1 recorded that Prisma's `@updatedAt` bumps on
  every `update` call, so idempotency requires comparing the mapped row against the stored one and
  skipping no-op writes; five models across two sync modules need that comparison, and copies of
  it in each would be worse than one pure twenty-line function. It is pure and unit-tested.
- 2026-07-29 - The payouts watermark advances only inside the transaction that commits the last
  page of the payout pass, not on every page. Reason: payouts page newest-first, so advancing on
  page one would let a crash on page two skip everything behind it forever. Order pages, which run
  oldest-first, do advance per page as the architecture describes. Every page's rows still commit
  atomically with whatever cursor movement accompanies them, which is the invariant that matters.
- 2026-07-29 - Cursor rows are only written when the watermark actually moves (its own corrective
  commit, a tenth beyond the nine `docs/phases.md` lists). Reason: `SyncCursor.updatedAt` is
  `@updatedAt`, so an unconditional upsert made a second identical run a row change and the
  idempotency assertion could not be total.
- 2026-07-29 - `transactionsSyncedAt` is stamped only while it is null, never refreshed. Reason:
  non-terminal payouts are refetched on every run by design, and re-stamping them would make every
  run a row change. The column's meaning is null versus not-null ("is this transaction set
  complete"), so keeping the first completion time is both correct and idempotent.
- 2026-07-29 - The payouts webhook topic is not registered in `shopify.server.ts`. Instead
  `actionForTopic` maps any delivered topic whose name contains "payout" to a sync trigger.
  Reason: the topic's name and availability on API version 2025-01 cannot be verified from this
  machine, and registering a wrong topic string risks failing the registration of the five topics
  that do work. The architecture already treats the webhook as a latency optimization only, so the
  poller carries freshness alone until the topic is confirmed against a real store.
- 2026-07-29 - The webhook handler records the trigger in an in-memory set that the poller drains
  every 15 seconds, rather than in a table. Reason: the schema has no pending-trigger column,
  exactly one app instance runs in production (launch checklist), and a lost trigger costs only
  latency because the interval converges anyway. Adding a table would need a migration for state
  that is worthless after a restart.
- 2026-07-29 - `sourceOrderTransactionId` is promoted from Shopify's legacy numeric id to
  `gid://shopify/OrderTransaction/<id>` at the edge; a non-numeric value passes through unchanged.
  Reason: `docs/architecture.md` documents that column as the join key to
  `OrderTransaction.shopifyGid`, and normalizing at write time is what makes the Phase 3 match a
  plain equality join. Unverified against a live API.
- 2026-07-29 - `executeRun` never throws; the `SyncRun` row is the outcome of a run. Reason: it is
  started fire-and-forget from the poller and the manual action, where an exception has nowhere to
  go, and every trigger path already reads the run row.
- 2026-07-29 - Bounds that the docs left open: non-terminal payout refresh at 200 node lookups per
  run, targeted order fetch at 25 per run over the 500 most recent referenced payout lines, order
  pages at 25 (each carries up to 50 transactions and 50 refunds inline, so a larger page would be
  an expensive single query). Reason: every one of these is an unbounded external cost otherwise;
  all of them converge over successive runs.
- 2026-07-29 - An order with no `processedAt`, and an order transaction or refund with no date of
  its own, fall back to the order's last update. Reason: the columns are non-null and aging
  detection needs a date; the last update is the closest honest stand-in and never invents one.
  A balance transaction with no `fee` stores `0`, which is what an absent fee means.
- 2026-07-29 - The sync tests run the real engine against a real SQLite file (a migrated template
  copied per test) with `vi.resetModules()` and a deleted `prismaGlobal` so each test gets its own
  Prisma client. Reason: the correctness claims are about row-level effects across transactions,
  which a mocked Prisma client cannot prove. The GraphQL executor is a stub over hand-written
  fixture pages, so no test touches the network.
- 2026-07-29 - Phase 2 correctness review, five defects found and fixed (one commit each), full
  suite green afterwards (61 tests across 6 files: `npx vitest run`).
  1. `PayoutById` did not select `summary`, so the non-terminal refresh mapped `summaryJson` to
     `"{}"` and blanked what the payouts page had stored, on every run. Both payout documents now
     share one `PAYOUT_NODE_FIELDS` selection. This also broke invariant 2: the refresh was a row
     change every run, so re-syncing unchanged data was not a no-op.
  2. A payout that settled kept the transaction set it had while in transit. The page pass or the
     node refresh flipped `status` to `paid`, and the transaction pass then skipped it because it
     was terminal and already stamped, so lines added at settlement were never read and the rollup
     would call a stale set reconciled. A status change now clears `transactionsSyncedAt`, so the
     stamp is earned again from a fresh fetch in the same run. This refines the earlier
     "stamped only while null" decision: still no re-stamping in the steady state, but a status
     change re-opens the set.
  3. `completeRun` and `failRun` wrote by id alone, so a run that had already been superseded by a
     claimant resurrected itself as `completed` when it finally finished, overwriting the
     claimant's verdict and its counters. Both writes are now scoped to a still-running row and
     log `sync.finish_ignored` when the row has moved on.
  4. The payout list treated any `running` row as a live sync, so a run left behind by a crashed
     process disabled the "Sync now" button until the next poll superseded it (up to
     `RECON_POLL_MINUTES`, default six hours), which is exactly when an operator wants to trigger
     one by hand. The loader and `claimRun` now share `liveRun()`, which applies the same
     `STALE_RUN_MS` heartbeat test.
  5. The poller recorded `lastStartedAt` only after `startRun` returned, so a shop whose admin
     context could not be built (revoked or missing token) was retried on every 15-second tick
     forever. The attempt is recorded before it starts, which is what the code's own comment
     claimed. `tick` is now exported and covered by `app/sync/poller.test.ts`.
- 2026-07-29 - Test fixtures now project to the fields their document selects (`selectedFields` in
  `app/sync/sync.test.ts`). Reason: defect 1 was invisible because the `PayoutById` stub returned
  the whole payout fixture including a `summary` the query never asked for. A stub that is more
  generous than Shopify hides exactly the class of bug it exists to catch.
- 2026-07-29 - Known limitation, not fixed: `claimRun` is a read-then-insert inside one
  transaction. On SQLite (the default) Prisma holds a single connection, so claims serialize and
  the single-flight guarantee holds, which is what the tests assert. On PostgreSQL under READ
  COMMITTED two simultaneous claims could both see no live run and both insert. Closing that needs
  a uniqueness constraint on the claim (a new nullable column plus a unique index), which changes
  the `SyncRun` contract in `docs/architecture.md` and so needs owner approval first. Damage today
  is bounded: every write in the engine is an idempotent upsert, so a double run wastes API budget
  rather than corrupting the mirror.
- 2026-07-29 - Known limitation, not fixed: `fetchMissingOrders` takes the newest 25 missing order
  gids per run, so 25 or more permanently unreadable recent orders would starve the ones behind
  them. Phase 3 replaces this stand-in selection with the documented `partial` plus
  `source_missing` match state, which is where the fix belongs.
