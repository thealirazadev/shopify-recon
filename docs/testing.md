# Testing: shopify-recon

## Strategy

- **The pure core carries the guarantees, so it gets exhaustive unit tests.** `money.ts`,
  `dates.ts`, `match.ts`, `rollup.ts`, `anomalies.ts`, and the CSV builder are pure functions;
  every branch and boundary in them is unit-tested. If a correctness claim in
  `docs/architecture.md` cannot be traced to a test, the claim is not done.
- **The sync engine gets integration tests against a stubbed GraphQL client.** Fixture files
  hold recorded-shape responses (payout pages, transaction pages, order pages, cost
  extensions). Tests run the real engine code with a real SQLite database file (fresh per
  test) and assert row-level outcomes: idempotency, crash recovery, cursor advancement,
  claim/supersede behavior. No test ever calls the real Admin API.
- **Loaders and actions get request-level tests** with `authenticate.admin` mocked to a fixed
  session: filters, pagination, shop scoping (foreign ids -> `NOT_FOUND`), action validation,
  conflict paths, and the error envelope shape.
- **Manual end-to-end happens on a dev store** per the checklists in `docs/phases.md`: OAuth,
  embedded rendering, real sync against seeded orders, webhook delivery. This is the only
  layer not automated, because it requires Shopify infrastructure.

### What to cover

Unit:
- Money: exponent table (2/0/3), exact parse/format round-trips, over-long fraction throws,
  unknown currency throws, mixed-currency sum throws, negative amounts, BigInt bounds.
- Dates: `payoutDate` across timezones, DST spring/fall days, range boundaries at month edges.
- Match: every state and reason; amount sign handling for refunds; unknown types categorized
  as adjustment; determinism (same input, same output, any order).
- Rollup: each total, variance sign, every `reconStatus` condition, skip on unstamped payouts.
- Anomalies: each rule firing and not firing; fee band boundaries at exactly the edge and one
  minor unit outside; aging window boundary day.
- CSV: balanced row set, sign conventions, zero-decimal currencies, injection guard, unbalanced
  set throws.
- Throttle pacing core: sleep computation from cost feedback, retry-once on THROTTLED.

Integration (stubbed client + real SQLite):
- Full sync from empty: counts match fixtures; second run changes zero rows.
- Crash mid-payout-transactions: refetch from page one, convergence, no duplicates.
- Watermark and overlap behavior; non-terminal payout refresh flips status.
- Claim: concurrent trigger conflict; stale heartbeat supersede.
- Recon after sync: end-to-end from fixture data to discrepancy rows; auto-resolve; manual
  resolution survival.

Route level:
- Payout list filters and pagination; payout detail line filter; discrepancy resolve/reopen/
  annotate including double-submit; settings validation; export routes (headers, filename,
  `CONFLICT` on pending payouts); every JSON error matches the envelope.

## Exact commands

```bash
npm test                 # full Vitest suite
npm test -- --watch      # watch mode
npm test -- money        # single file by name filter
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
```

First-time setup:

```bash
npm install
cp .env.example .env     # fill Shopify app credentials
npx prisma migrate dev
npm run dev              # shopify app dev (tunnels to the dev store)
```

## CI plan

GitHub Actions on push and pull request to `main`: Node 20, `npm ci`, `npm run typecheck`,
`npm run lint`, `npm test`. The suite must not need Shopify credentials; anything requiring a
real store stays in the manual checklists. CI is added when the repository goes public, running
exactly the commands above, nothing more.

## Definition of "done" for a feature

1. `npm run typecheck` and `npm run lint` clean.
2. `npm test` green, new tests included in the same commit series.
3. The feature's manual checklist items in `docs/phases.md` pass on the dev store.

After creating or editing files, run the checks and fix all errors before reporting done. One
commit per feature, in the order listed in `docs/phases.md`.
