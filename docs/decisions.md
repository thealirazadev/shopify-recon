# Design decisions

## 1. Money is integer minor units, parsed once at the edge

Every amount is a `BigInt` count of minor units from sync to storage. `parseMoney` in
`app/lib/money.ts` is the only place a Shopify decimal string is parsed, and it uses string
arithmetic against an ISO 4217 exponent table, never a float. The table is an explicit
allowlist covering exponents 0, 2, 3, and 4, so an unknown currency is an error rather than a
guessed exponent of 2, and a fraction longer than the currency allows (for example `10.001` USD)
throws instead of rounding. Combining amounts in different currencies throws as well. A
reconciliation tool that is quietly one minor unit off is worse than one that stops, so a bad
amount fails the sync run. The exponent lists are stored as space-delimited strings because a
180-entry array formatted one code per line would bury the module's logic.

## 2. Balance transactions are fetched per payout

Transactions are read with a `payout_id:` filter for each payout rather than from one global
transaction stream. The product's core claim is per-payout completeness, and fetching per payout
makes "this payout's transaction set is complete" a local fact: `transactionsSyncedAt` is set
only in the transaction that commits the last page. A global stream can deliver transactions
before their payout exists and would need a re-association sweep. The accepted cost is that
transactions still in the pending balance are not mirrored; they cannot be reconciled yet anyway.

## 3. Re-syncing unchanged data is a true no-op

Prisma's `@updatedAt` bumps on every `update` call even when no value changes, so an upsert-only
sync would rewrite every row on every run. `isUnchanged` in `app/lib/diff.ts` compares the mapped
row with the stored one, field by field (dates by timestamp), and every mirror write is skipped
when they agree. Cursor rows get the same treatment: an unconditional cursor upsert made a second
identical run a row change, so cursors are written only when the watermark actually moves, and
`transactionsSyncedAt` is stamped only while it is null. The sync test runs the engine twice over
identical fixtures and asserts that every mirrored row, including `updatedAt`, is byte-identical.

## 4. Watermarks advance only when the pages behind them are safe

Payouts page newest-first and stop once they pass the stored watermark minus a three-day overlap,
so a payout that Shopify back-dates or amends inside that window is read again. Because the order
is newest-first, the payouts watermark advances only in the transaction that commits the final
page of the pass; advancing on page one would let a crash on page two skip everything behind it
forever. Order pages run oldest-first by `UPDATED_AT` and advance their cursor with each page. In
both cases a page's rows commit atomically with whatever cursor movement goes with them.

## 5. A status change re-opens a payout's transaction set

Non-terminal payouts are refreshed by node lookup on every run, at most 200 per run. Two bugs
were found here. The node query did not select `summary`, so each refresh blanked the summary the
page query had stored, and the refresh was a row change on every run. Both queries now share one
`PAYOUT_NODE_FIELDS` selection, and the sync test stubs return only the fields a document selects
so a stub can no longer hide a missing field. Second, a payout that moved from in transit to
`paid` kept the transaction set it had before settlement, because the transaction pass skipped
terminal payouts that were already stamped. Any status change now clears `transactionsSyncedAt`,
so completeness has to be earned again by a fresh fetch in the same run.

## 6. One run per shop, claimed in a transaction

`claimRun` reads the shop's `running` sync runs and inserts a new one inside a single database
transaction. A run whose heartbeat is older than five minutes is treated as dead and marked
`superseded` by the claimant. `completeRun` and `failRun` update only a row that is still
`running`; before that fix, a superseded run that eventually finished overwrote the claimant's
verdict and counters. The payout list and the claim path share `liveRun()`, so a run abandoned by
a crashed process no longer keeps the "Sync now" button disabled until the next poll. On SQLite,
Prisma serializes the transaction and the guarantee holds, which is what the tests assert. On
PostgreSQL under READ COMMITTED two simultaneous claims could both insert; closing that needs a
unique constraint on the claim. The damage is bounded because every write is an idempotent
upsert, so a double run wastes API budget rather than corrupting the mirror.

## 7. The poller guarantees convergence; the webhook only shortens the wait

