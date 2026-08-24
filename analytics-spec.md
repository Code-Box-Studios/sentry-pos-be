# Sentry — Analytics Spec

**Surface:** BO portal (manager-scoped variant in the staff phase) · **Updated:** 2026-08-18

Companion to `project-spec.md`. One dedicated portal section named **Analytics** holds every report and graph. Every view respects the business's `day_start_time`, exports to CSV, and is logged as a sensitive read (project-spec §11).

## 0. Dashboard — the Portal Landing

The answer to "is everything okay?" in zero clicks. The one view spanning **all** the BO's businesses at once (demo excluded), it ignores the business switcher:

- **Per-business card:** today's sales, gross profit, transactions — each versus the same day last week — with per-branch rows and a 7-day sparkline.
- **Live strip:** open shifts (branch + opened time), terminal last-seen status, unread notifications.
- **Attention items:** low-stock count, unclosed-shift warnings.
- Every card and item taps through to the matching Analytics tab, pre-filtered to that business/branch.
- Staff-phase variant: managers land on the same dashboard scoped to their branches, with all profit numbers absent.

Everything below is the investigation space the dashboard links into.

## Scope Selector

Every tab shares one selector: all businesses → business → branch, plus a date range with presets (today, yesterday, 7 days, 30 days, this month, custom). Demo businesses are excluded from all rollups.

## 1. Overview

KPI cards with change versus the previous equal period: gross sales, discounts given, net sales, gross profit and margin % (shown as "—" where costs are unset), transactions, average basket, void and refund counts, service charge collected.

## 2. Sales

- **Calendar heatmap** — a month grid with each day shaded by sales volume; tapping a day opens its breakdown. The at-a-glance "which days feed us" view.
- **Trend** — sales and profit over time (day / week / month), plus hour-of-day and day-of-week patterns for spotting peaks and dead hours.
- **Breakdowns** — by payment method, by order type, and branches side-by-side.

## 3. Products (Sold)

- Top sellers by **units** and by **revenue**, with category rollups.
- **Slow movers** — bottom sellers and products with zero sales in the selected range: the restock-or-retire list.
- Per-product drill-down: units, revenue, and margin trend over time.

## 4. Profit & Leaks — BO-only

- Gross profit over time; margin by product and category (null cost reads *unknown*, never zero).
- **The leaks view:** discount cost by named discount, SC/PWD totals and VAT-exempt sales, misc lines as a % of sales (per-cashier once staff exist), void and refund value **with their reasons ranked**, and over/short history by shift.

## 5. Inventory Movements

- The full movement ledger, filterable by type (sale, void, refund, adjustment, receive, transfer), product, branch, and date — every adjustment carrying its who and why straight from the audit trail.
- **Expiring soon:** batches inside the warning window, with quantity and days left — the act-before-it's-trash list.
- **Shrinkage by category:** adjustment losses split by damage, expiry, theft/loss, and count corrections, valued at cost.
- **Stock-take history:** past count sessions with their variance reports.
- Current stock on hand per branch with valuation (`qty × cost` where cost is set), the low-stock list, and a **days-of-stock estimate** per product (`qty ÷ trailing average daily units sold`) — "runs out Thursday," not just "low now."
- Transfer history between branches.

## 6. Tax Summary

The accountant's view: per selected period — VATable sales, VAT amount, VAT-exempt (SC/PWD) sales, SC/PWD discounts granted, service charge collected. One click, one CSV, ready for filing. (BIR-accredited formats remain the later-phase item; this is the working summary until then.)

## Staff-Phase Variant

Managers get Analytics scoped to their assigned branches: everything above **except** the Profit & Leaks tab and every margin/cost column — revenue yes, margin never (staff-spec §6). Per-cashier columns appear throughout for managers and the BO alike.

## Engineering Notes

Milestone 3. Straight SQL over the indexed tables is enough at pilot scale — `sales`, `sale_items`, `sale_payments`, and `stock_movements` are already shaped for these queries; materialized rollups are a later optimization, not a launch requirement. Charts render client-side in the portal; no additional services. Fully responsive: the calendar heatmap compresses on phones, tables scroll or reflow into cards, and chart layouts stack on small screens.
