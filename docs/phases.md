# Phases: shopify-recon

**Rule: phase N+1 does not start until the owner approves phase N.** Phases are ordered
smallest-useful-shippable first; each ends green (app runs, typecheck and lint clean, tests
pass). One commit per feature/task, Conventional Commits, in the listed order.

The senior differentiators are hard requirements placed early: integer-minor-unit money and
shop-timezone dates land in Phase 1; idempotent cursor-based sync with single-flight claims,
crash recovery, and cost-aware throttling land in Phase 2; deterministic matching with explicit
states and idempotent discrepancy detection land in Phase 3. None of these may slip.

---

## Phase 1 - Foundation: scaffold, schema, money, and dates

**Goal**: An installable embedded app skeleton with the full database schema and the two pure
libraries every later phase depends on, both fully tested.

### Definition of done

- App scaffolded on the `shopify-bulk-editor` conventions: Remix (Vite) + TypeScript strict,
  `@shopify/shopify-app-remix` OAuth with Prisma session storage, Polaris shell with NavMenu
  (Payouts, Discrepancies, Settings), webhook route handling `app/uninstalled`,
  `app/scopes_update`, and the three compliance topics.
- Prisma schema contains every table from `docs/architecture.md` exactly (Session, Shop,
  SyncCursor, SyncRun, Payout, BalanceTransaction, Order, OrderTransaction, Refund,
  Discrepancy) with all unique keys and indexes; initial migration applied on SQLite.
- `lib/money.ts`: parse decimal string to minor units per ISO 4217 exponent (2/0/3 digit
  currencies), format back, sum with currency assertion; unknown currency and over-long
  fraction throw named errors.
- `lib/dates.ts`: `payoutDate` from a UTC instant + IANA timezone, shop-local date-range
  boundaries; DST transition days covered by tests.
- `lib/logger.server.ts` (JSON lines, dotted keys) and `lib/errors.ts` (the error envelope from
  `docs/api-contracts.md`).
- On first authenticated load, the shop's payout currency and IANA timezone are fetched and
  stored on `Shop` (upsert; re-entry is a no-op).
- `.env.example` documents all six variables with dummies; startup fails fast when one is
  missing.

### Verification checklist

- `npm run typecheck`, `npm run lint`, and `npm test` all pass clean.
- `npm run dev` boots against a dev store; OAuth completes; the embedded shell renders with
  three nav items and an empty payouts placeholder.
- `prisma migrate reset` then `migrate dev` applies cleanly; the SQLite schema shows every
  index from the architecture doc.
- Money tests cover: "10.00" USD -> 1000n; "1000" JPY -> 1000n; "1.234" BHD -> 1234n; "10.001"
  USD throws; "10.00" in "XYZ" throws; mixed-currency sum throws.
- Date tests cover: a payout at 03:00 UTC with timezone America/New_York lands on the previous
  calendar day; DST spring-forward and fall-back days produce the expected `payoutDate`.
- Uninstall webhook deletes the shop's sessions; invalid HMAC returns 401 and logs
  `webhook.invalid_hmac`.

### Commits

1. `chore: scaffold remix app with shopify auth and polaris shell`
2. `chore: add env example and fail fast config`
3. `feat: add prisma schema and initial migration`
4. `feat: add money helpers with currency exponents`
5. `feat: add shop timezone date helpers`
6. `feat: add structured logger and error envelope`
7. `feat: bootstrap shop settings on first load`
8. `feat: add webhook route with uninstall and compliance topics`
9. `test: cover money and date helpers`

---

## Phase 2 - Sync engine: payouts, transactions, orders

**Goal**: A sync run converges the local mirror with Shopify: idempotent, resumable after a
crash, throttle-aware, and triggerable by webhook, poller, or button.

### Definition of done

- `sync/throttle.server.ts`: cost-aware client wrapping every Admin GraphQL call; tracks
  `extensions.cost`, sleeps on insufficient budget, retries `THROTTLED` once; pure pacing core
  unit-tested with simulated cost feedback.
- `sync/run.server.ts`: claim (single flight per shop), heartbeat between pages, stale-run
  supersede after 5 minutes, run counters, terminal status recording.
- Payout sync per `docs/architecture.md`: newest-first paging to watermark minus 3-day overlap,
  non-terminal refresh by node lookup, `legacyId` derived from the GID, `payoutDate` derived
  via `lib/dates.ts`, summary stored in minor units via `lib/money.ts`.
