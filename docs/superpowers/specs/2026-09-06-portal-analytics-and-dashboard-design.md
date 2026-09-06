# Portal Analytics & Dashboard — Design

**Repo:** `sentry-pos-be` · **Date:** 2026-09-06 · **Milestone:** 3 (partial)

Implements `analytics-spec.md` §0–§6 as read-only API endpoints, plus one
catalog read that the portal is currently missing. Companion specs:
`project-spec.md` (§7 money & time, §9 API surface, §11 activity logging) and
`analytics-spec.md` (the report catalogue this builds).

## Goal

Give the BO portal the numbers it has no source for today: the dashboard
landing, six report groups, and CSV export of each. Read-only, no schema
migrations, no change to any POS write path.

## Why now, and what this is not

The portal shipped its operational surfaces on 2026-09-06 (catalog, discounts,
settings, branches, stock, terminals, activity log). Every remaining gap needs
backend work that does not exist. This spec covers the largest of them.

Three sibling sub-projects are deliberately **not** in scope, and are named here
so the boundaries are explicit:

- **B — Inventory completion:** branch transfers, stock-take mode, expiry
  batches, low-stock and expiring-soon notifications, daily summary emails.
- **C — Staff accounts & roles:** `staff-spec.md` in full.
- **D — Product images:** needs an object-storage decision (Render's disk is
  ephemeral); unrelated to reporting.

## What is already true

Facts established by reading the schema and the existing services. The design
depends on all of them.

| Fact | Where | Consequence |
|---|---|---|
| `SaleItem.costSnapshot` is nullable, frozen at sale time | `schema.prisma:612` | Margin is computable historically; a null must never read as zero |
| `Sale` carries `subtotal`, `discount`, `scPwdDiscount`, `serviceCharge`, `vatExemptSales`, `tax`, `total` | `schema.prisma:571` | §1, §4 and §6 need no joins to `sale_items` |
| `SaleItem.productId` is nullable for misc/open-price lines | `schema.prisma:612` | "Misc as % of sales" is `productId IS NULL` |
| `Business.dayStartTime` exists, default `00:00`, and **nothing reads it yet** | `schema.prisma:205` | Analytics is its first consumer |
| `Business.isDemo` | `schema.prisma:205` | Excluded from every rollup |
| `saleItem` is a `CHILD_ONLY` model — no top-level access through the scoped client | `model-scope-map.ts:60` | Product-level reports cannot use Prisma `groupBy` |
| The tenancy extension hooks `$allModels` only | `scoped-prisma.ts:737` | **`$queryRaw` bypasses the choke point entirely** |
| `AuditService.logPortal(action, entityType, entityId, businessId, meta)` | `audit.service.ts:127` | The existing hook for sensitive reads |
| `stock_batches` has **no `branch_id`** | `schema.prisma:551`, `stock.service.ts:59` | Expiring-soon cannot be per-branch — deferred to B |
| `stock_counts` and `notifications` are never written by any code path | verified by grep | Stock-take history and the notification count have no data yet |

### Totals semantics, fixed by the engine

From `src/common/totals/totals.ts` and `sales.service.ts:508`, so the report
definitions below are exact rather than approximate:

- `sales.subtotal` = Σ line gross, **before** any discount.
- `sales.discount` = line promos **plus the order-level discount**.
- `sales.scPwdDiscount` = Σ applied SC/PWD amounts.
- `sale_items.discount` = the amount applied to that line (promo **or** SC/PWD,
  never both — higher wins, ties to SC/PWD).
- `sales.total` = subtotal − discount − scPwdDiscount + serviceCharge.

**The order-level discount is not attributable to any line.** So
`Σ sale_items.discount` ≠ `sales.discount + sales.scPwdDiscount`; the difference
is exactly the order discount. Per-product profit therefore uses line-level
figures only, and the order discount is reported as its own unattributed bucket
in the Leaks view (§4). Stating this here prevents a per-product margin report
that silently fails to add up to the business total.

## Architecture

### 1. One scope resolver

Every report answers the same two questions: which branches, and what window.
`AnalyticsScopeService.resolve(dto)` turns the shared query DTO into:

```ts
interface ResolvedScope {
  businesses: { id: string; name: string; dayStartTime: string; taxRate: number }[];
  branchIds: string[];       // never empty — an empty result throws NotFound
  fromUtc: Date;             // inclusive
  toUtc: Date;               // exclusive
  dayCount: number;
  previous: { fromUtc: Date; toUtc: Date };  // the equal period immediately before
}
```

