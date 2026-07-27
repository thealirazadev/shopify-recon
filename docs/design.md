# Design: shopify-recon

The app is an embedded Shopify Admin app and looks like Admin: Polaris components only, no
custom CSS beyond spacing tweaks, no custom color values. The design goal is auditability at a
glance - a bookkeeper should see "what does not add up" within two seconds of opening any
screen. Density and traceability beat decoration.

## Navigation

App Bridge NavMenu with three items: **Payouts** (home), **Discrepancies**, **Settings**.
Payout detail and exports hang off the payout list; there is no hidden navigation.

## Screens

### Payout list (home)

- **Sync banner** at top: while a run is active, an info Banner with a spinner ("Syncing -
  started 2 minutes ago") polling the loader every 3 seconds; otherwise a subdued line with the
  last completed sync time and counts, plus the **Sync now** button (disabled while running).
- **Filters**: recon status (all / pending / reconciled / variance) and a shop-local date-range
  picker over `payoutDate`. Filters combine and survive pagination.
- **IndexTable** rows: payout date, payout status badge, recon status badge, gross, fees,
  refunds, adjustments, net, variance. Amounts right-aligned, formatted in the shop currency;
  variance shows only when nonzero. Row click opens the payout detail.
- Open discrepancy count appears as a critical Badge on the Discrepancies nav item area (a
  count line above the table linking to the queue).

### Payout detail

- **Header**: payout date, payout status badge, recon status badge, export CSV button
  (disabled with a tooltip while the payout is `pending`).
- **Rollup card**: two columns, computed vs reported - gross, fees, refunds, adjustments, net.
  A nonzero variance renders as a critical inline callout with the exact amount.
- **Lines table**: one row per balance transaction - type, source (order name linking to the
  order in Shopify Admin, or the adjustment label), amount, fee, net, match state badge with
  the reason as help text. Sorted by transaction date.
- Lines paginate at 50; the match state filter (all / matched / partial / unmatched) narrows
  the table.

### Discrepancy queue

- **Filters**: type (five types), status (open / resolved / auto-resolved), default open.
- **IndexTable** rows: type badge, subject (payout date or order name, linked), summary from
  `detailJson`, first seen, last seen, status badge.
- **Row actions**: Resolve (modal with optional note, confirm), Reopen (resolved rows only),
  Annotate (edit note without changing status). Double-submit safe: acting on an
  already-changed row shows a clear error toast, not a crash.
- Expanded row shows expected vs actual values from `detailJson` in a definition list.

### Settings

- **Reconciliation settings card**: expected fee percent (bps rendered as a percentage), fixed
  fee, tolerance, aging window days. Server-validated; save shows a success toast and notes
  that changes apply on the next recon pass.
- **Shop card** (read-only): payout currency, IANA timezone, with a line explaining both come
  from Shopify and update on sync.
- **Sync history card**: last 20 runs - started, trigger, status badge, counts, error message
  for failed runs.

## Status badges

Consistent Polaris badge tones everywhere a status appears; label text always accompanies
color:

| Status | Tone |
| --- | --- |
| `reconciled` / `matched` / run `completed` | success |
| `pending` / run `running` | info |
| `partial` / payout `in_transit` / `scheduled` | attention |
| `variance` / `unmatched` / run `failed` / open discrepancy | critical |
| `resolved` / `auto_resolved` / `superseded` | subdued (default) |

## States

- **Loading**: Polaris SkeletonPage / SkeletonBodyText on first load; polling updates swap
  content without layout shift.
- **Empty**: every list has an explicit EmptyState - payouts ("No payouts synced yet" with a
  Sync now action), discrepancies ("Nothing open - all payouts check out"), filtered-to-empty
  ("No results for these filters" with a clear-filters action).
- **Error**: loader failures render a critical Banner with a retry link; action failures
  surface the envelope message in a toast. Never a blank screen, never a stack trace.

## Accessibility baseline

- Polaris defaults carried through: real buttons and links, labeled form fields, focus rings.
- Status is always text plus tone, never color alone; amount columns carry explicit headers.
- All flows (filter, resolve, export, settings) operable by keyboard; modals trap and restore
  focus. Tables remain readable at 320px width via horizontal scroll inside the card.