- Per-payout balance transaction fetch with per-page commits and the `transactionsSyncedAt`
  stamp only after the final page.
- Incremental order/refund sync by `updated_at` watermark with inline transactions and
  refunds; targeted order fetch by GID for `source_missing` charges, bounded at 25 per run.
- Page commit rule holds everywhere: page rows + cursor advance in one transaction.
- Payouts webhook topic registered when available; handler records a trigger and returns 200;
  poller singleton starts runs every `RECON_POLL_MINUTES`; "Sync now" action on the payout
  list uses the same claim path and returns `CONFLICT` when a run is active.
- Structured logs: `sync.started`, `sync.page_committed`, `sync.completed`, `sync.failed`,
  `sync.throttled`, `sync.unknown_type`, `webhook.received`.

### Verification checklist

- Typecheck, lint, and full test suite pass; integration tests run the engine against a stubbed
  GraphQL client backed by fixture pages.
- Idempotency test: run sync twice over identical fixtures; the second run performs zero row
  changes (assert via row counts and updated timestamps).
- Crash test: abort the stubbed run mid-payout-transactions; re-run; the payout refetches from
  page one and converges; no duplicate rows.
- Claim test: two concurrent triggers produce one `running` run and one `CONFLICT`; a run with
  a stale heartbeat is superseded by the next trigger.
- Throttle test: simulated low `currentlyAvailable` produces the computed sleep; a second
  `THROTTLED` fails the run with cursors intact.
- Against a dev store: initial sync mirrors payout and order counts visible in Shopify Admin;
  a new test order appears after the next run.

### Commits

1. `feat: add cost aware throttled graphql client`
2. `feat: add sync run claim heartbeat and supersede`
3. `feat: add payout sync with overlap and refresh`
4. `feat: add per payout balance transaction sync`
5. `feat: add incremental order and refund sync`
6. `feat: add targeted order fetch for missing sources`
7. `feat: add payouts webhook trigger and poller`
8. `feat: add manual sync action with conflict guard`
9. `test: cover sync idempotency crash recovery and claims`

---

## Phase 3 - Recon: matching, rollup, discrepancies

**Goal**: Every balance transaction gets an explicit match state, every payout gets computed
totals asserted against its deposit, and every anomaly becomes exactly one discrepancy row.

### Definition of done

- `lib/match.ts` implements the two-stage pipeline and state table from `docs/architecture.md`;
  every input transaction yields a state and, for `partial`/`unmatched`, a reason.
- `lib/rollup.ts` computes the five totals plus variance in minor units and derives
  `reconStatus` per the status table; skips payouts with `transactionsSyncedAt` null.
- `lib/anomalies.ts` implements the five rules with the fee-band formula and aging window read
  from `Shop` settings.
- `sync/recon.server.ts` runs match -> rollup -> detection after every completed sync;
  discrepancy persistence upserts on the unique key, refreshes `lastSeenAt`/`detailJson`,
  auto-resolves stale open rows, never touches manually resolved rows.
- Recompute safety: running recon twice in a row changes nothing; wiping all match and rollup
  columns and re-running reproduces them exactly.
- Structured logs: `recon.completed` (with counts), `recon.variance_found`,
  `discrepancy.opened`, `discrepancy.auto_resolved`.

### Verification checklist

- Typecheck, lint, tests pass. Unit tests cover every match state and reason, each rollup
  total, each `reconStatus` condition, and each of the five rules firing and not firing.
- Fixture store test: a seeded dataset with one clean payout, one fee anomaly, one missing
  order, one currency mismatch, and one unmatched line produces exactly the expected
  discrepancy set; re-running detection produces zero new rows.
- Variance test: altering one local `amountMinor` flips the payout to `variance` with the
  exact minor-unit difference; restoring it flips back to `reconciled` and auto-resolves the
  discrepancy.
- Resolution test: manually resolving a discrepancy, then re-running detection with the
  condition still true, leaves it resolved.
- Fee band test: boundary values (exactly at band edge, one minor unit outside) behave per the
  formula.

### Commits