It resolves ids **through the scoped Prisma client** (`scoped.business`,
`scoped.branch`), so the tenant choke point — not this service — decides what
the caller may see. A `businessId` the caller does not own resolves to zero
businesses and raises `NotFoundError`, matching `assertBusinessOwned`'s
no-existence-leak behaviour. Demo businesses are dropped unless the caller asked
for one by id.

### 2. Raw SQL, and the one rule that makes it safe

Prisma cannot express these reports: `sale_items` has no top-level access by
design, and `groupBy` offers no date bucketing, no joins, and no conditional
aggregates. The report queries are therefore hand-written SQL.

That means they bypass the tenancy choke point, because the extension hooks
`$allModels` and raw queries are not model operations. The mitigation is a
single helper that makes the safe path the only path:

```ts
// analytics/scoped-sql.ts
export async function runScoped<T>(
  raw: PrismaService,
  scope: ResolvedScope,
  build: (branchIds: string[]) => Prisma.Sql,
): Promise<T[]>
```

`build` receives the branch-id list and must interpolate it; `runScoped` refuses
to execute when `scope.branchIds` is empty. Every analytics query goes through
it. No analytics SQL names `sales`, `sale_items`, `stock_movements` or
`branch_stock` without a `branch_id IN (...)` predicate bound from a list the
choke point produced.

This is enforced by tests, not by convention alone: a tenancy e2e spec calls
**every** report endpoint as owner B with owner A's `businessId` and asserts 404,
and again with a valid scope while owner A's data exists, asserting none of A's
rows appear.

### 3. Business-day bucketing

`dayStartTime` has sat unread on `Business` since the schema was written. A
business day is `[date + dayStartTime, nextDate + dayStartTime)` in
Asia/Manila, converted to UTC for the query. A 2 AM café with `04:00` puts a
3 AM sale on the previous calendar date, which is the whole point of the field.

**Two businesses with different day starts cannot share a bucket.** So an
all-businesses rollup buckets per business and sums the buckets — never one
global `date_trunc` over the union. The bucketing helper is a pure module
(`analytics/business-day.ts`) with its own unit tests, including the café case
and a DST-free sanity check (Asia/Manila has no DST, which is why fixed-offset
arithmetic is safe here and is written down as the reason).

### 4. Module layout

`src/portal/analytics/`, one small service per spec tab over a folder of pure
SQL builders:

```
analytics/
  analytics.module.ts
  scope/analytics-scope.service.ts     ResolvedScope
  scope/business-day.ts                pure bucketing
  scoped-sql.ts                        runScoped()
  csv.ts                               toCsv()
  dto/analytics-query.dto.ts           shared query DTO
  dashboard/dashboard.controller.ts    §0
  dashboard/dashboard.service.ts
  overview/overview.controller.ts      §1
  overview/overview.service.ts
  sales/sales-report.controller.ts     §2
  sales/sales-report.service.ts
  products/products-report.controller.ts   §3
  products/products-report.service.ts
  profit/profit-report.controller.ts   §4
  profit/profit-report.service.ts
  inventory/inventory-report.controller.ts §5
  inventory/inventory-report.service.ts
  tax/tax-report.controller.ts         §6
  tax/tax-report.service.ts
  reports/*.sql.ts                     pure Prisma.Sql builders
```

SQL builders are pure functions returning `Prisma.Sql`, so they are unit-testable
without a database and the services stay small enough to hold in context.

### 5. CSV

`?format=csv` on every report endpoint, served by a shared `toCsv()` over **the
same object the JSON response returns**. One code path, so an export can never
drift from what is on screen. Responses set
`Content-Type: text/csv; charset=utf-8` and
`Content-Disposition: attachment; filename="<report>-<from>-<to>.csv"`.

`toCsv()` rules: RFC 4180 quoting (double quotes doubled, fields containing
`,` `"` CR or LF quoted), a leading BOM so Excel opens UTF-8 correctly, `null`
rendered as an empty field, and money emitted as **pesos with two decimals**
(`1250.00`) rather than centavos — a CSV goes to an accountant, not a parser.
Nested report objects are flattened one section per CSV, with the section name
as a first column when a report has several.

### 6. Money and the null-cost rule

Integer centavos throughout; SQL aggregates cast to `bigint` per §7 and convert
at the edge. Response fields carrying money are suffixed `C` and are integers.

