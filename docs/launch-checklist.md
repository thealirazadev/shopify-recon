# Launch Checklist: shopify-recon

Work top to bottom before going to production. Nothing is checked until verified in the target
environment.

## Environment & configuration

- [ ] Production `.env` from `.env.example` with real values; `SHOPIFY_APP_URL` is the real
      HTTPS host; no dummies remain.
- [ ] `DATABASE_URL` points at production PostgreSQL; credentials stored securely, not in the
      repo; `prisma migrate deploy` runs cleanly.
- [ ] `RECON_POLL_MINUTES` reviewed for this deployment (default 360).
- [ ] Exactly one app instance deployed - the in-process poller and claim path assume no
      horizontal scaling (see `docs/architecture.md`).
- [ ] Shopify app configuration (App URL, redirect URLs, scopes
      `read_orders,read_shopify_payments_payouts`) matches the deployed host.

## Security

- [ ] No secrets committed; `.env` git-ignored; access tokens only in the `Session` table.
- [ ] Webhook HMAC rejection verified against a forged request (401, `webhook.invalid_hmac`).
- [ ] A second dev store cannot see or mutate the first store's rows (forced id probes return
      `NOT_FOUND`).
- [ ] CSV formula-injection guard verified with an order name starting with `=`.
- [ ] Confirmed the app performs zero Admin API mutations (scope list alone enforces this).

## Reliability & correctness

- [ ] Full sync on a production-scale store completes; local payout and order counts match
      Shopify Admin; second run reports zero row changes.
- [ ] Kill-the-process test mid-sync: restart converges with no duplicates; the superseded run
      is visible in sync history.
- [ ] Throttle behavior observed in logs on the initial backfill (`sync.throttled` entries,
      no failed runs from rate limiting).
- [ ] A known-good payout shows `reconciled` with zero variance; a seeded fee anomaly and a
      seeded refund both produce exactly one discrepancy each.
- [ ] Payout webhook (if registered on the pinned API version) observed triggering a run;
      poller observed covering a deliberately missed webhook.
- [ ] Database backups scheduled and a restore tested once.

## Data & compliance

- [ ] `shop/redact` verified to delete every row for the shop.
- [ ] Uninstall/reinstall cycle verified: sessions cleaned up, reinstall re-bootstraps `Shop`
      and resumes syncing without duplicating rows.
- [ ] Export CSV opened in a spreadsheet by an accountant-shaped human: columns, signs, and
      per-payout balance confirmed sensible.

## Quality gates

- [ ] `npm run typecheck`, `npm run lint`, `npm test` green in CI on the deployed commit.
- [ ] Lockfile committed and matching the deployed build.
- [ ] Every screen checked in its empty state and inside the Admin iframe at 320px width.
- [ ] Structured logs verified for the documented keys; zero unexpected error lines during a
      full sync-and-browse pass.