1. `feat: add matching pipeline with explicit states`
2. `feat: add payout rollup and variance`
3. `feat: add discrepancy rules`
4. `feat: persist discrepancies idempotently`
5. `feat: run recon after each sync`
6. `test: cover matching rollup and discrepancy rules`

---

## Phase 4 - Dashboard: payouts, discrepancies, settings

**Goal**: The merchant can see every payout's status, trace any line to its source, work the
discrepancy queue, and tune the fee band and aging window.

### Definition of done

- Payout list (`app._index.tsx`): IndexTable of payouts (date, status, recon status badge,
  gross, fees, refunds, adjustments, net, variance), filters for recon status and date range,
  pagination, sync banner (running run or last completed with counts), "Sync now" button.
- Payout detail (`app.payouts.$id.tsx`): rollup summary card (computed vs reported, variance
  highlighted), line-by-line table with type, source link (order name), amount, fee, net, match
  state badge and reason; link to export CSV.
- Discrepancy queue (`app.discrepancies.tsx`): filterable by type and status; resolve with
  optional note, reopen, annotate; row detail shows `detailJson` expected/actual.
- Settings (`app.settings.tsx`): fee band and aging window form with server-side validation;
  read-only shop currency and timezone; sync run history table (last 20 runs with status,
  trigger, counts, error).
- All amounts rendered via `lib/money.ts` formatting with the shop currency; all dates rendered
  as shop-local.
- Every screen has explicit empty, loading (skeleton), and error states; actions confirm via
  Polaris patterns; double-submits are safe (`CONFLICT` on already-resolved).

### Verification checklist

- Typecheck, lint, tests pass; loader/action tests (mocked `authenticate.admin`) cover
  filters, pagination, shop scoping (foreign id -> `NOT_FOUND`), resolve/reopen/annotate, and
  settings validation (negative and out-of-range values rejected).
- Manual pass on the dev store: every screen renders inside the Admin iframe; filters combine
  with pagination; a resolved discrepancy disappears from the open filter; settings changes
  take effect on the next recon pass.
- Empty states: fresh install shows a payouts empty state prompting a first sync; empty
  discrepancy queue states "nothing open".
- Accessibility spot check: keyboard navigation through list -> detail -> resolve; badges carry
  text labels, never color alone.

### Commits

1. `feat: add payout list with filters and sync banner`
2. `feat: add payout detail with line breakdown`
3. `feat: add discrepancy queue with resolve and annotate`
4. `feat: add settings screen with validation`
5. `feat: add sync run history to settings`
6. `test: cover loaders actions and shop scoping`

---

## Phase 5 - Export and hardening

**Goal**: Accountant-ready CSV export and a polished, honest v1.

### Definition of done

- `lib/csv.server.ts`: journal row set per payout (gross sales credit, fees debit, refunds
  debit, adjustments debit or credit by sign, net deposit debit) per
  `docs/api-contracts.md`; per-payout balance asserted (debits equal credits) before
  serving; formula-injection guard applied; amounts as exact decimal strings.
- `app.payouts.$id.export.tsx` streams one payout's CSV; `app.export.tsx` streams a date
  range (shop-local, validated, capped at 366 days); filenames include shop and period.
- Export of a `pending` payout is refused with `CONFLICT` (incomplete data would mislead).
- README finalized: real install/run/test instructions replacing planning-stage notes.
- Structured log `export.generated` with payout count and row count.
- Full manual pass of the PRD success criteria; all earlier phase checklists still green.

### Verification checklist

- Typecheck, lint, tests pass. CSV unit tests: balanced set for a clean payout; refund and
  adjustment signs correct; JPY payout renders zero-decimal amounts; a cell starting with `=`
  is prefixed; an artificially unbalanced set throws and the route returns the `INTERNAL`
  envelope.
- Range export across a month boundary in the shop timezone includes exactly the payouts whose
  `payoutDate` falls in range.
- Opened in a spreadsheet: columns align, no formula execution, totals per payout net to zero.
- A `pending` payout's export button is disabled and the route returns `CONFLICT` when forced.

### Commits

1. `feat: add journal csv builder with balance assertion`
2. `feat: add per payout csv export route`
3. `feat: add date range csv export route`
4. `feat: refuse export of incomplete payouts`
5. `docs: finalize readme`
6. `test: cover csv balance signs and injection guard`

---

## Backlog

_(move out-of-scope ideas here with a one-line rationale; empty at planning time)_