**A null cost is `null`, never `0`.** A zero would report 100% margin on every
uncosted product — the single most damaging silent error available here. The
rules, which get their own tests:

- **Per-product / per-category margin:** `null` when `cost_snapshot` is null.
- **Aggregate gross profit:** computed over costed items only, and always
  returned beside `costedRevenueC` and `uncostedRevenueC` so the portal can say
  which share of sales the profit figure covers. When no item in the range is
  costed, `grossProfitC` and `marginPct` are both `null`.
- **Stock valuation:** items with no cost contribute nothing to the value and
  are counted in `uncostedItems`, never valued at zero.

`Decimal` quantities convert with `.toNumber()`, matching the existing services.

### 7. Sensitive reads

Every report read appends `audit.report_read`; every CSV export appends
`audit.report_export`. Both go through the existing
`AuditService.logPortal(action, 'report', null, businessId, { report, from, to })`,
exactly as the activity log does today. An all-businesses read logs one row per
business in scope, so a per-business activity log shows it.

## Endpoints

All under `/v1/portal`, all gated by `PortalAuthGuard`, all `GET`.

### Shared query DTO

```ts
class AnalyticsQueryDto {
  businessId?: string;   // uuid; omit for all non-demo businesses
  branchId?: string;     // uuid; 422 unless businessId is also given
  from: string;          // YYYY-MM-DD, business-day, inclusive — required
  to: string;            // YYYY-MM-DD, business-day, inclusive — required
  format?: 'json' | 'csv';   // default json
}
```

Range presets (today / yesterday / 7 days / 30 days / this month) resolve **in
the portal**, not the API: the API takes explicit dates only, which keeps it
testable and keeps "what is today" a single question answered against the
business day. `to` before `from` is a 422; a range longer than 366 days is a 422.

### §0 Dashboard — `GET /dashboard`

Takes no scope parameters: it spans every non-demo business the caller owns and
ignores the business switcher, by design (`analytics-spec.md` §0).

```ts
{
  businesses: [{
    businessId, name,
    today:            { salesC, grossProfitC | null, transactions },
    sameDayLastWeek:  { salesC, grossProfitC | null, transactions },
    branches: [{ branchId, name, salesC, grossProfitC | null, transactions }],
    sparkline: [{ date, salesC }]        // 7 business-days ending today
  }],
  live: {
    openShifts: [{ shiftId, businessId, branchId, branchName, terminalName, openedAt }],
    terminals:  [{ terminalId, businessId, branchId, name, code, lastSeenAt, paired }],
    unreadNotifications: number
  },
  attention: {
    lowStock:        [{ businessId, count }],
    unclosedShifts:  [{ businessId, count }]
  }
}
```

- `today` and `sameDayLastWeek` are business-days, per business.
- `lowStock` counts `branch_stock` rows at or below the product's
  `lowStockThreshold` where the threshold is set. It reads `branch_stock`
  directly rather than the (empty) `notifications` table, so it works today.
- `unclosedShifts` counts shifts open longer than **24 hours**. The spec does not
  fix a threshold; 24h is chosen because a shift is drawer-bound to one calendar
  day of trading and anything longer is an operator error worth surfacing.
- `unreadNotifications` counts `notifications` where `read_at IS NULL`. Nothing
  writes that table until sub-project B, so it truthfully returns `0` today and
  begins working with no API change once B lands. The field is present now
  because the portal's live strip renders it.

### §1 Overview — `GET /analytics/overview`

Every KPI as `{ value, previous, changePct }`, where `previous` covers the equal
period immediately preceding `from` and `changePct` is `null` when `previous` is
zero (no "∞% up" from a standing start).

| Field | Definition |
|---|---|
| `grossSalesC` | Σ `sales.subtotal` |
| `discountsC` | Σ (`sales.discount` + `sales.sc_pwd_discount`) |
| `netSalesC` | `grossSalesC − discountsC` — **excludes** service charge, which is its own KPI |
| `grossProfitC` | costed-item revenue − costed-item cost; `null` if nothing is costed |
| `marginPct` | `grossProfitC ÷ costedRevenueC`; `null` when `grossProfitC` is |
| `transactions` | count of sales with `status = 'completed'` |
| `averageBasketC` | `netSalesC ÷ transactions`; `null` when there are no transactions |
| `voidCount` | count of sales with `status = 'voided'` |
| `refundCount` | count of sales with `status = 'refunded'` |
| `serviceChargeC` | Σ `sales.service_charge` |

