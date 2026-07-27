# Engineering Rules: shopify-recon

These rules are binding for every change in this repository. They extend the workspace
CLAUDE.md; where both speak, the stricter rule wins.

## Conventions

- **Framework patterns**: Remix idioms throughout. Loaders read, actions mutate; route modules
  stay thin and delegate to `app/lib` (pure logic) and `app/sync` (server orchestration). No
  business logic in components. Server-only modules use the `.server.ts` suffix so Vite never
  bundles them for the client.
- **Pure core**: `money.ts`, `dates.ts`, `match.ts`, `rollup.ts`, and `anomalies.ts` are pure:
  no Prisma, no fetch, no Date.now() (time is a parameter). They carry the correctness
  guarantees and must stay unit-testable in isolation.
- **One Admin API path**: Every Shopify call goes through the throttled client in
  `sync/throttle.server.ts`. No route, loader, or helper calls the Admin API directly.
- **Preferred libraries**: Only what the stack already includes: Remix, the Shopify packages,
  Prisma, Polaris, Vitest. No date libraries (use `Intl`), no decimal libraries (integer minor
  units), no CSV library unless a phase approves one, no state managers.
- **Naming**: Routes follow Remix flat-file conventions; Prisma models singular `PascalCase`
  with the exact names in `docs/architecture.md`; columns `camelCase`; status/type values
  lowercase snake_case strings. Log keys are dotted (`sync.completed`).
- **Commit format**: Conventional Commits, short imperative subject, lowercase after the
  prefix, e.g. `feat: add payout sync with overlap window`.
- **One commit per feature**: Each task in `docs/phases.md` is exactly one commit, in the
  listed order. Never batch features; never fragment one small feature.
- **Pin exact dependency versions**: Exact versions in `package.json`, lockfile committed. Any
  dependency change is its own commit and needs approval first.
- **DB migration rule**: Every schema change goes through a Prisma migration. Never edit an
  applied migration; add a new one. Model changes ship in the same commit as their migration.

## Money and matching discipline

- **No floats, ever**: Amounts are `BigInt` minor units from parse to render. `parseFloat`,
  `Number(amount)`, and arithmetic on decimal strings are defects, not style choices.
- **Parse at the edge**: Shopify decimal strings become minor units in `lib/money.ts` at sync
  time; formatting back happens only in the UI and CSV layers. Nothing in between touches
  decimal representations.
- **Currency is part of the value**: Helpers that combine amounts require an explicit currency
  and throw on a mismatch. Never store or pass an amount without its currency nearby.
- **Match states are exhaustive**: Every balance transaction ends a recon pass in exactly one
  of `matched`, `partial`, `unmatched`, with `matchReason` set for the last two. No silent
  fallthrough; an unknown transaction type is categorized as adjustment and logged.
- **Derived state stays derived**: Never hand-edit match or rollup columns in a route action.
  The only path that writes them is the recon pass; operator actions touch `Discrepancy` only.

## Error handling & logging

- **Every external/fallible call handles failure**: Admin API calls (network, 5xx, THROTTLED,
  userErrors), database writes, and CSV generation all have explicit failure paths that leave
  the run record or response in a defined state. No bare awaits that assume success.
- **Friendly user errors vs detailed logs**: UI surfaces short messages via the error envelope
  or Polaris banners; full context (request id, shop, run id, GraphQL errors - never tokens,
  never full payloads) goes to logs only. No stack traces to users.
- **One consistent JSON error format** (see `docs/api-contracts.md`):
  `{ "error": { "code": "...", "message": "...", "requestId": "..." } }` for every JSON error.
- **Structured logging from day one**: JSON lines with dotted event keys: `sync.started`,
  `sync.page_committed`, `sync.completed`, `sync.failed`, `sync.throttled`,
  `sync.unknown_type`, `recon.completed`, `recon.variance_found`, `discrepancy.opened`,
  `discrepancy.auto_resolved`, `discrepancy.resolved`, `export.generated`, `webhook.received`,
  `webhook.invalid_hmac`. Every entry carries `shop` and, where relevant, `runId`.

## Security

- **No hardcoded secrets**: All secrets in `.env` (git-ignored); `.env.example` carries dummies
  only. Access tokens live in the `Session` table via the official adapter and are never
  logged.
- **Auth on every surface**: `authenticate.admin(request)` on every `app.*` loader and action;
  `authenticate.webhook(request)` (HMAC) on the webhook route. No exceptions, no debug routes.
- **Shop scoping is mandatory**: Every Prisma query on app data filters by the authenticated
  `session.shop`. A row id belonging to another shop returns `NOT_FOUND`, never data.
- **Validate all input server-side**: Action form fields (settings numbers, date ranges,
  discrepancy ids, notes max 1000 chars) are validated in the action; nonsense filter params
  yield empty states, not errors.
- **Rendered data is escaped**: Order names and notes render through React text nodes only;
  no `dangerouslySetInnerHTML` anywhere.
- **CSV injection guard**: Any exported cell that would start with `=`, `+`, `-`, or `@` is
  prefixed with `'`.
- **Read-only against Shopify**: The app must never call a mutation on the Admin API. Adding
  one requires owner approval and a scope change.

## Simplicity / YAGNI-KISS

- Build only what the current phase requires. No speculative settings, no premature caching,
  no abstraction until three real use cases exist.
- Prefer the platform mechanism: Prisma upserts over hand-rolled merge logic, `Intl` over date
  libraries, Polaris components over custom CSS.
- No new wrapper classes, managers, or utils files without owner approval first.
- If a solution exceeds ~150 lines, pause and justify it before continuing.

## Boundaries - never do without asking the owner first

- **No wholesale delete/rewrite** of working files. Targeted edits; flag destructive changes.
- **Do not change `docs/PRD.md` or `docs/architecture.md`** without flagging the change and
  getting sign-off - they are the source of truth.
- **No new dependency without approval.** Propose what, why, version, and size, then wait.
- **Ask when ambiguous** rather than guessing at product behavior.
- **Stop after two failed fix attempts** on the same problem; report what was tried instead of
  thrashing.
- **Scope discipline**: any mid-phase request not in `docs/PRD.md` gets classified with the
  owner as current phase, new phase, or Backlog in `docs/phases.md`. Never silently absorb
  scope.
