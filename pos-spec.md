# Sentry — POS Terminal Spec

**App:** `sentry-pos-fe` · **Status:** MVP scope locked · owner walkthrough completed 2026-08-19 · **Updated:** 2026-08-19

Companion to `project-spec.md`, which owns architecture, stack, tenancy, data model, money rules, and sync design. This document owns what the terminal does.

## 1. Principles

- **Owner-operated MVP:** no staff accounts or PINs for selling; whoever holds the paired device operates it. The one PIN in MVP is the **BO's refund PIN** (§7).
- **Online-first build, offline-ready design:** in this phase the terminal calls the API directly; the offline layer (project-spec §5) is the final milestone. Client UUIDs, event-based stock, and the static client-only app hold from day one so that layer bolts on cleanly.
- **Read-only catalog, append-only events** — the terminal never edits catalog data and only ever *appends* sales, movements, and shift events.
- **Design target:** fully responsive across mobile, tablet, laptop, and desktop — tablet landscape is the primary design target; phones get the collapsed list layout, larger screens the full grid. Evergreen browsers only. Visual language per `design-spec.md`: tokens, pill buttons, and card language in a dense layout — no hero bands on operational screens.

## 2. Screen Inventory

Pairing · Shift Open · **Sale** (home) · Payment · Receipt · Sales History · Sale Detail · Shift & Close · Stock · Settings — roughly 10 screens, plus modals (refund PIN prompt, SC/PWD capture, misc item).

## 3. Pairing & Startup (*online-only*, once per device)

First launch shows pairing: BO signs in → picks business → picks branch → names the terminal → API issues a branch-scoped device token → terminal loads catalog and settings (straight from the API for now; mirrored into Dexie once the offline layer lands). From then on: launch goes straight to the Sale screen if a shift is open, otherwise to the Shift Open prompt. Unpairing lives in Settings (BO re-auth) — and the BO can also **remote-unpair from the portal**, which 401s the device on its next request and resets it to pairing. One terminal pairs to exactly one branch; moving a device is unpair + re-pair, a few seconds' work.

## 4. Sale Screen (home)

Two panes: product area and cart.

**Product area**

- Category tabs with product tiles; text search by name or SKU.
- Barcode: a global key listener captures keyboard-wedge scanner input (digits + Enter); an exact match adds to cart instantly with no field focus needed; a repeat scan increments the existing line's qty.
- `business_type` sets the default emphasis — retail opens search/barcode-forward, F&B opens grid-forward. Same components either way.
- A product with variants opens a variant picker; one with modifier groups opens a modifier sheet that enforces `min_select`/`max_select` and shows price deltas.
- **Weight items:** products with `sold_by: weight` swap the qty stepper for a keyed decimal amount (e.g. `0.750`) — the store's own scale supplies the number.
- **Misc item** button: type a name and an amount → cart line with `product_id = null`, no stock movement. Governed by the per-business `allow_misc_items` setting; reported as its own group and as a % of sales so overuse is visible.
- **Zero-stock block:** a `track_stock` product at zero can't be added — the tile shows out-of-stock. The sanctioned on-the-spot fix is a quick stock adjustment (§9), which is audit-logged.

**Cart**

- Lines: name, qty (stepper or keyed weight), unit price, line discount (named-list picker; free-entry amount or % for the BO), remove.
- **Price locks at add-to-cart** — a portal price change never touches a cart in progress; the customer pays what they were quoted.
- **No price overrides** — tawad is expressed as a discount, keeping the catalog price the anchor so reports show exactly what was given away. Discounts are capped: no line or order total can go negative.
- **Discounts come from the BO's named list** (a picker on lines and on the order); free-entry amounts are a BO-role privilege — when staff arrive, managers and cashiers select, never type (`staff-spec.md`).
- Order-level discount (named list, or free-entry for the BO), order-type chip (dine-in / takeout / none).
- **SC/PWD discount** — a dedicated discount type, distinct from regular discounts: the operator marks the qualifying lines (defaults to all) and a modal captures the ID number and name. Math per project-spec §7: VAT off first, then 20% — and a line takes SC/PWD **or** a promo discount, whichever is higher, never both.
- **Service charge** — auto-applied as its own line on dine-in orders when the business rate is nonzero.
- Totals: subtotal − discounts + service charge = **total**. Prices are **VAT-inclusive**; the included VAT and any VAT-exempt (SC/PWD) portion are computed per project-spec §7 for receipt display. Exact BIR receipt wording remains an open item (project-spec §14).
- Hold & resume: park the current cart under a label and resume it from the held list; holds persist locally across restarts but **live within the current shift** — at shift close, remaining held carts must be completed or discarded.
- Clearing the cart requires a confirm.

## 5. Payment

One payment method per sale in MVP (split payments: later phase).