Voided sales are excluded from every money figure and from `transactions`;
refunded sales are excluded from money figures but their count is reported.
This exclusion rule is stated once here and applies to §2, §3, §4 and §6.

### §2 Sales

- `GET /analytics/sales/heatmap` → `[{ date, salesC, transactions }]`, one row
  per business-day across the range, including days with no sales (zero-filled,
  so the calendar grid has no holes).
- `GET /analytics/sales/trend?granularity=day|week|month` →
  `[{ bucket, salesC, grossProfitC | null, transactions }]`. Weeks start Monday.
- `GET /analytics/sales/patterns` →
  `{ hourOfDay: [{ hour, salesC, transactions }], dayOfWeek: [{ dayOfWeek, salesC, transactions }] }`,
  hours 0–23 and days 0–6 always present, zero-filled. Hour-of-day uses the
  wall clock in Asia/Manila, not the business-day offset — a peak at 3 PM must
  read as 3 PM regardless of `dayStartTime`.
- `GET /analytics/sales/breakdowns` →
  `{ byPaymentMethod: [{ method, salesC, transactions }], byOrderType: [{ orderType, salesC, transactions }], byBranch: [{ branchId, name, salesC, transactions }] }`.
  Payment breakdown sums `sale_payments.amount` (a sale has one method in MVP,
  but the table is the honest source).

### §3 Products (sold)

- `GET /analytics/products/top?by=units|revenue&limit=20` →
  `{ rows: [{ productId, variantId, name, units, revenueC, grossProfitC | null }], categories: [{ categoryId, name, units, revenueC }] }`.
  Named from `sale_items.name_snapshot` when the product is gone, which is what
  the snapshot is for.
- `GET /analytics/products/slow?limit=20` →
  `{ bottom: [...same row shape...], zeroSales: [{ productId, name, categoryName }] }`.
  `zeroSales` lists active, non-deleted products of the scoped businesses with
  no `sale_items` row in the range — the restock-or-retire list.
- `GET /analytics/products/:productId/trend?granularity=day|week|month` →
  `[{ bucket, units, revenueC, grossProfitC | null, marginPct | null }]`.

`limit` is 1–100, default 20.

### §4 Profit & leaks

- `GET /analytics/profit` →
  ```ts
  {
    overTime: [{ bucket, grossProfitC | null, marginPct | null }],
    byProduct:  [{ productId, name, revenueC, costC | null, grossProfitC | null, marginPct | null }],
    byCategory: [{ categoryId, name, revenueC, costC | null, grossProfitC | null, marginPct | null }],
    costedRevenueC, uncostedRevenueC
  }
  ```
- `GET /analytics/leaks` →
  ```ts
  {
    discountsByName: [{ discountId, name, kind, timesUsed, amountC }],
    orderLevelDiscountC,          // the unattributed remainder — see Totals semantics
    scPwd: { discountC, vatExemptSalesC, saleCount },
    miscLines: { revenueC, pctOfNetSales },
    voids:   { count, valueC, reasons: [{ reason, count, valueC }] },
    refunds: { count, valueC, reasons: [{ reason, count, valueC }] },
    overShort: [{ shiftId, branchId, branchName, closedAt, expectedCashC, closingCashC, varianceC }]
  }
  ```
  Void and refund reasons come from `sales.status_reason`, ranked by value
  descending. `overShort` covers closed shifts only (`closed_at IS NOT NULL`)
  and reports `variance = closingCash − expectedCash`, so negative is short.

### §5 Inventory movements

- `GET /analytics/inventory/movements` — the ledger, **paginated**
  (`Paginated<T>`, page/pageSize, default 50, max 200). Extra filters: `type`
  (a `MovementType`), `productId`. Rows carry
  `{ id, createdAt, branchId, branchName, productId, variantId, productName, variantName, type, qtyDelta, reasonCategory, unitCostC, note }`.
  The "who and why" the spec asks for comes from `audit_logs`, joined on the
  movement id as `entity_id` and surfaced as `{ actorType, actorId, action }`
  when a matching row exists, `null` when it does not.
- `GET /analytics/inventory/shrinkage` →
  `[{ reasonCategory, units, valueC | null, uncostedUnits }]` — adjustment losses
  (negative `qty_delta`, `type = 'adjustment'`) split by reason, valued at the
  product's current cost, with uncosted units counted rather than valued.