A module-level poller ticks every 15 seconds, drains shops that a webhook asked for, and starts a
run for any shop whose last attempt is older than `RECON_POLL_MINUTES` (six hours by default).
The attempt time is recorded before the attempt, so a shop whose token was revoked backs off to
the poll interval instead of being retried every tick; it was originally recorded after
`startRun` returned, which retried such shops forever. Webhook triggers live in an in-memory set
rather than a table: the app runs as a single instance, and a trigger lost on restart costs only
latency. Payout webhook topic names vary by API version, so no payout topic is registered;
`actionForTopic` treats any delivered topic containing "payout" as a sync trigger, and
registering a wrong topic string cannot break the registration of the topics that do work.

## 8. One throttled path to the Admin API

Every Admin GraphQL call, including the shop bootstrap, goes through the client in
`app/sync/throttle.server.ts`. It paces calls from the `extensions.cost` feedback, retries a
`THROTTLED` response once, and fails the run on a second throttle or any other GraphQL error,
leaving both cursor watermarks unchanged. The app requests only `read_orders` and
`read_shopify_payments_payouts` and contains no mutations.

## 9. Bounded work per run

Each run refreshes at most 200 non-terminal payouts, fetches orders in pages of 25 (each page
carries up to 50 transactions and 50 refunds inline, so larger pages become expensive single
queries), and fetches at most 25 orders that payout lines reference but the mirror lacks, chosen
from the 500 most recent referenced lines. Every one of these is otherwise an unbounded external
cost, and all of them converge over successive runs. A known limitation: 25 or more permanently
unreadable recent orders would starve the missing orders behind them.

## 10. Payout dates are stored in the shop's timezone

`payoutDate` is a calendar date string derived once at sync time in the shop's IANA timezone,
not converted from `issuedAt` at query time. Filters, grouping, and export period boundaries all
need one stable shop-local date, and a stored column can be indexed. `shopDateRange` resolves a
shop-local midnight to a UTC instant with two offset passes and no date library, because the
offset depends on the instant being computed and one pass is wrong near a DST change. On a day
whose local midnight does not exist (spring-forward in America/Santiago) the result is the first
local moment that does. The shop's currency and timezone are re-read at the start of every run
and a change is logged; a currency with no known exponent or an unusable timezone is refused
rather than stored. The cost is that a timezone change needs a full re-sync to recompute dates.

## 11. Normalize join keys and fill missing dates at the edge

Shopify can return `sourceOrderTransactionId` as a legacy numeric id. The sync promotes a numeric
value to `gid://shopify/OrderTransaction/<id>` at write time so that linking a balance
transaction to its order transaction is a plain equality join; any other value passes through
unchanged. An order without `processedAt`, or a transaction or refund without its own date, falls
back to the order's last update, the closest available date, and a balance transaction without a
fee stores `0`.

## 12. Matching is staged and deterministic, and derived state stays derived

The matcher in `app/lib/match.ts` is a pure staged pipeline, not a scoring heuristic: every
balance transaction leaves it in exactly one of `matched`, `partial`, or `unmatched`, with a
stated reason (`source_missing`, `amount_mismatch`, `currency_mismatch`, `no_source`) for the
last two, and the same input always produces the same output. Any type other than `charge` or
`refund` is treated as a self-describing adjustment, so a type Shopify adds later cannot fall
through. `app/lib/rollup.ts` asserts each payout's computed net against the deposited amount and
keeps the difference as `varianceMinor` rather than absorbing it. Match and rollup fields are
derived and recomputed from scratch, while operator notes and resolutions live only on
`Discrepancy`, so recomputing can never destroy human work. These modules are pure and take no
clock; the reconciliation pass that runs them against the mirror is not built yet.

## 13. Sync tests use a real database

The sync suite runs the real engine against a real SQLite file, copied from a migrated template
for each test, with a fresh Prisma client per test. The correctness claims are about row-level
effects across transactions (idempotency, crash recovery, claims and supersedes), which a mocked
Prisma client cannot prove. Only the GraphQL executor is stubbed, with hand-written fixture
pages, so no test touches the network.