- Methods: cash, card, gcash, maya, other. Non-cash methods are recorded types only — no processing — with an **optional reference number** (e.g. the GCash ref) that prints on the receipt and appears in reports and CSV exports for reconciliation.
- **No pay-later:** every sale settles at the counter. Utang stays on the paper listahan until the customers phase ships charge-to-account properly.
- Cash: tendered-amount input with quick buttons (exact, 100, 200, 500, 1000) and computed change.
- Completing a sale: write `sales` + `sale_items` + `sale_payments` with client UUIDs, assign `receipt_no`, record `stock_movements(sale)`, then show the Receipt screen; **Done** returns to a fresh sale. One API call in the online phase; becomes local-write-then-queue when the offline layer lands.
- **Stock race:** if another terminal took the last unit first, completion fails cleanly with the offending line highlighted — adjust or remove and retry. A sale never half-commits.

## 6. Receipts

58/80mm print stylesheet (width chosen in Settings), printed through the browser print dialog. **Printing is optional per sale:** the Receipt screen offers **Print** and **Done**; reprint from Sale Detail covers the customer who changes their mind at the door (reprints are stamped `REPRINT`). Issuing receipts is the business's BIR obligation — the system makes it one tap; skipping is the operator's call. The business TIN and address live in the freeform `receipt_header` until the BIR phase adds structured fields.

Receipts carry the **business's branding only — never Sentry's**. Layout top to bottom: business name + logo + `receipt_header` → branch/terminal code, receipt number, date-time → lines (`name_snapshot`, qty × unit price, line total, modifiers indented) → discounts → SC/PWD line with printed ID number (when applied) → service charge (when applied) → **TOTAL** → payment method, tendered, change → VAT breakdown (VATable amount, VAT-exempt sales, included VAT from `tax_rate`) → `receipt_footer`. Receipts carry the business's branding only — no Sentry branding appears on any customer-facing output.

## 7. Sales History, Void & Refund

- History: local + synced sales for this terminal, newest first, with a today/date filter and a detail view with reprint.
- **Void** — mistake control **while its shift is open**, ungated: a required short reason is captured, sale marked `voided`, stock returned via `stock_movements(void)`, excluded from totals, kept in history and counted on the Z report.
- **Refund** — allowed **anytime**, shift open or not, but always behind the **PIN gate**: the BO's personal PIN (set in the portal) in MVP; manager PINs join automatically in the staff phase. Once a sale's shift has closed, reversal is always a refund. Full amount only; a required short reason is captured, sale marked `refunded`, stock returned via `stock_movements(refund)`. An in-shift refund hits that shift's expected cash; an out-of-shift refund carries `shift_id = null`, skips shift math, and appears as its own "refunds outside shift" line in daily reports.
- Statuses are terminal — a voided sale can't then be refunded, nor the reverse. Partial or line-level refunds are a later phase. Every void, refund, and PIN approval lands in the activity log.

## 8. Shift & Cash

- A shift must be open to sell. Opening a shift means entering the opening float.
- Cash in / cash out entries with a reason note.
- Closing: enter counted cash. Expected = opening + cash sales − in-shift cash refunds + cash in − cash out; over/short is shown, not blocked — expect small centavo noise from exact-centavo cash handling. Held carts must be completed or discarded before close.
- The Shift screen shows running totals at any time — a de facto X reading.
- Shifts never auto-close (money gets counted by humans); a banner nags once the business-day boundary passes with the shift still open.
- **Z report** on close, printable: totals by payment method, sale count, void/refund counts, SC/PWD discounts, service charge, cash summary. One open shift per terminal; shifts are terminal-scoped (no staff attribution in MVP).

## 9. Stock

- Branch stock levels from the local cache, with a low-stock badge at each product's `low_stock_threshold`.
- **Stock never goes negative:** tracked products at zero are blocked from sale (`qty >= 0` is a database constraint). Auto-decrement on sale, auto-return on void/refund. Weight products track decimal stock (`numeric(10,3)`) under the same rules.
- Quick adjustments are allowed from the terminal — a typed reason category (damage, expiry, theft/loss, count correction, other) plus an optional note, posted as an append-only `stock_movements(adjustment)` event, audit-logged with who and why. This is the designed escape hatch for "the item is in the customer's hand but the count says zero." Catalog editing, **branch transfers**, receiving, and **stock-take counts** stay portal-only — and expiry/batch tracking never touches the terminal: selling deducts from branch totals while batch remainders are FEFO-derived server-side.

## 10. Sync & Status

A persistent status strip shows connection state, the open-shift indicator, branch/terminal code, and a DEMO badge when paired to the demo business. The pending-event count, last-sync time, auto-sync, and manual "Sync now" arrive with the offline phase (project-spec §5) — until then the terminal talks to the API synchronously.

## 11. Settings

Paper width (58/80) with test print · receipt preview · sync diagnostics · re-pair/unpair (*online-only*, BO re-auth) · app version. The refund PIN is managed in the BO portal, not on the terminal.

## 12. Explicit Non-Goals (MVP)

Staff accounts and staff PIN unlock (the BO's refund PIN is the only PIN) · split payments · partial or line-level refunds · per-sale order notes · utang / pay-later · delivery order type · idle/screen lock · customer records and loyalty · tables and kitchen routing · per-branch price overrides · payment processor integrations · scale hardware integration · SC/PWD group allocation · non-VAT receipt mode · any catalog editing on the terminal.