- `GET /analytics/inventory/on-hand` →
  `[{ branchId, branchName, productId, variantId, name, qty, unitCostC | null, valueC | null, lowStockThreshold | null, isLow, daysOfStock | null }]`
  plus a `totals: { valueC, uncostedItems }` footer.
  `daysOfStock = qty ÷ (units sold in range ÷ dayCount)`, and is `null` when the
  product had no sales in the range — an infinite figure is not a number the
  portal can render, and "—" is the honest answer.

Three items from `analytics-spec.md` §5 are **deferred to sub-project B**, each
because the feature that produces the data does not exist yet:

| Deferred | Reason |
|---|---|
| Expiring soon | `stock_batches` has no `branch_id` (`stock.service.ts:59`), so batches cannot be attributed to a branch. B adds the column and backfills, alongside the expiring-soon notification that reads it. `model-scope-map.ts:47` also claims `stockBatch: 'branchId'`, which would fail on any top-level scoped query — B fixes both together. |
| Stock-take history | Nothing writes `stock_counts`; stock-take mode is a B feature. |
| Transfer history | Nothing writes `transfer_out`/`transfer_in` movements; branch transfers are a B feature. |

### §6 Tax summary — `GET /analytics/tax`

```ts
{ vatableSalesC, vatC, vatExemptSalesC, scPwdDiscountC, serviceChargeC, taxRate }
```

`vatableSalesC = Σ(total − vat_exempt_sales − tax)`, `vatC = Σ tax`, matching the
engine's `vatableSalesC` exactly so a receipt and the report agree to the
centavo. `taxRate` is echoed per business; an all-businesses scope returns a row
per business rather than one blended rate, because blending tax rates produces a
number that is true of nothing.

### Catalog gap — `GET /portal/products/:id`

Adds `modifierGroupIds: string[]` to the existing response by including
`productModifierGroups` (a `CHILD_ONLY` model, legitimately reached through its
scoped parent). This removes the on-screen warning the portal's modifier-links
editor carries today, which exists solely because there was no way to read the
current selection.

## Error handling

Uses the established `api-errors` classes and the existing exception filter.

| Case | Response |
|---|---|
| `branchId` without `businessId` | 422 `validation` |
| `to` < `from`, or range > 366 days | 422 `validation` |
| Malformed date, bad `granularity`/`by`/`format`/`type` | 422 `validation` |
| `businessId` or `branchId` not owned, or soft-deleted | 404 `not_found` — no existence leak |
| Owner suspended | handled upstream by `PortalAuthGuard`, unchanged |

An empty result is a 200 with empty arrays and zeroed totals, never a 404. A
report with no data is a legitimate answer.

## Testing

Following the existing `test/*.e2e-spec.ts` conventions and the seeded demo data.

**Unit (Jest, no database):**
- `business-day.spec.ts` — midnight default, the `04:00` café case, range
  expansion, week/month bucket edges.
- `csv.spec.ts` — quoting, embedded commas/quotes/newlines, BOM, null as empty,
  centavos rendered as pesos.
- `reports/*.sql.spec.ts` — each builder emits the branch-id predicate.

**e2e, per tab:** `portal-analytics-dashboard`, `-overview`, `-sales`,
`-products`, `-profit`, `-inventory`, `-tax`. Each asserts real figures against
seeded sales rather than only shape.

**Three specs that carry the weight of this design:**

1. `portal-analytics-tenancy.e2e-spec.ts` — every endpoint, called by owner B
   with owner A's `businessId` (404) and with B's own scope while A has data
   (none of A's rows appear). This is what keeps raw SQL honest.
2. `portal-analytics-null-cost.e2e-spec.ts` — a product with no cost sells;
   margin reads `null`, never `0`, in overview, profit, products and valuation;
   `uncostedRevenueC` accounts for it.
3. `portal-analytics-business-day.e2e-spec.ts` — a sale at 03:00 against a
   business with `dayStartTime = '04:00'` lands on the previous business day,
   and two businesses with different day starts roll up without cross-bucketing.

Also: an audit spec asserting `audit.report_read` and `audit.report_export` rows
appear in the business's own activity log.

## Implementation order

One spec, two plans, so each ships something working:

1. **Money reports** — scope resolver, `runScoped`, business-day helper, CSV,
   dashboard (§0), overview (§1), sales (§2), tax (§6), and the catalog gap.
2. **Product, profit and inventory reports** — §3, §4, §5, reusing all of the
   above unchanged.

The split is at a real seam: plan 1 builds every shared mechanism and proves it
against four report groups; plan 2 adds three more that introduce no new
infrastructure.
