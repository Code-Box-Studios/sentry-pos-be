# Analytics Product, Profit & Inventory Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the analytics API with §3 products sold, §4 profit & leaks, and §5 inventory movements — the investigation space the dashboard links into.

**Architecture:** Adds three report families on the foundation plan 1 already shipped (`AnalyticsScopeService`, `runScoped`, `renderReport`, `ReportAuditService`, the CSV writer). No new infrastructure, no migrations, no change to any write path.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest unit (`rootDir: src`) + Jest e2e (`test/*.e2e-spec.ts`, real Postgres), supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-portal-analytics-and-dashboard-design.md` §3, §4, §5. Plan 2 of 2; plan 1 (`2026-09-06-analytics-money-reports.md`) is complete and committed.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Integer centavos everywhere.** SQL aggregates cast to `::bigint`, converted with `Number(...)` at the edge. Money fields are suffixed `C`.
- **A null cost is `null`, never `0`.** A zero would report 100% margin on an uncosted product. Every margin, profit and valuation figure in this plan returns `null` when the underlying cost is unknown, and reports the uncosted volume alongside.
- **Line money comes from the shared fragment, never hand-rolled.** `sale_items.unit_price` is the BASE price; priced modifiers live in the `modifiers` jsonb with their own `priceDeltaC` (`sales.service.ts:507`, `cart.ts:49`). Task 1 extracts the existing lateral joins into `reports/line-money.sql.ts`; every query in this plan uses them. `qty * unit_price` alone is always wrong.
- **`cost_snapshot` is a UNIT cost** (`sales.service.ts:664`) — line cost is `round(si.qty * si.cost_snapshot)`.
- **Every analytics query runs per business** and merges in TypeScript, because `dayStartTime` differs per business.
- **Every analytics SQL query goes through `runScoped()` / `runScopedOne()`** and must contain `branch_id` — the helper refuses SQL without it, because `$queryRaw` bypasses the tenancy choke point entirely.
- **Voided sales contribute to no money figure and no transaction count; refunded sales contribute to no money figure but are counted.** The §4 leaks report is the one place their values are deliberately surfaced, as leaks.
- **Validation failures are 422 `validation`**; a named id that isn't the caller's is 404 `not_found`. An owned business with no branches yields a 200 with empty/zero results.
- **Routes** are `@Controller('portal')` + `@UseGuards(PortalAuthGuard)` under the `v1` global prefix.
- **Sensitive reads** append `audit.report_read`; CSV exports append `audit.report_export`, via `ReportAuditService.log(scope, name, format)`.
- **Never add a Claude co-author trailer to a commit. Never run `git push`.** Commit directly on `main`.

**Commands:** `npm test` (unit), `npm run test:e2e` (needs `docker compose up -d db`), `npm run lint`, `npm run build`.

---

## What plan 1 already provides

Exact signatures, so no task guesses at them.

| Symbol | Module | Shape |
|---|---|---|
| `ScopedBusiness` | `scope/analytics-scope.service` | `{ id, name, dayStartTime, dayStartMinutes, taxRate, branchIds, fromUtc, toUtc, previousFromUtc, previousToUtc }` |
| `ResolvedScope` | same | `{ businesses: ScopedBusiness[], branchIds, from, to, dayCount }` |
| `AnalyticsScopeService.resolve(query)` | same | `Promise<ResolvedScope>` |
| `runScoped<T>(raw, business, build)` | `scoped-sql` | `Promise<T[]>` — refuses empty `branchIds` or SQL lacking `branch_id` |
| `runScopedOne<T>(raw, business, build)` | same | `Promise<T>` — throws unless exactly one row |
| `renderReport<T>(res, name, query, data, toSections)` | `report-response` | `T \| string`; `query` is `ReportRange = { from, to, format? }` |
| `CsvSection` | `csv` | `{ title?, columns: string[], rows: (string \| number \| null)[][] }` |
| `centavosToPesos(c: number \| null)` | `csv` | `string` — `null` → `''` |
| `toCsv(sections)` | `csv` | `string` |
| `ReportAuditService.log(scope, report, format)` | `report-audit.service` | `Promise<void>` |
| `AnalyticsQueryDto` | `dto/analytics-query.dto` | `{ businessId?, branchId?, from, to, format? }` |
| `dayBucketExpr(business)` | `reports/sales-series.sql` | `Prisma.Sql` — `(created_at + offset)::date` |
| `Granularity` | same | `'day' \| 'week' \| 'month'` |
| `salesAggregateSql` / `lineAggregateSql` | `reports/sales-aggregate.sql` | window aggregates |
| `seedSale(raw, options)` | `test/helpers/sales` | `SeedLine` supports `productId`, `variantId`, `costC`, `modifiers`, `discount` |
| `seedBranchInfra(raw, branchId)` | same | `{ terminalId }` |

`Paginated<T>` lives at `src/common/types/pagination.ts`: `{ data, page, pageSize, total, totalPages }`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/portal/analytics/reports/line-money.sql.ts` | The modifier-aware line-money joins, extracted so the rule lives in one place. |
| `src/portal/analytics/reports/product-sales.sql.ts` | Top/slow/zero-sales/per-product/per-category SQL. |
| `src/portal/analytics/reports/leaks.sql.ts` | Discounts, SC/PWD, misc, voids, refunds, over/short SQL. |
| `src/portal/analytics/reports/inventory.sql.ts` | Movements ledger, shrinkage, on-hand SQL. |
| `src/portal/analytics/margin.ts` | `marginOf()` — the one costed/uncosted → profit+margin rule. |
| `src/portal/analytics/margin.spec.ts` | Unit tests for the null-cost rule. |
| `src/portal/analytics/dto/product-report-query.dto.ts` | `by`, `limit`. |
| `src/portal/analytics/dto/product-trend-query.dto.ts` | `granularity`. |
| `src/portal/analytics/dto/movements-query.dto.ts` | `type`, `productId`, `page`, `pageSize`. |
| `src/portal/analytics/products/products-report.service.ts` | §3 computation. |
| `src/portal/analytics/products/products-report.controller.ts` | §3 routes. |
| `src/portal/analytics/products/products-report.csv.ts` | §3 CSV sections. |
| `src/portal/analytics/profit/profit-report.service.ts` | §4 computation. |
| `src/portal/analytics/profit/profit-report.controller.ts` | §4 routes. |
| `src/portal/analytics/profit/profit-report.csv.ts` | §4 CSV sections. |
| `src/portal/analytics/inventory/inventory-report.service.ts` | §5 computation. |
| `src/portal/analytics/inventory/inventory-report.controller.ts` | §5 routes. |
| `src/portal/analytics/inventory/inventory-report.csv.ts` | §5 CSV sections. |
| `test/helpers/catalog.ts` | `seedCatalog()` — categories, products, variants, stock for the report suites. |
| `test/portal-analytics-products.e2e-spec.ts` | §3. |
| `test/portal-analytics-profit.e2e-spec.ts` | §4. |
| `test/portal-analytics-inventory.e2e-spec.ts` | §5. |

**Modified:**

| File | Change |
|---|---|
| `src/portal/analytics/reports/sales-aggregate.sql.ts` | Use the extracted `LINE_MONEY_JOINS`. |
| `src/portal/analytics/analytics.module.ts` | Register three controllers and three services. |
| `test/portal-analytics-tenancy.e2e-spec.ts` | Add the eight new endpoints to `ENDPOINTS`. |

---

## Task 1: Shared line-money fragment, the margin rule, and top sellers (§3)

The modifier-aware line arithmetic currently lives inline in `lineAggregateSql`. Every query in this plan needs it, so it gets extracted first — one definition of the trap, not seven.

**Files:**
- Create: `src/portal/analytics/reports/line-money.sql.ts`
- Modify: `src/portal/analytics/reports/sales-aggregate.sql.ts`
- Create: `src/portal/analytics/margin.ts`
- Test: `src/portal/analytics/margin.spec.ts`
- Create: `src/portal/analytics/reports/product-sales.sql.ts`
- Create: `src/portal/analytics/dto/product-report-query.dto.ts`
- Create: `src/portal/analytics/products/products-report.service.ts`
- Create: `src/portal/analytics/products/products-report.controller.ts`
- Create: `src/portal/analytics/products/products-report.csv.ts`
- Create: `test/helpers/catalog.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-products.e2e-spec.ts`

**Interfaces:**
- Consumes: everything in "What plan 1 already provides".
- Produces:
  - `LINE_MONEY_JOINS: Prisma.Sql`, `LINE_NET_C: Prisma.Sql`, `LINE_COST_C: Prisma.Sql`, `completedLinesInWindow(business): Prisma.Sql`
  - `interface Margin { grossProfitC: number | null; marginPct: number | null }`, `marginOf(costedLines, costedRevenueC, costedCostC): Margin`
  - `interface ProductSalesRow`, `topProductsSql(business, by, limit)`, `categoryRollupSql(business)`
  - `class ProductReportQueryDto extends AnalyticsQueryDto { by?: 'units' | 'revenue'; limit?: number }`
  - `interface ProductRow { productId, variantId, name, units, revenueC, grossProfitC, marginPct }`
  - `ProductsReportService.top(query)`
  - `seedCatalog(raw, businessId)` → `{ categoryId, products: {...} }`
  - `GET /v1/portal/analytics/products/top`

- [ ] **Step 1: Write the failing margin unit test**

Create `src/portal/analytics/margin.spec.ts`:

```ts
import { marginOf } from './margin';

describe('marginOf', () => {
  // The single most damaging silent error available in this codebase: a zero
  // cost reports 100% margin on a product whose cost nobody recorded.
  it('reports unknown, not zero, when no line carried a cost', () => {
    expect(marginOf(0, 0, 0)).toEqual({ grossProfitC: null, marginPct: null });
  });

  it('reports unknown even when uncosted lines produced revenue', () => {
    expect(marginOf(0, 0, 0)).toEqual({ grossProfitC: null, marginPct: null });
  });

  it('computes profit and margin over the costed lines only', () => {
    expect(marginOf(3, 10000, 6000)).toEqual({
      grossProfitC: 4000,
      marginPct: 40,
    });
  });

  it('reports a negative margin when cost exceeded revenue', () => {
    expect(marginOf(1, 1000, 1500)).toEqual({
      grossProfitC: -500,
      marginPct: -50,
    });
  });

  it('reports margin as null when costed revenue is zero but a cost existed', () => {
    // A fully discounted costed line: profit is knowable, margin is not.
    expect(marginOf(1, 0, 500)).toEqual({
      grossProfitC: -500,
      marginPct: null,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- margin
```

Expected: FAIL — `Cannot find module './margin'`.

- [ ] **Step 3: Write the margin rule**

Create `src/portal/analytics/margin.ts`:

```ts
/**
 * The one place the costed/uncosted split turns into a profit and a margin.
 *
 * Extracted because §1, §2, §3, §4 and §5 all need it and all must agree. The
 * rule, from the spec: a null cost means UNKNOWN margin, never zero margin.
 *
 *  - No costed lines at all → both figures are null. There is nothing to say.
 *  - Costed lines exist → profit is over those lines only, and the caller
 *    reports `costedRevenueC` / `uncostedRevenueC` beside it so the reader can
 *    see what share of revenue the number covers.
 *  - Costed revenue of zero (a fully discounted costed line) → profit is
 *    knowable, margin is a division by zero, so margin alone is null.
 */
export interface Margin {
  grossProfitC: number | null;
  marginPct: number | null;
}

export function marginOf(
  costedLines: number,
  costedRevenueC: number,
  costedCostC: number,
): Margin {
  if (costedLines === 0) return { grossProfitC: null, marginPct: null };

  const grossProfitC = costedRevenueC - costedCostC;
  return {
    grossProfitC,
    marginPct:
      costedRevenueC === 0 ? null : (grossProfitC / costedRevenueC) * 100,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- margin
```

Expected: PASS, five tests.

- [ ] **Step 5: Extract the line-money fragment**

Create `src/portal/analytics/reports/line-money.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * The modifier-aware line arithmetic, in ONE place.
 *
 * `sale_items.unit_price` is the BASE price locked at add-to-cart
 * (`sales.service.ts:507`). The totals engine's line gross is
 * `lineUnitWithModsC()` = `unitPriceC + Σ modifiers[].priceDeltaC`
 * (`cart.ts:49`), and the chosen modifiers live in the `modifiers` jsonb array.
 * `qty * unit_price` alone therefore understates every line carrying a priced
 * modifier, and Σ over a sale would not equal `sales.subtotal`.
 *
 * `cost_snapshot` is a UNIT cost (`sales.service.ts:664`).
 *
 * The CASE inside the lateral is required, not defensive: `jsonb_array_elements`
 * raises on a non-array and is evaluated in FROM, before any WHERE could filter
 * the row out.
 *
 * Any query joining `sale_items si` must include `LINE_MONEY_JOINS` before
 * using `LINE_NET_C` or `LINE_COST_C`.
 */
export const LINE_MONEY_JOINS = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM((m->>'priceDeltaC')::int), 0) AS mods_c
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(si.modifiers) = 'array'
           THEN si.modifiers ELSE '[]'::jsonb END
    ) AS m
  ) mods
  CROSS JOIN LATERAL (
    SELECT round(si.qty * (si.unit_price + mods.mods_c)) - si.discount AS net_c
  ) line
`;

/** Line revenue after that line's own discount. */
export const LINE_NET_C = Prisma.sql`line.net_c`;

/** Line cost. Null-safe: NULL when no cost was recorded. */
export const LINE_COST_C = Prisma.sql`round(si.qty * si.cost_snapshot)`;

/**
 * Shared predicate for line-level queries: completed, live sale and live line,
 * inside this business's window, scoped to its branches.
 */
export function completedLinesInWindow(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND si.deleted_at IS NULL
    AND s.status = 'completed'
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
  `;
}
```

- [ ] **Step 6: Point the existing aggregate at the extracted fragment**

In `src/portal/analytics/reports/sales-aggregate.sql.ts`, import the fragment and replace the two inline `CROSS JOIN LATERAL` blocks and the trailing `WHERE` of `lineAggregateSql` with it:

```ts
import {
  LINE_COST_C,
  LINE_MONEY_JOINS,
  LINE_NET_C,
  completedLinesInWindow,
} from './line-money.sql';
```

`lineAggregateSql` keeps its own window parameters (it is called for both the current and previous periods), so it cannot use `completedLinesInWindow` directly — inline the same predicate with its `fromUtc`/`toUtc` arguments and use `LINE_MONEY_JOINS`, `LINE_NET_C` and `LINE_COST_C` for the money:

```ts
export function lineAggregateSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NULL), 0)::bigint
        AS uncosted_revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND si.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
  `;
}
```

- [ ] **Step 7: Prove the extraction changed nothing**

```bash
npm run test:e2e -- portal-analytics-overview
```

Expected: PASS, unchanged. This is a pure refactor — if any overview figure moves, the extraction is wrong.

- [ ] **Step 8: Commit the refactor separately**

```bash
git add src/portal/analytics/reports/line-money.sql.ts src/portal/analytics/reports/sales-aggregate.sql.ts src/portal/analytics/margin.ts src/portal/analytics/margin.spec.ts
git commit -m "refactor(analytics): extract the modifier-aware line-money fragment and the margin rule"
```

- [ ] **Step 9: Write the catalog test helper**

Create `test/helpers/catalog.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

/**
 * A small catalog for the report suites: one category, three products, one of
 * them with a variant, one of them with NO cost (so every suite can exercise
 * the unknown-margin path without building its own fixture).
 */
export interface SeededCatalog {
  categoryId: string;
  otherCategoryId: string;
  /** Costed, no variants. */
  beans: { id: string };
  /** Costed, one variant. */
  latte: { id: string; variantId: string };
  /** NO cost recorded — margin must read unknown wherever it appears. */
  mystery: { id: string };
}

export async function seedCatalog(
  raw: PrismaClient,
  businessId: string,
): Promise<SeededCatalog> {
  const category = await raw.category.create({
    data: { businessId, name: 'Coffee', sortOrder: 0 },
  });
  const otherCategory = await raw.category.create({
    data: { businessId, name: 'Grocery', sortOrder: 1 },
  });

  const beans = await raw.product.create({
    data: {
      businessId,
      categoryId: otherCategory.id,
      name: 'Beans',
      price: 25000,
      cost: 15000,
      lowStockThreshold: '10',
    },
  });

  const latte = await raw.product.create({
    data: {
      businessId,
      categoryId: category.id,
      name: 'Latte',
      price: 12000,
      cost: 4000,
      variants: { create: [{ name: 'Large', price: 14000, cost: 5000 }] },
    },
    include: { variants: true },
  });

  const mystery = await raw.product.create({
    data: {
      businessId,
      categoryId: category.id,
      name: 'Mystery Blend',
      price: 20000,
      cost: null,
    },
  });

  return {
    categoryId: category.id,
    otherCategoryId: otherCategory.id,
    beans: { id: beans.id },
    latte: { id: latte.id, variantId: latte.variants[0].id },
    mystery: { id: mystery.id },
  };
}
```

- [ ] **Step 10: Write the failing e2e test for top sellers**

Create `test/portal-analytics-products.e2e-spec.ts`. Copy the bootstrap (`beforeAll`, `afterAll`, `beforeEach`, `ctx()`, `server()`) verbatim from `test/portal-analytics-overview.e2e-spec.ts`, renaming the describe to `'Analytics products (e2e)'`, and add `seedCatalog` to the imports. Then:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const DURING = new Date('2026-03-03T04:00:00.000Z');

  const get = (token: string, path: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/products/${path}?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('ranks top sellers by units', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 5, unitPriceC: 25000, costC: 15000 },
        { name: 'Latte — Large', productId: cat.latte.id, variantId: cat.latte.variantId, qty: 2, unitPriceC: 14000, costC: 5000 },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}&by=units`,
    ).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      productId: cat.beans.id,
      name: 'Beans',
      units: 5,
      revenueC: 125000,
      grossProfitC: 50000,
    });
    expect(res.body.rows[1].productId).toBe(cat.latte.id);
  });

  it('ranks top sellers by revenue, which can reverse the unit order', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 10, unitPriceC: 1000 },
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 50000 },
      ],
    });

    const byUnits = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}&by=units`,
    ).expect(200);
    expect(byUnits.body.rows[0].productId).toBe(cat.latte.id);

    const byRevenue = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}&by=revenue`,
    ).expect(200);
    expect(byRevenue.body.rows[0].productId).toBe(cat.beans.id);
  });

  it('separates a variant from its parent product', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 1, unitPriceC: 12000, costC: 4000 },
        { name: 'Latte — Large', productId: cat.latte.id, variantId: cat.latte.variantId, qty: 1, unitPriceC: 14000, costC: 5000 },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows).toHaveLength(2);
    const variantRow = res.body.rows.find((r: any) => r.variantId === cat.latte.variantId);
    expect(variantRow.revenueC).toBe(14000);
    const parentRow = res.body.rows.find((r: any) => r.variantId === null);
    expect(parentRow.revenueC).toBe(12000);
  });

  it('includes modifier prices in product revenue', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          productId: cat.latte.id,
          qty: 2,
          unitPriceC: 12000,
          costC: 4000,
          modifiers: [
            {
              groupId: '11111111-1111-1111-1111-111111111111',
              modifierId: '22222222-2222-2222-2222-222222222222',
              name: 'Oat milk',
              priceDeltaC: 2000,
            },
          ],
        },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    // 2 × (12000 + 2000), not 2 × 12000.
    expect(res.body.rows[0].revenueC).toBe(28000);
    expect(res.body.rows[0].grossProfitC).toBe(20000);
  });

  it('reports an uncosted product with a null profit, never zero', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Mystery Blend', productId: cat.mystery.id, qty: 3, unitPriceC: 20000, costC: null },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows[0].revenueC).toBe(60000);
    expect(res.body.rows[0].grossProfitC).toBeNull();
    expect(res.body.rows[0].marginPct).toBeNull();
  });

  it('names a row from the sale snapshot, so an archived product still reads', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans (2026 harvest)', productId: cat.beans.id, qty: 1, unitPriceC: 25000 }],
    });
    await raw.product.update({
      where: { id: cat.beans.id },
      data: { active: false, deletedAt: new Date() },
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows[0].name).toBe('Beans (2026 harvest)');
  });

  it('leaves misc open-price lines out of product rankings', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 },
        { name: 'Repair fee', productId: null, qty: 1, unitPriceC: 99900 },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    // A misc line is not a product; it is reported in the §4 leaks view.
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].productId).toBe(cat.beans.id);
  });

  it('rolls sales up by category', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 2, unitPriceC: 12000 },
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    const byName = Object.fromEntries(
      res.body.categories.map((r: any) => [r.name, r.revenueC]),
    );
    expect(byName.Coffee).toBe(24000);
    expect(byName.Grocery).toBe(25000);
  });

  it('honours the limit and rejects an out-of-range one', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 2, unitPriceC: 12000 },
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 },
      ],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}&limit=1`,
    ).expect(200);
    expect(res.body.rows).toHaveLength(1);

    await get(c.token, 'top', `${RANGE}&businessId=${c.business.id}&limit=0`).expect(422);
    await get(c.token, 'top', `${RANGE}&businessId=${c.business.id}&limit=101`).expect(422);
    await get(c.token, 'top', `${RANGE}&businessId=${c.business.id}&by=price`).expect(422);
  });

  it('excludes voided sales from product rankings', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      status: 'voided',
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 9, unitPriceC: 25000 }],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows).toEqual([]);
  });

  it('exports top sellers as CSV', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000, costC: 15000 }],
    });

    const res = await get(
      c.token,
      'top',
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Beans,1,250.00,100.00');
  });
```

- [ ] **Step 11: Run the tests to verify they fail**

```bash
docker compose up -d db
npm run test:e2e -- portal-analytics-products
```

Expected: 404 on every case — the route does not exist.

- [ ] **Step 12: Write the product-sales SQL**

Create `src/portal/analytics/reports/product-sales.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import {
  LINE_COST_C,
  LINE_MONEY_JOINS,
  LINE_NET_C,
  completedLinesInWindow,
} from './line-money.sql';

export type RankBy = 'units' | 'revenue';

export interface ProductSalesRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  units: string;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * Units and revenue per product (and per variant — a variant is its own line in
 * every ranking, because that is the granularity the POS sells at).
 *
 * Misc open-price lines (`product_id IS NULL`) are excluded: they are not
 * products, and they get their own figure in the §4 leaks view.
 *
 * The name comes from the MOST RECENT `name_snapshot` rather than the live
 * product row — that is what the snapshot is for, and it keeps an archived or
 * renamed product readable in a historical report.
 */
export function topProductsSql(
  business: ScopedBusiness,
  by: RankBy,
  limit: number,
): Prisma.Sql {
  const order =
    by === 'units' ? Prisma.sql`units DESC` : Prisma.sql`revenue_c DESC`;

  return Prisma.sql`
    SELECT
      si.product_id::text AS product_id,
      si.variant_id::text AS variant_id,
      (array_agg(si.name_snapshot ORDER BY s.created_at DESC))[1] AS name,
      SUM(si.qty)::text AS units,
      COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY si.product_id, si.variant_id
    ORDER BY ${order}
    LIMIT ${limit}
  `;
}

/** The same ranking, ascending — the bottom of the list. */
export function slowProductsSql(
  business: ScopedBusiness,
  by: RankBy,
  limit: number,
): Prisma.Sql {
  const order =
    by === 'units' ? Prisma.sql`units ASC` : Prisma.sql`revenue_c ASC`;

  return Prisma.sql`
    SELECT
      si.product_id::text AS product_id,
      si.variant_id::text AS variant_id,
      (array_agg(si.name_snapshot ORDER BY s.created_at DESC))[1] AS name,
      SUM(si.qty)::text AS units,
      COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY si.product_id, si.variant_id
    ORDER BY ${order}
    LIMIT ${limit}
  `;
}

export interface CategoryRollupRow {
  category_id: string;
  name: string;
  units: string;
  revenue_c: bigint;
}

/**
 * Category rollup. The category comes from the LIVE product row rather than a
 * snapshot (sale_items does not record one), so a re-categorised product moves
 * its history — accepted, and noted here so nobody reads it as a bug.
 */
export function categoryRollupSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id::text AS category_id,
      c.name     AS name,
      SUM(si.qty)::text AS units,
      COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c
    FROM sale_items si
    JOIN sales s      ON s.id = si.sale_id
    JOIN products p   ON p.id = si.product_id
    JOIN categories c ON c.id = p.category_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY c.id, c.name
    ORDER BY revenue_c DESC
  `;
}

export interface ZeroSalesRow {
  product_id: string;
  name: string;
  category_name: string;
}

/**
 * Active products with no sale line in the window — the restock-or-retire list.
 *
 * The `branch_id` predicate lives inside the NOT EXISTS, which is both correct
 * (a product counts as unsold when it sold in NONE of the scoped branches) and
 * what satisfies `runScoped`'s tripwire.
 */
export function zeroSalesSql(
  business: ScopedBusiness,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id::text AS product_id, p.name AS name, c.name AS category_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.business_id = ${business.id}::uuid
      AND p.deleted_at IS NULL
      AND p.active = true
      AND NOT EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE si.product_id = p.id
          AND si.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND s.status = 'completed'
          AND s.branch_id = ANY(${business.branchIds}::uuid[])
          AND s.created_at >= ${business.fromUtc}
          AND s.created_at <  ${business.toUtc}
      )
    ORDER BY p.name ASC
    LIMIT ${limit}
  `;
}
```

- [ ] **Step 13: Write the query DTO**

Create `src/portal/analytics/dto/product-report-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class ProductReportQueryDto extends AnalyticsQueryDto {
  /** Defaults to `units`. */
  @IsOptional()
  @IsIn(['units', 'revenue'])
  by?: 'units' | 'revenue';

  /** 1–100, defaults to 20. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
```

- [ ] **Step 14: Write the service**

Create `src/portal/analytics/products/products-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import { marginOf } from '../margin';
import {
  categoryRollupSql,
  topProductsSql,
  type CategoryRollupRow,
  type ProductSalesRow,
  type RankBy,
} from '../reports/product-sales.sql';

const DEFAULT_LIMIT = 20;

export interface ProductRow {
  productId: string;
  variantId: string | null;
  name: string;
  units: number;
  revenueC: number;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  units: number;
  revenueC: number;
}

export interface TopProductsReport {
  from: string;
  to: string;
  by: RankBy;
  rows: ProductRow[];
  categories: CategoryRow[];
}

/** Aggregated per business, then merged and re-ranked across businesses. */
interface Accumulated {
  productId: string;
  variantId: string | null;
  name: string;
  units: number;
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

function key(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ''}`;
}

export function toProductRow(a: Accumulated): ProductRow {
  const { grossProfitC, marginPct } = marginOf(
    a.costedLines,
    a.costedRevenueC,
    a.costedCostC,
  );
  return {
    productId: a.productId,
    variantId: a.variantId,
    name: a.name,
    units: a.units,
    revenueC: a.revenueC,
    grossProfitC,
    marginPct,
  };
}

/**
 * §3 Products (sold).
 *
 * Each business is queried with its own LIMIT and the results merged, so a
 * top-20 across three businesses considers 60 candidate rows before ranking —
 * the alternative (one global query) is impossible while each business has its
 * own day-start window.
 */
@Injectable()
export class ProductsReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async top(query: ProductReportQueryDto): Promise<TopProductsReport> {
    const by: RankBy = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const scope = await this.scope.resolve(query);

    const products = new Map<string, Accumulated>();
    const categories = new Map<string, CategoryRow>();

    for (const business of scope.businesses) {
      const rows = await runScoped<ProductSalesRow>(this.raw, business, (b) =>
        topProductsSql(b, by, limit),
      );
      for (const row of rows) {
        const id = key(row.product_id, row.variant_id);
        const current = products.get(id);
        const next: Accumulated = {
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
          units: (current?.units ?? 0) + Number(row.units),
          revenueC: (current?.revenueC ?? 0) + Number(row.revenue_c),
          costedLines: (current?.costedLines ?? 0) + Number(row.costed_lines),
          costedRevenueC:
            (current?.costedRevenueC ?? 0) + Number(row.costed_revenue_c),
          costedCostC: (current?.costedCostC ?? 0) + Number(row.costed_cost_c),
        };
        products.set(id, next);
      }

      const rollup = await runScoped<CategoryRollupRow>(
        this.raw,
        business,
        categoryRollupSql,
      );
      for (const row of rollup) {
        const current = categories.get(row.category_id);
        categories.set(row.category_id, {
          categoryId: row.category_id,
          name: row.name,
          units: (current?.units ?? 0) + Number(row.units),
          revenueC: (current?.revenueC ?? 0) + Number(row.revenue_c),
        });
      }
    }

    await this.reportAudit.log(scope, 'products-top', query.format ?? 'json');

    const rank = (a: ProductRow, b: ProductRow) =>
      by === 'units' ? b.units - a.units : b.revenueC - a.revenueC;

    return {
      from: scope.from,
      to: scope.to,
      by,
      rows: [...products.values()].map(toProductRow).sort(rank).slice(0, limit),
      categories: [...categories.values()].sort(
        (a, b) => b.revenueC - a.revenueC,
      ),
    };
  }
}
```

- [ ] **Step 15: Write the CSV builder**

Create `src/portal/analytics/products/products-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { ProductRow, TopProductsReport } from './products-report.service';

export const productColumns = [
  'Product',
  'Units',
  'Revenue',
  'Gross profit',
  'Margin %',
];

export function productRowCells(row: ProductRow): (string | number | null)[] {
  return [
    row.name,
    row.units,
    centavosToPesos(row.revenueC),
    centavosToPesos(row.grossProfitC),
    row.marginPct === null ? '' : row.marginPct.toFixed(1),
  ];
}

export function topProductsCsv(report: TopProductsReport): CsvSection[] {
  return [
    {
      columns: productColumns,
      rows: report.rows.map(productRowCells),
    },
    {
      title: 'By category',
      columns: ['Category', 'Units', 'Revenue'],
      rows: report.categories.map((c) => [
        c.name,
        c.units,
        centavosToPesos(c.revenueC),
      ]),
    },
  ];
}
```

- [ ] **Step 16: Write the controller and register it**

Create `src/portal/analytics/products/products-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { renderReport } from '../report-response';
import { topProductsCsv } from './products-report.csv';
import {
  ProductsReportService,
  type TopProductsReport,
} from './products-report.service';

/** §3 Products sold — `GET /v1/portal/analytics/products/*`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProductsReportController {
  constructor(private readonly products: ProductsReportService) {}

  @Get('analytics/products/top')
  async top(
    @Query() query: ProductReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TopProductsReport | string> {
    const report = await this.products.top(query);
    return renderReport(res, 'products-top', query, report, topProductsCsv);
  }
}
```

Register `ProductsReportController` in `controllers` and `ProductsReportService` in `providers` in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 17: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: PASS, all cases. A revenue of 24000 where 28000 was expected means a query bypassed `LINE_NET_C`.

- [ ] **Step 18: Commit**

```bash
git add src/portal/analytics test/helpers/catalog.ts test/portal-analytics-products.e2e-spec.ts
git commit -m "feat(analytics): top sellers by units or revenue with category rollup"
```

---

## Task 2: Slow movers and zero-sales products (§3)

The restock-or-retire list. Two different questions: what sold badly, and what did not sell at all — the second cannot come from `sale_items`, because the rows do not exist.

**Files:**
- Modify: `src/portal/analytics/products/products-report.service.ts`
- Modify: `src/portal/analytics/products/products-report.controller.ts`
- Modify: `src/portal/analytics/products/products-report.csv.ts`
- Test: `test/portal-analytics-products.e2e-spec.ts`

**Interfaces:**
- Consumes: `slowProductsSql`, `zeroSalesSql` (both already written in Task 1), `toProductRow`, `productColumns`, `productRowCells`.
- Produces:
  - `interface SlowProductsReport { from, to, by, bottom: ProductRow[], zeroSales: ZeroSalesProduct[] }`
  - `interface ZeroSalesProduct { productId, name, categoryName }`
  - `ProductsReportService.slow(query)`
  - `slowProductsCsv(report)`
  - `GET /v1/portal/analytics/products/slow`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/portal-analytics-products.e2e-spec.ts`:

```ts
  it('ranks the worst sellers first', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 10, unitPriceC: 25000 },
        { name: 'Latte', productId: cat.latte.id, qty: 1, unitPriceC: 12000 },
      ],
    });

    const res = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}&by=units`,
    ).expect(200);

    expect(res.body.bottom[0].productId).toBe(cat.latte.id);
    expect(res.body.bottom[0].units).toBe(1);
  });

  it('lists active products with no sale at all in the range', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 }],
    });

    const res = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    const names = res.body.zeroSales.map((p: any) => p.name).sort();
    expect(names).toEqual(['Latte', 'Mystery Blend']);
    expect(res.body.zeroSales[0].categoryName).toBeDefined();
  });

  it('counts a product sold only OUTSIDE the range as a zero-sales product', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-02-10T04:00:00.000Z'),
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 }],
    });

    const res = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.zeroSales.map((p: any) => p.name)).toContain('Beans');
  });

  it('leaves archived products out of the zero-sales list', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.product.update({
      where: { id: cat.mystery.id },
      data: { active: false },
    });

    const res = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    // Archiving IS the retire decision — re-suggesting it would be noise.
    expect(res.body.zeroSales.map((p: any) => p.name)).not.toContain(
      'Mystery Blend',
    );
  });

  it('counts a product as unsold only when it sold in NO scoped branch', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    const second = await raw.branch.create({
      data: { businessId: c.business.id, name: 'Second', code: 'SD', address: 'x' },
    });
    const { terminalId } = await seedBranchInfra(raw, second.id);
    await seedSale(raw, {
      branchId: second.id,
      terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 }],
    });

    const all = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);
    expect(all.body.zeroSales.map((p: any) => p.name)).not.toContain('Beans');

    const firstOnly = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}&branchId=${c.branch.id}`,
    ).expect(200);
    expect(firstOnly.body.zeroSales.map((p: any) => p.name)).toContain('Beans');
  });

  it('exports slow movers and the zero-sales list as two CSV sections', async () => {
    const c = await ctx();
    await seedCatalog(raw, c.business.id);

    const res = await get(
      c.token,
      'slow',
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.text).toContain('No sales in range');
    expect(res.text).toContain('Mystery Blend');
  });
```

Add `seedBranchInfra` to the file's imports from `./helpers/sales` if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: the six new cases 404; the Task 1 cases still pass.

- [ ] **Step 3: Add the service method**

In `src/portal/analytics/products/products-report.service.ts`, add the imports and the method:

```ts
import {
  slowProductsSql,
  zeroSalesSql,
  type ZeroSalesRow,
} from '../reports/product-sales.sql';
```

```ts
export interface ZeroSalesProduct {
  productId: string;
  name: string;
  categoryName: string;
}

export interface SlowProductsReport {
  from: string;
  to: string;
  by: RankBy;
  bottom: ProductRow[];
  zeroSales: ZeroSalesProduct[];
}
```

```ts
  /**
   * Two questions, two queries. "Sold badly" comes from `sale_items`; "did not
   * sell at all" cannot, because those rows do not exist — it needs a NOT
   * EXISTS over the catalog.
   *
   * Archived products are excluded from `zeroSales` deliberately: archiving is
   * already the retire decision, and re-suggesting it every week is noise.
   */
  async slow(query: ProductReportQueryDto): Promise<SlowProductsReport> {
    const by: RankBy = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const scope = await this.scope.resolve(query);

    const products = new Map<string, Accumulated>();
    const zeroSales: ZeroSalesProduct[] = [];

    for (const business of scope.businesses) {
      const rows = await runScoped<ProductSalesRow>(this.raw, business, (b) =>
        slowProductsSql(b, by, limit),
      );
      for (const row of rows) {
        const id = key(row.product_id, row.variant_id);
        const current = products.get(id);
        products.set(id, {
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
          units: (current?.units ?? 0) + Number(row.units),
          revenueC: (current?.revenueC ?? 0) + Number(row.revenue_c),
          costedLines: (current?.costedLines ?? 0) + Number(row.costed_lines),
          costedRevenueC:
            (current?.costedRevenueC ?? 0) + Number(row.costed_revenue_c),
          costedCostC: (current?.costedCostC ?? 0) + Number(row.costed_cost_c),
        });
      }

      for (const row of await runScoped<ZeroSalesRow>(this.raw, business, (b) =>
        zeroSalesSql(b, limit),
      )) {
        zeroSales.push({
          productId: row.product_id,
          name: row.name,
          categoryName: row.category_name,
        });
      }
    }

    await this.reportAudit.log(scope, 'products-slow', query.format ?? 'json');

    const rank = (a: ProductRow, b: ProductRow) =>
      by === 'units' ? a.units - b.units : a.revenueC - b.revenueC;

    return {
      from: scope.from,
      to: scope.to,
      by,
      bottom: [...products.values()]
        .map(toProductRow)
        .sort(rank)
        .slice(0, limit),
      zeroSales: zeroSales.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
```

- [ ] **Step 4: Add the CSV builder**

Append to `src/portal/analytics/products/products-report.csv.ts`:

```ts
import type { SlowProductsReport } from './products-report.service';

export function slowProductsCsv(report: SlowProductsReport): CsvSection[] {
  return [
    {
      title: 'Slowest movers',
      columns: productColumns,
      rows: report.bottom.map(productRowCells),
    },
    {
      title: 'No sales in range',
      columns: ['Product', 'Category'],
      rows: report.zeroSales.map((p) => [p.name, p.categoryName]),
    },
  ];
}
```

- [ ] **Step 5: Add the route**

In `src/portal/analytics/products/products-report.controller.ts`:

```ts
  @Get('analytics/products/slow')
  async slow(
    @Query() query: ProductReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SlowProductsReport | string> {
    const report = await this.products.slow(query);
    return renderReport(res, 'products-slow', query, report, slowProductsCsv);
  }
```

with matching imports for `slowProductsCsv` and `SlowProductsReport`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-products.e2e-spec.ts
git commit -m "feat(analytics): slow movers and the zero-sales restock-or-retire list"
```

---

## Task 3: Per-product trend (§3)

One product's units, revenue and margin over time — the drill-down from a ranking row.

**Files:**
- Modify: `src/portal/analytics/reports/sales-series.sql.ts` (export the bucket helper)
- Modify: `src/portal/analytics/reports/product-sales.sql.ts`
- Create: `src/portal/analytics/dto/product-trend-query.dto.ts`
- Modify: `src/portal/analytics/products/products-report.service.ts`
- Modify: `src/portal/analytics/products/products-report.controller.ts`
- Modify: `src/portal/analytics/products/products-report.csv.ts`
- Test: `test/portal-analytics-products.e2e-spec.ts`

**Interfaces:**
- Consumes: `dayBucketExpr`, `Granularity`, `marginOf`, `SCOPED_PRISMA`.
- Produces:
  - `bucketExpr(business, granularity): Prisma.Sql` — exported from `sales-series.sql`
  - `productTrendSql(business, productId, granularity)`, `ProductTrendRow`
  - `class ProductTrendQueryDto extends AnalyticsQueryDto { granularity?: Granularity }`
  - `ProductsReportService.trend(productId, query)`
  - `GET /v1/portal/analytics/products/:productId/trend`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/portal-analytics-products.e2e-spec.ts`:

```ts
  const trend = (token: string, productId: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/products/${productId}/trend?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('reports one products units, revenue and margin by day', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 2, unitPriceC: 25000, costC: 15000 }],
    });

    const res = await trend(
      c.token,
      cat.beans.id,
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-03');
    expect(day).toMatchObject({
      units: 2,
      revenueC: 50000,
      grossProfitC: 20000,
      marginPct: 40,
    });
  });

  it('zero-fills the days a product did not sell', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000 }],
    });

    const res = await trend(
      c.token,
      cat.beans.id,
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(200);

    expect(res.body.buckets).toHaveLength(7);
    expect(res.body.buckets[0]).toMatchObject({
      bucket: '2026-03-01',
      units: 0,
      revenueC: 0,
      grossProfitC: null,
    });
  });

  it('rolls a products variants into its trend', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 1, unitPriceC: 12000, costC: 4000 },
        { name: 'Latte — Large', productId: cat.latte.id, variantId: cat.latte.variantId, qty: 1, unitPriceC: 14000, costC: 5000 },
      ],
    });

    const res = await trend(
      c.token,
      cat.latte.id,
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-03');
    expect(day.units).toBe(2);
    expect(day.revenueC).toBe(26000);
  });

  it('404s for a product that is not the callers', async () => {
    const c = await ctx();
    const other = await ctx();
    const theirs = await seedCatalog(raw, other.business.id);

    await trend(
      c.token,
      theirs.beans.id,
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(404);
  });

  it('rejects an unknown granularity with 422', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await trend(
      c.token,
      cat.beans.id,
      `${RANGE}&businessId=${c.business.id}&granularity=fortnight`,
    ).expect(422);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: the five new cases 404.

- [ ] **Step 3: Export the bucket helper**

In `src/portal/analytics/reports/sales-series.sql.ts`, change the private `truncated` into an exported helper so product queries bucket identically to sales ones:

```ts
/**
 * The bucket a sale falls in, at the requested granularity. Exported so §3's
 * per-product trend buckets EXACTLY as §2's sales trend does — two different
 * bucketing rules would make a product's chart disagree with the sales chart
 * behind it.
 */
export function bucketExpr(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  if (granularity === 'day') return dayBucketExpr(business);
  const unit = granularity === 'week' ? 'week' : 'month';
  return Prisma.sql`(date_trunc(${unit}, ${dayBucketExpr(business)})::date)`;
}
```

Replace the existing private `truncated` with calls to `bucketExpr`.

- [ ] **Step 4: Add the trend SQL**

Append to `src/portal/analytics/reports/product-sales.sql.ts`:

```ts
import { bucketExpr, type Granularity } from './sales-series.sql';

export interface ProductTrendRow {
  bucket: Date;
  units: string;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * One product's series. Variants roll UP into their parent here: the caller
 * asked about the product, and a per-variant split is what `top` already gives.
 */
export function productTrendSql(
  business: ScopedBusiness,
  productId: string,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${bucketExpr(business, granularity)} AS bucket,
      SUM(si.qty)::text AS units,
      COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id = ${productId}::uuid
    GROUP BY 1
    ORDER BY 1
  `;
}
```

- [ ] **Step 5: Add the trend DTO**

Create `src/portal/analytics/dto/product-trend-query.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class ProductTrendQueryDto extends AnalyticsQueryDto {
  /** Defaults to `day`. */
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month';
}
```

- [ ] **Step 6: Add the service method**

In `src/portal/analytics/products/products-report.service.ts`, inject the scoped client so ownership can be checked, and add the method:

```ts
import { Inject } from '@nestjs/common';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../../common/errors/api-errors';
import { businessDaySeries } from '../scope/business-day';
import { productTrendSql, type ProductTrendRow } from '../reports/product-sales.sql';
import { ProductTrendQueryDto } from '../dto/product-trend-query.dto';
```

Add `@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,` to the constructor, then:

```ts
export interface ProductTrendBucket {
  bucket: string;
  units: number;
  revenueC: number;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProductTrendReport {
  from: string;
  to: string;
  productId: string;
  granularity: 'day' | 'week' | 'month';
  buckets: ProductTrendBucket[];
}
```

```ts
  /**
   * Ownership is checked through the SCOPED client, not by trusting the id in
   * the path: an unowned product resolves to nothing and 404s, with no
   * cross-tenant existence leak.
   */
  async trend(
    productId: string,
    query: ProductTrendQueryDto,
  ): Promise<ProductTrendReport> {
    const granularity = query.granularity ?? 'day';
    const scope = await this.scope.resolve(query);

    const owned = await this.scoped.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundError('Product not found.');

    const totals = new Map<
      string,
      {
        units: number;
        revenueC: number;
        costedLines: number;
        costedRevenueC: number;
        costedCostC: number;
      }
    >();

    for (const business of scope.businesses) {
      const rows = await runScoped<ProductTrendRow>(this.raw, business, (b) =>
        productTrendSql(b, productId, granularity),
      );
      for (const row of rows) {
        const bucket = row.bucket.toISOString().slice(0, 10);
        const current = totals.get(bucket);
        totals.set(bucket, {
          units: (current?.units ?? 0) + Number(row.units),
          revenueC: (current?.revenueC ?? 0) + Number(row.revenue_c),
          costedLines: (current?.costedLines ?? 0) + Number(row.costed_lines),
          costedRevenueC:
            (current?.costedRevenueC ?? 0) + Number(row.costed_revenue_c),
          costedCostC: (current?.costedCostC ?? 0) + Number(row.costed_cost_c),
        });
      }
    }

    await this.reportAudit.log(scope, 'products-trend', query.format ?? 'json');

    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...totals.keys()].sort();

    return {
      from: scope.from,
      to: scope.to,
      productId,
      granularity,
      buckets: keys.map((bucket) => {
        const t = totals.get(bucket);
        const { grossProfitC, marginPct } = marginOf(
          t?.costedLines ?? 0,
          t?.costedRevenueC ?? 0,
          t?.costedCostC ?? 0,
        );
        return {
          bucket,
          units: t?.units ?? 0,
          revenueC: t?.revenueC ?? 0,
          grossProfitC,
          marginPct,
        };
      }),
    };
  }
```

- [ ] **Step 7: Add the CSV builder and the route**

Append to `src/portal/analytics/products/products-report.csv.ts`:

```ts
import type { ProductTrendReport } from './products-report.service';

export function productTrendCsv(report: ProductTrendReport): CsvSection[] {
  return [
    {
      columns: ['Bucket', 'Units', 'Revenue', 'Gross profit', 'Margin %'],
      rows: report.buckets.map((b) => [
        b.bucket,
        b.units,
        centavosToPesos(b.revenueC),
        centavosToPesos(b.grossProfitC),
        b.marginPct === null ? '' : b.marginPct.toFixed(1),
      ]),
    },
  ];
}
```

Add the route to the controller:

```ts
  @Get('analytics/products/:productId/trend')
  async trend(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: ProductTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductTrendReport | string> {
    const report = await this.products.trend(productId, query);
    return renderReport(res, 'product-trend', query, report, productTrendCsv);
  }
```

importing `Param` and `ParseUUIDPipe` from `@nestjs/common`.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: PASS, all cases.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-products.e2e-spec.ts
git commit -m "feat(analytics): per-product trend with variants rolled into the parent"
```

---

## Task 4: Profit report (§4)

Profit over time, by product, and by category — the BO-only view.

**Files:**
- Modify: `src/portal/analytics/reports/product-sales.sql.ts`
- Create: `src/portal/analytics/profit/profit-report.service.ts`
- Create: `src/portal/analytics/profit/profit-report.controller.ts`
- Create: `src/portal/analytics/profit/profit-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-profit.e2e-spec.ts`

**Interfaces:**
- Consumes: `bucketExpr`, `LINE_*` fragments, `marginOf`, `lineAggregateSql`.
- Produces:
  - `profitByCategorySql(business)`, `CategoryProfitRow`
  - `profitOverTimeSql(business, granularity)`, `ProfitBucketRow`
  - `interface ProfitReport`
  - `ProfitReportService.run(query)`
  - `GET /v1/portal/analytics/profit`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-profit.e2e-spec.ts` with the bootstrap from `portal-analytics-products.e2e-spec.ts` (renamed `'Analytics profit (e2e)'`), then:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const DURING = new Date('2026-03-03T04:00:00.000Z');
  const get = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/profit?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('reports profit by product with margin', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 2, unitPriceC: 25000, costC: 15000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    const row = res.body.byProduct.find((r: any) => r.productId === cat.beans.id);
    expect(row).toMatchObject({
      revenueC: 50000,
      costC: 30000,
      grossProfitC: 20000,
      marginPct: 40,
    });
  });

  it('reports an uncosted product with null cost, profit and margin', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Mystery Blend', productId: cat.mystery.id, qty: 1, unitPriceC: 20000, costC: null }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    const row = res.body.byProduct.find((r: any) => r.productId === cat.mystery.id);
    expect(row.revenueC).toBe(20000);
    expect(row.costC).toBeNull();
    expect(row.grossProfitC).toBeNull();
    expect(row.marginPct).toBeNull();
  });

  it('reports profit by category', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: cat.latte.id, qty: 1, unitPriceC: 12000, costC: 4000 },
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000, costC: 15000 },
      ],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    const coffee = res.body.byCategory.find((r: any) => r.name === 'Coffee');
    expect(coffee.grossProfitC).toBe(8000);
    const grocery = res.body.byCategory.find((r: any) => r.name === 'Grocery');
    expect(grocery.grossProfitC).toBe(10000);
  });

  it('reports profit over time and says what share of revenue it covers', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000, costC: 15000 },
        { name: 'Mystery Blend', productId: cat.mystery.id, qty: 1, unitPriceC: 20000, costC: null },
      ],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    const day = res.body.overTime.find((b: any) => b.bucket === '2026-03-03');
    expect(day.grossProfitC).toBe(10000);
    expect(res.body.costedRevenueC).toBe(25000);
    expect(res.body.uncostedRevenueC).toBe(20000);
  });

  it('excludes voided sales from profit', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      status: 'voided',
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 5, unitPriceC: 25000, costC: 15000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.byProduct).toEqual([]);
    expect(res.body.costedRevenueC).toBe(0);
  });

  it('exports profit as CSV with an empty field for an unknown margin', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Mystery Blend', productId: cat.mystery.id, qty: 1, unitPriceC: 20000, costC: null }],
    });

    const res = await get(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Mystery Blend,200.00,,,');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: 404 on every case.

- [ ] **Step 3: Add the profit SQL**

Append to `src/portal/analytics/reports/product-sales.sql.ts`:

```ts
export interface CategoryProfitRow {
  category_id: string;
  name: string;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

export function profitByCategorySql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id::text AS category_id,
      c.name     AS name,
      COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s      ON s.id = si.sale_id
    JOIN products p   ON p.id = si.product_id
    JOIN categories c ON c.id = p.category_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY c.id, c.name
    ORDER BY revenue_c DESC
  `;
}

export interface ProfitBucketRow {
  bucket: Date;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

export function profitOverTimeSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${bucketExpr(business, granularity)} AS bucket,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
    GROUP BY 1
    ORDER BY 1
  `;
}
```

- [ ] **Step 4: Write the service**

Create `src/portal/analytics/profit/profit-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import { marginOf } from '../margin';
import {
  lineAggregateSql,
  type LineAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  profitByCategorySql,
  profitOverTimeSql,
  topProductsSql,
  type CategoryProfitRow,
  type ProductSalesRow,
  type ProfitBucketRow,
} from '../reports/product-sales.sql';

/** Enough rows to cover any realistic catalog without an unbounded scan. */
const PRODUCT_ROW_CAP = 500;

export interface ProfitRow {
  productId: string;
  name: string;
  revenueC: number;
  costC: number | null;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface CategoryProfit {
  categoryId: string;
  name: string;
  revenueC: number;
  costC: number | null;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProfitBucket {
  bucket: string;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProfitReport {
  from: string;
  to: string;
  overTime: ProfitBucket[];
  byProduct: ProfitRow[];
  byCategory: CategoryProfit[];
  costedRevenueC: number;
  uncostedRevenueC: number;
}

interface CostBucket {
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

const emptyBucket = (): CostBucket => ({
  revenueC: 0,
  costedLines: 0,
  costedRevenueC: 0,
  costedCostC: 0,
});

function accumulate(into: CostBucket, row: CostBucket): CostBucket {
  return {
    revenueC: into.revenueC + row.revenueC,
    costedLines: into.costedLines + row.costedLines,
    costedRevenueC: into.costedRevenueC + row.costedRevenueC,
    costedCostC: into.costedCostC + row.costedCostC,
  };
}

/**
 * `costC` is the cost of the COSTED lines only, and is null when there were
 * none — reporting a partial cost beside a full revenue would invite the reader
 * to subtract them, which would be wrong.
 */
function withMargin(bucket: CostBucket): {
  costC: number | null;
  grossProfitC: number | null;
  marginPct: number | null;
} {
  const { grossProfitC, marginPct } = marginOf(
    bucket.costedLines,
    bucket.costedRevenueC,
    bucket.costedCostC,
  );
  return {
    costC: bucket.costedLines === 0 ? null : bucket.costedCostC,
    grossProfitC,
    marginPct,
  };
}

/** §4 Profit — BO-only (staff-spec §6 keeps managers out of cost entirely). */
@Injectable()
export class ProfitReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<ProfitReport> {
    const scope = await this.scope.resolve(query);

    const overTime = new Map<string, CostBucket>();
    const byProduct = new Map<string, CostBucket & { name: string }>();
    const byCategory = new Map<string, CostBucket & { name: string }>();
    let costedRevenueC = 0;
    let uncostedRevenueC = 0;

    for (const business of scope.businesses) {
      for (const row of await runScoped<ProfitBucketRow>(
        this.raw,
        business,
        (b) => profitOverTimeSql(b, 'day'),
      )) {
        const bucket = row.bucket.toISOString().slice(0, 10);
        overTime.set(
          bucket,
          accumulate(overTime.get(bucket) ?? emptyBucket(), {
            revenueC: 0,
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          }),
        );
      }

      for (const row of await runScoped<ProductSalesRow>(
        this.raw,
        business,
        (b) => topProductsSql(b, 'revenue', PRODUCT_ROW_CAP),
      )) {
        const current = byProduct.get(row.product_id) ?? {
          ...emptyBucket(),
          name: row.name,
        };
        byProduct.set(row.product_id, {
          name: current.name,
          ...accumulate(current, {
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          }),
        });
      }

      for (const row of await runScoped<CategoryProfitRow>(
        this.raw,
        business,
        profitByCategorySql,
      )) {
        const current = byCategory.get(row.category_id) ?? {
          ...emptyBucket(),
          name: row.name,
        };
        byCategory.set(row.category_id, {
          name: current.name,
          ...accumulate(current, {
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          }),
        });
      }

      const totals = await runScopedOne<LineAggregateRow>(
        this.raw,
        business,
        (b) => lineAggregateSql(b, b.fromUtc, b.toUtc),
      );
      costedRevenueC += Number(totals.costed_revenue_c);
      uncostedRevenueC += Number(totals.uncosted_revenue_c);
    }

    await this.reportAudit.log(scope, 'profit', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      overTime: businessDaySeries(scope.from, scope.to).map((bucket) => {
        const b = overTime.get(bucket) ?? emptyBucket();
        const { grossProfitC, marginPct } = marginOf(
          b.costedLines,
          b.costedRevenueC,
          b.costedCostC,
        );
        return { bucket, grossProfitC, marginPct };
      }),
      byProduct: [...byProduct.entries()]
        .map(([productId, b]) => ({
          productId,
          name: b.name,
          revenueC: b.revenueC,
          ...withMargin(b),
        }))
        .sort((a, b) => b.revenueC - a.revenueC),
      byCategory: [...byCategory.entries()]
        .map(([categoryId, b]) => ({
          categoryId,
          name: b.name,
          revenueC: b.revenueC,
          ...withMargin(b),
        }))
        .sort((a, b) => b.revenueC - a.revenueC),
      costedRevenueC,
      uncostedRevenueC,
    };
  }
}
```

- [ ] **Step 5: Write the CSV builder and controller**

Create `src/portal/analytics/profit/profit-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { ProfitReport } from './profit-report.service';

const pct = (value: number | null) => (value === null ? '' : value.toFixed(1));

export function profitCsv(report: ProfitReport): CsvSection[] {
  return [
    {
      title: 'By product',
      columns: ['Product', 'Revenue', 'Cost', 'Gross profit', 'Margin %'],
      rows: report.byProduct.map((r) => [
        r.name,
        centavosToPesos(r.revenueC),
        centavosToPesos(r.costC),
        centavosToPesos(r.grossProfitC),
        pct(r.marginPct),
      ]),
    },
    {
      title: 'By category',
      columns: ['Category', 'Revenue', 'Cost', 'Gross profit', 'Margin %'],
      rows: report.byCategory.map((r) => [
        r.name,
        centavosToPesos(r.revenueC),
        centavosToPesos(r.costC),
        centavosToPesos(r.grossProfitC),
        pct(r.marginPct),
      ]),
    },
    {
      title: 'Over time',
      columns: ['Bucket', 'Gross profit', 'Margin %'],
      rows: report.overTime.map((b) => [
        b.bucket,
        centavosToPesos(b.grossProfitC),
        pct(b.marginPct),
      ]),
    },
    {
      title: 'Profit coverage',
      columns: ['Costed revenue', 'Uncosted revenue'],
      rows: [
        [
          centavosToPesos(report.costedRevenueC),
          centavosToPesos(report.uncostedRevenueC),
        ],
      ],
    },
  ];
}
```

Create `src/portal/analytics/profit/profit-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { profitCsv } from './profit-report.csv';
import { ProfitReportService, type ProfitReport } from './profit-report.service';

/** §4 Profit — `GET /v1/portal/analytics/profit`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class ProfitReportController {
  constructor(private readonly profit: ProfitReportService) {}

  @Get('analytics/profit')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfitReport | string> {
    const report = await this.profit.run(query);
    return renderReport(res, 'profit', query, report, profitCsv);
  }
}
```

Register both in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-profit.e2e-spec.ts
git commit -m "feat(analytics): profit by product, category and time with unknown-cost coverage"
```

---

## Task 5: Leaks report (§4)

Where the money goes that is not profit: discounts by name, the unattributed order-level remainder, SC/PWD, misc rings, voids and refunds with their reasons ranked, and over/short by shift.

**The arithmetic that makes this report honest.** From `totals.ts`:

- `Σ si.discount` over a sale = line promos + SC/PWD applied
- `s.discount` = line promos + the order-level discount
- `s.sc_pwd_discount` = SC/PWD applied

Therefore **`orderDiscount = (s.discount + s.sc_pwd_discount) − Σ si.discount`**, exactly. Attributing all of `s.discount` to the order-level discount id would double-count every line promo on the same sale. That identity is used both for the unattributed total and for per-discount attribution, and it gets its own test.

**Files:**
- Create: `src/portal/analytics/reports/leaks.sql.ts`
- Create: `src/portal/analytics/profit/leaks-report.service.ts`
- Modify: `src/portal/analytics/profit/profit-report.controller.ts`
- Create: `src/portal/analytics/profit/leaks-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-profit.e2e-spec.ts`

**Interfaces:**
- Consumes: `LINE_MONEY_JOINS`, `LINE_NET_C`, `completedLinesInWindow`, `runScoped`, `runScopedOne`.
- Produces:
  - `discountsByNameSql`, `discountTotalsSql`, `miscAndScPwdSql`, `voidRefundSql`, `overShortSql` and their row types
  - `interface LeaksReport`
  - `LeaksReportService.run(query)`
  - `leaksCsv(report)`
  - `GET /v1/portal/analytics/leaks`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/portal-analytics-profit.e2e-spec.ts`:

```ts
  const leaks = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/leaks?${query}`)
      .set('Authorization', `Bearer ${token}`);

  async function namedDiscount(businessId: string, name: string, value: number) {
    return raw.discount.create({
      data: { businessId, name, kind: 'fixed', value, appliesTo: 'both' },
    });
  }

  it('totals a named discount by how much it actually gave away', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    const promo = await namedDiscount(c.business.id, 'Staff meal', 5000);

    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Beans',
          productId: cat.beans.id,
          qty: 1,
          unitPriceC: 25000,
          discount: {
            source: 'named',
            discountId: promo.id,
            name: 'Staff meal',
            kind: 'fixed',
            value: 5000,
          },
        },
      ],
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.discountsByName).toEqual([
      expect.objectContaining({
        discountId: promo.id,
        name: 'Staff meal',
        timesUsed: 1,
        amountC: 5000,
      }),
    ]);
  });

  // The identity under test: order discount = (s.discount + s.sc_pwd_discount)
  // − Σ si.discount. Attributing all of s.discount to the order would report
  // 8000 here instead of 3000.
  it('separates an order-level discount from line promos on the same sale', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);

    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Beans',
          productId: cat.beans.id,
          qty: 1,
          unitPriceC: 25000,
          discount: { source: 'free', kind: 'fixed', value: 5000 },
        },
      ],
      orderDiscount: { source: 'free', kind: 'fixed', value: 3000 },
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.orderLevelDiscountC).toBe(3000);
  });

  it('reports SC/PWD discounts, VAT-exempt sales and the sale count', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    const { totals } = await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 25000, scPwdMarked: true },
      ],
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.scPwd.discountC).toBe(totals.scPwdDiscountC);
    expect(res.body.scPwd.vatExemptSalesC).toBe(totals.vatExemptSalesC);
    expect(res.body.scPwd.saleCount).toBe(1);
  });

  it('reports misc open-price rings and their share of net sales', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 30000 },
        { name: 'Repair fee', productId: null, qty: 1, unitPriceC: 10000 },
      ],
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.miscLines.revenueC).toBe(10000);
    expect(res.body.miscLines.pctOfNetSales).toBeCloseTo(25);
  });

  it('ranks void and refund reasons by value', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Wrong item',
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Customer changed mind',
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 50000 }],
    });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      status: 'refunded',
      statusReason: 'Damaged',
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 1, unitPriceC: 20000 }],
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.voids.count).toBe(2);
    expect(res.body.voids.valueC).toBe(60000);
    expect(res.body.voids.reasons[0]).toEqual({
      reason: 'Customer changed mind',
      count: 1,
      valueC: 50000,
    });
    expect(res.body.refunds.count).toBe(1);
    expect(res.body.refunds.valueC).toBe(20000);
  });

  it('reports over/short per closed shift, negative when short', async () => {
    const c = await ctx();
    await raw.shift.create({
      data: {
        branchId: c.branch.id,
        terminalId: c.terminalId,
        openedAt: new Date('2026-03-03T01:00:00.000Z'),
        closedAt: new Date('2026-03-03T10:00:00.000Z'),
        openingCash: 100000,
        expectedCash: 150000,
        closingCash: 149500,
      },
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.overShort).toEqual([
      expect.objectContaining({
        branchName: 'Main',
        expectedCashC: 150000,
        closingCashC: 149500,
        varianceC: -500,
      }),
    ]);
  });

  it('leaves an open shift out of over/short', async () => {
    const c = await ctx();
    await raw.shift.create({
      data: {
        branchId: c.branch.id,
        terminalId: c.terminalId,
        openedAt: new Date('2026-03-03T01:00:00.000Z'),
        openingCash: 100000,
      },
    });

    const res = await leaks(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);
    expect(res.body.overShort).toEqual([]);
  });

  it('exports leaks as CSV with a section per leak type', async () => {
    const c = await ctx();
    await seedCatalog(raw, c.business.id);

    const res = await leaks(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Discounts by name');
    expect(res.text).toContain('Over / short by shift');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: the leaks cases 404; the Task 4 cases still pass.

- [ ] **Step 3: Write the leaks SQL**

Create `src/portal/analytics/reports/leaks.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import {
  LINE_MONEY_JOINS,
  LINE_NET_C,
  completedLinesInWindow,
} from './line-money.sql';

/** Net sale value — the figure every other report calls `salesC`. */
const SALE_NET_C = Prisma.sql`(s.subtotal - s.discount - s.sc_pwd_discount)`;

function salesInWindow(
  business: ScopedBusiness,
  status: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`
    s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND ${status}
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
  `;
}

/**
 * The per-sale order-level discount.
 *
 * `s.discount` is line promos PLUS the order discount, so it cannot be
 * attributed to the order on its own. The identity that separates them:
 *
 *   Σ si.discount            = line promos + SC/PWD applied
 *   s.discount               = line promos + order discount
 *   s.sc_pwd_discount        = SC/PWD applied
 *   ⇒ order discount = (s.discount + s.sc_pwd_discount) − Σ si.discount
 *
 * Using `s.discount` directly would double-count every line promo on a sale
 * that also carried an order discount.
 */
const ORDER_DISCOUNT_C = Prisma.sql`
  (s.discount + s.sc_pwd_discount - COALESCE(items.line_discounts, 0))
`;

const LINE_DISCOUNT_LATERAL = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(si2.discount), 0) AS line_discounts
    FROM sale_items si2
    WHERE si2.sale_id = s.id AND si2.deleted_at IS NULL
  ) items ON true
`;

export interface DiscountNameRow {
  discount_id: string;
  name: string;
  kind: string;
  times_used: bigint;
  amount_c: bigint;
}

/**
 * Named discounts, counting BOTH the line-level uses (`sale_items.discount_id`)
 * and the order-level ones (`sales.discount_id`), each valued correctly.
 */
export function discountsByNameSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    WITH line_uses AS (
      SELECT si.discount_id AS discount_id,
             COUNT(*)::bigint AS uses,
             COALESCE(SUM(si.discount), 0)::bigint AS amount
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE ${completedLinesInWindow(business)}
        AND si.discount_id IS NOT NULL
      GROUP BY si.discount_id
    ),
    order_uses AS (
      SELECT s.discount_id AS discount_id,
             COUNT(*)::bigint AS uses,
             COALESCE(SUM(${ORDER_DISCOUNT_C}), 0)::bigint AS amount
      FROM sales s
      ${LINE_DISCOUNT_LATERAL}
      WHERE ${salesInWindow(business, Prisma.sql`s.status = 'completed'`)}
        AND s.discount_id IS NOT NULL
      GROUP BY s.discount_id
    ),
    combined AS (
      SELECT * FROM line_uses
      UNION ALL
      SELECT * FROM order_uses
    )
    SELECT d.id::text     AS discount_id,
           d.name         AS name,
           d.kind::text   AS kind,
           SUM(c.uses)::bigint   AS times_used,
           SUM(c.amount)::bigint AS amount_c
    FROM combined c
    JOIN discounts d ON d.id = c.discount_id
    GROUP BY d.id, d.name, d.kind
    ORDER BY amount_c DESC
  `;
}

export interface DiscountTotalsRow {
  order_level_discount_c: bigint;
  sc_pwd_discount_c: bigint;
  vat_exempt_sales_c: bigint;
  sc_pwd_sale_count: bigint;
  net_sales_c: bigint;
}

/** Sale-level leak totals, including the unattributed order-discount remainder. */
export function discountTotalsSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(${ORDER_DISCOUNT_C}), 0)::bigint      AS order_level_discount_c,
      COALESCE(SUM(s.sc_pwd_discount), 0)::bigint        AS sc_pwd_discount_c,
      COALESCE(SUM(s.vat_exempt_sales), 0)::bigint       AS vat_exempt_sales_c,
      COUNT(*) FILTER (WHERE s.sc_pwd_discount > 0)::bigint AS sc_pwd_sale_count,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint            AS net_sales_c
    FROM sales s
    ${LINE_DISCOUNT_LATERAL}
    WHERE ${salesInWindow(business, Prisma.sql`s.status = 'completed'`)}
  `;
}

export interface MiscRow {
  misc_revenue_c: bigint;
}

/** Misc open-price rings — `product_id IS NULL` (project-spec §6). */
export function miscLinesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS misc_revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NULL
  `;
}

export interface StatusReasonRow {
  reason: string | null;
  count: bigint;
  value_c: bigint;
}

/**
 * Voids or refunds grouped by their recorded reason, ranked by value. Value is
 * the net the sale WOULD have brought in — that is the size of the leak.
 */
export function voidRefundSql(
  business: ScopedBusiness,
  status: 'voided' | 'refunded',
): Prisma.Sql {
  return Prisma.sql`
    SELECT s.status_reason AS reason,
           COUNT(*)::bigint AS count,
           COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS value_c
    FROM sales s
    WHERE ${salesInWindow(business, Prisma.sql`s.status = ${status}::"SaleStatus"`)}
    GROUP BY s.status_reason
    ORDER BY value_c DESC
  `;
}

export interface OverShortRow {
  shift_id: string;
  branch_id: string;
  branch_name: string;
  closed_at: Date;
  expected_cash_c: number | null;
  closing_cash_c: number | null;
  variance_c: number | null;
}

/**
 * Over/short for shifts CLOSED inside the window. Variance is
 * `closing − expected`, so negative is short. Open shifts are excluded: they
 * have no counted cash yet, and a null variance is not a zero one.
 */
export function overShortSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT sh.id::text        AS shift_id,
           sh.branch_id::text AS branch_id,
           b.name             AS branch_name,
           sh.closed_at       AS closed_at,
           sh.expected_cash   AS expected_cash_c,
           sh.closing_cash    AS closing_cash_c,
           (sh.closing_cash - sh.expected_cash) AS variance_c
    FROM shifts sh
    JOIN branches b ON b.id = sh.branch_id
    WHERE sh.branch_id = ANY(${business.branchIds}::uuid[])
      AND sh.deleted_at IS NULL
      AND sh.closed_at IS NOT NULL
      AND sh.closed_at >= ${business.fromUtc}
      AND sh.closed_at <  ${business.toUtc}
    ORDER BY sh.closed_at DESC
  `;
}
```

- [ ] **Step 4: Write the service**

Create `src/portal/analytics/profit/leaks-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  discountTotalsSql,
  discountsByNameSql,
  miscLinesSql,
  overShortSql,
  voidRefundSql,
  type DiscountNameRow,
  type DiscountTotalsRow,
  type MiscRow,
  type OverShortRow,
  type StatusReasonRow,
} from '../reports/leaks.sql';

export interface DiscountUse {
  discountId: string;
  name: string;
  kind: string;
  timesUsed: number;
  amountC: number;
}

export interface ReasonTally {
  reason: string | null;
  count: number;
  valueC: number;
}

export interface StatusLeak {
  count: number;
  valueC: number;
  reasons: ReasonTally[];
}

export interface OverShortEntry {
  shiftId: string;
  branchId: string;
  branchName: string;
  closedAt: Date;
  expectedCashC: number | null;
  closingCashC: number | null;
  varianceC: number | null;
}

export interface LeaksReport {
  from: string;
  to: string;
  discountsByName: DiscountUse[];
  orderLevelDiscountC: number;
  scPwd: { discountC: number; vatExemptSalesC: number; saleCount: number };
  miscLines: { revenueC: number; pctOfNetSales: number | null };
  voids: StatusLeak;
  refunds: StatusLeak;
  overShort: OverShortEntry[];
}

function tally(rows: StatusReasonRow[]): StatusLeak {
  const reasons = rows.map((row) => ({
    reason: row.reason,
    count: Number(row.count),
    valueC: Number(row.value_c),
  }));
  return {
    count: reasons.reduce((sum, r) => sum + r.count, 0),
    valueC: reasons.reduce((sum, r) => sum + r.valueC, 0),
    reasons: reasons.sort((a, b) => b.valueC - a.valueC),
  };
}

/**
 * §4 Leaks — where money goes that is not profit.
 *
 * Voided and refunded sales are excluded from every other report's money
 * figures; this is the one place their value is deliberately surfaced, because
 * here the loss IS the subject.
 */
@Injectable()
export class LeaksReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<LeaksReport> {
    const scope = await this.scope.resolve(query);

    const discounts = new Map<string, DiscountUse>();
    let orderLevelDiscountC = 0;
    let scPwdDiscountC = 0;
    let vatExemptSalesC = 0;
    let scPwdSaleCount = 0;
    let netSalesC = 0;
    let miscRevenueC = 0;
    const voidRows: StatusReasonRow[] = [];
    const refundRows: StatusReasonRow[] = [];
    const overShort: OverShortEntry[] = [];

    for (const business of scope.businesses) {
      for (const row of await runScoped<DiscountNameRow>(
        this.raw,
        business,
        discountsByNameSql,
      )) {
        const current = discounts.get(row.discount_id);
        discounts.set(row.discount_id, {
          discountId: row.discount_id,
          name: row.name,
          kind: row.kind,
          timesUsed: (current?.timesUsed ?? 0) + Number(row.times_used),
          amountC: (current?.amountC ?? 0) + Number(row.amount_c),
        });
      }

      const totals = await runScopedOne<DiscountTotalsRow>(
        this.raw,
        business,
        discountTotalsSql,
      );
      orderLevelDiscountC += Number(totals.order_level_discount_c);
      scPwdDiscountC += Number(totals.sc_pwd_discount_c);
      vatExemptSalesC += Number(totals.vat_exempt_sales_c);
      scPwdSaleCount += Number(totals.sc_pwd_sale_count);
      netSalesC += Number(totals.net_sales_c);

      const misc = await runScopedOne<MiscRow>(this.raw, business, miscLinesSql);
      miscRevenueC += Number(misc.misc_revenue_c);

      voidRows.push(
        ...(await runScoped<StatusReasonRow>(this.raw, business, (b) =>
          voidRefundSql(b, 'voided'),
        )),
      );
      refundRows.push(
        ...(await runScoped<StatusReasonRow>(this.raw, business, (b) =>
          voidRefundSql(b, 'refunded'),
        )),
      );

      for (const row of await runScoped<OverShortRow>(
        this.raw,
        business,
        overShortSql,
      )) {
        overShort.push({
          shiftId: row.shift_id,
          branchId: row.branch_id,
          branchName: row.branch_name,
          closedAt: row.closed_at,
          expectedCashC: row.expected_cash_c,
          closingCashC: row.closing_cash_c,
          varianceC: row.variance_c,
        });
      }
    }

    await this.reportAudit.log(scope, 'leaks', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      discountsByName: [...discounts.values()].sort(
        (a, b) => b.amountC - a.amountC,
      ),
      orderLevelDiscountC,
      scPwd: {
        discountC: scPwdDiscountC,
        vatExemptSalesC,
        saleCount: scPwdSaleCount,
      },
      miscLines: {
        revenueC: miscRevenueC,
        // Null rather than 0 when there were no sales: "0% of nothing" is not a
        // fact about how much misc is being rung.
        pctOfNetSales: netSalesC === 0 ? null : (miscRevenueC / netSalesC) * 100,
      },
      voids: tally(voidRows),
      refunds: tally(refundRows),
      overShort: overShort.sort(
        (a, b) => b.closedAt.getTime() - a.closedAt.getTime(),
      ),
    };
  }
}
```

- [ ] **Step 5: Write the CSV builder and add the route**

Create `src/portal/analytics/profit/leaks-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { LeaksReport } from './leaks-report.service';

export function leaksCsv(report: LeaksReport): CsvSection[] {
  return [
    {
      title: 'Discounts by name',
      columns: ['Discount', 'Kind', 'Times used', 'Amount'],
      rows: report.discountsByName.map((d) => [
        d.name,
        d.kind,
        d.timesUsed,
        centavosToPesos(d.amountC),
      ]),
    },
    {
      title: 'Other giveaways',
      columns: ['Item', 'Amount'],
      rows: [
        ['Order-level discounts', centavosToPesos(report.orderLevelDiscountC)],
        ['SC/PWD discounts', centavosToPesos(report.scPwd.discountC)],
        ['VAT-exempt sales', centavosToPesos(report.scPwd.vatExemptSalesC)],
        ['Misc open-price rings', centavosToPesos(report.miscLines.revenueC)],
        [
          'Misc as % of net sales',
          report.miscLines.pctOfNetSales === null
            ? ''
            : report.miscLines.pctOfNetSales.toFixed(1),
        ],
      ],
    },
    {
      title: 'Voids by reason',
      columns: ['Reason', 'Count', 'Value'],
      rows: report.voids.reasons.map((r) => [
        r.reason ?? '(none given)',
        r.count,
        centavosToPesos(r.valueC),
      ]),
    },
    {
      title: 'Refunds by reason',
      columns: ['Reason', 'Count', 'Value'],
      rows: report.refunds.reasons.map((r) => [
        r.reason ?? '(none given)',
        r.count,
        centavosToPesos(r.valueC),
      ]),
    },
    {
      title: 'Over / short by shift',
      columns: ['Branch', 'Closed at', 'Expected cash', 'Counted cash', 'Variance'],
      rows: report.overShort.map((s) => [
        s.branchName,
        s.closedAt.toISOString(),
        centavosToPesos(s.expectedCashC),
        centavosToPesos(s.closingCashC),
        centavosToPesos(s.varianceC),
      ]),
    },
  ];
}
```

Add the route to `src/portal/analytics/profit/profit-report.controller.ts`:

```ts
  @Get('analytics/leaks')
  async leaks(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaksReport | string> {
    const report = await this.leaksReport.run(query);
    return renderReport(res, 'leaks', query, report, leaksCsv);
  }
```

injecting `private readonly leaksReport: LeaksReportService` in the constructor, and register `LeaksReportService` in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: PASS, all cases. `orderLevelDiscountC` of 8000 instead of 3000 means the order/line identity was not applied.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-profit.e2e-spec.ts
git commit -m "feat(analytics): leaks report separating order discounts from line promos"
```

---

## Task 6: Inventory movements ledger (§5)

The full movement ledger with its who and why, paginated.

**Files:**
- Create: `src/portal/analytics/reports/inventory.sql.ts`
- Create: `src/portal/analytics/dto/movements-query.dto.ts`
- Create: `src/portal/analytics/inventory/inventory-report.service.ts`
- Create: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Create: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScoped`, `runScopedOne`, `Paginated<T>` from `src/common/types/pagination`.
- Produces:
  - `movementsSql(business, filters, skip, take)`, `movementsCountSql(business, filters)`, `MovementRow`, `MovementFilters`
  - `class MovementsQueryDto extends AnalyticsQueryDto { type?: MovementType; productId?: string; page?: number; pageSize?: number }`
  - `InventoryReportService.movements(query)`
  - `GET /v1/portal/analytics/inventory/movements`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-inventory.e2e-spec.ts` with the bootstrap from `portal-analytics-products.e2e-spec.ts` (renamed `'Analytics inventory (e2e)'`), then:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const DURING = new Date('2026-03-03T04:00:00.000Z');

  const movements = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/inventory/movements?${query}`)
      .set('Authorization', `Bearer ${token}`);

  async function movement(
    branchId: string,
    productId: string,
    over: Record<string, unknown> = {},
  ) {
    return raw.stockMovement.create({
      data: {
        branchId,
        productId,
        type: 'receive',
        refId: randomUUID(),
        qtyDelta: '5',
        createdAt: DURING,
        ...over,
      },
    });
  }

  it('lists movements newest first with their product and branch names', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id, { unitCost: 15000 });

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      branchName: 'Main',
      productName: 'Beans',
      variantName: null,
      type: 'receive',
      qtyDelta: 5,
      unitCostC: 15000,
    });
  });

  it('names the variant when a movement is against one', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.latte.id, { variantId: cat.latte.variantId });

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.data[0]).toMatchObject({
      productName: 'Latte',
      variantName: 'Large',
    });
  });

  it('filters by movement type and by product', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id);
    await movement(c.branch.id, cat.latte.id, {
      type: 'adjustment',
      qtyDelta: '-2',
      reasonCategory: 'damage',
    });

    const byType = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}&type=adjustment`,
    ).expect(200);
    expect(byType.body.total).toBe(1);
    expect(byType.body.data[0].reasonCategory).toBe('damage');

    const byProduct = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}&productId=${cat.beans.id}`,
    ).expect(200);
    expect(byProduct.body.total).toBe(1);
    expect(byProduct.body.data[0].productName).toBe('Beans');
  });

  it('paginates', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    for (let i = 0; i < 3; i += 1) {
      await movement(c.branch.id, cat.beans.id);
    }

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}&page=2&pageSize=2`,
    ).expect(200);

    expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(res.body.data).toHaveLength(1);
  });

  it('rejects an unknown movement type and an oversized page', async () => {
    const c = await ctx();
    await movements(c.token, `${RANGE}&businessId=${c.business.id}&type=teleport`).expect(422);
    await movements(c.token, `${RANGE}&businessId=${c.business.id}&pageSize=500`).expect(422);
  });

  it('carries the who and why from the audit trail when one exists', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    const m = await movement(c.branch.id, cat.beans.id, {
      type: 'adjustment',
      qtyDelta: '-1',
      reasonCategory: 'theft_loss',
      note: 'Missing at count',
    });
    await raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: c.owner.id,
        ownerId: c.owner.id,
        businessId: c.business.id,
        branchId: c.branch.id,
        action: 'stock.adjust',
        entityType: 'stock_movement',
        entityId: m.id,
        changes: {},
        metadata: {},
      },
    });

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.data[0].actor).toMatchObject({
      actorType: 'owner',
      action: 'stock.adjust',
    });
    expect(res.body.data[0].note).toBe('Missing at count');
  });

  it('reports a null actor rather than inventing one when no audit row matches', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id);

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.data[0].actor).toBeNull();
  });

  it('exports the ledger as CSV', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id, { unitCost: 15000 });

    const res = await movements(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Beans');
    expect(res.text).toContain('150.00');
  });
```

Add `import { randomUUID } from 'crypto';` to the file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: 404 on every case.

- [ ] **Step 3: Write the movements SQL**

Create `src/portal/analytics/reports/inventory.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { MovementType } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

export interface MovementFilters {
  type?: MovementType;
  productId?: string;
}

function movementWhere(
  business: ScopedBusiness,
  filters: MovementFilters,
): Prisma.Sql {
  return Prisma.sql`
    sm.branch_id = ANY(${business.branchIds}::uuid[])
    AND sm.deleted_at IS NULL
    AND sm.created_at >= ${business.fromUtc}
    AND sm.created_at <  ${business.toUtc}
    ${
      filters.type
        ? Prisma.sql`AND sm.type = ${filters.type}::"MovementType"`
        : Prisma.empty
    }
    ${
      filters.productId
        ? Prisma.sql`AND sm.product_id = ${filters.productId}::uuid`
        : Prisma.empty
    }
  `;
}

export interface MovementRow {
  id: string;
  created_at: Date;
  branch_id: string;
  branch_name: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  type: string;
  qty_delta: string;
  reason_category: string | null;
  unit_cost_c: number | null;
  note: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action: string | null;
}

/**
 * The movement ledger.
 *
 * The "who and why" (project-spec §11) is not on `stock_movements` — it lives in
 * `audit_logs`, written by the tenancy choke point on every mutation. The
 * LATERAL below picks the most recent audit row whose `entity_id` is this
 * movement. There is no FK between them, so a movement without a matching row
 * reports a null actor rather than a fabricated one.
 */
export function movementsSql(
  business: ScopedBusiness,
  filters: MovementFilters,
  skip: number,
  take: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      sm.id::text          AS id,
      sm.created_at        AS created_at,
      sm.branch_id::text   AS branch_id,
      b.name               AS branch_name,
      sm.product_id::text  AS product_id,
      sm.variant_id::text  AS variant_id,
      p.name               AS product_name,
      pv.name              AS variant_name,
      sm.type::text        AS type,
      sm.qty_delta::text   AS qty_delta,
      sm.reason_category::text AS reason_category,
      sm.unit_cost         AS unit_cost_c,
      sm.note              AS note,
      al.actor_type::text  AS actor_type,
      al.actor_id::text    AS actor_id,
      al.action            AS action
    FROM stock_movements sm
    JOIN branches b ON b.id = sm.branch_id
    JOIN products p ON p.id = sm.product_id
    LEFT JOIN product_variants pv ON pv.id = sm.variant_id
    LEFT JOIN LATERAL (
      SELECT a.actor_type, a.actor_id, a.action
      FROM audit_logs a
      WHERE a.entity_id = sm.id
      ORDER BY a.created_at DESC
      LIMIT 1
    ) al ON true
    WHERE ${movementWhere(business, filters)}
    ORDER BY sm.created_at DESC, sm.id DESC
    OFFSET ${skip}
    LIMIT ${take}
  `;
}

export interface CountRow {
  total: bigint;
}

export function movementsCountSql(
  business: ScopedBusiness,
  filters: MovementFilters,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS total
    FROM stock_movements sm
    WHERE ${movementWhere(business, filters)}
  `;
}
```

- [ ] **Step 4: Write the movements DTO**

Create `src/portal/analytics/dto/movements-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { MovementType } from '@prisma/client';
import { AnalyticsQueryDto } from './analytics-query.dto';

const MOVEMENT_TYPES = [
  'sale',
  'void',
  'refund',
  'adjustment',
  'receive',
  'transfer_out',
  'transfer_in',
] as const;

export class MovementsQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  type?: MovementType;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
```

- [ ] **Step 5: Write the service**

Create `src/portal/analytics/inventory/inventory-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Paginated } from '../../../common/types/pagination';
import { MovementsQueryDto } from '../dto/movements-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  movementsCountSql,
  movementsSql,
  type CountRow,
  type MovementRow,
} from '../reports/inventory.sql';

const DEFAULT_PAGE_SIZE = 50;

export interface MovementActor {
  actorType: string;
  actorId: string | null;
  action: string;
}

export interface Movement {
  id: string;
  createdAt: Date;
  branchId: string;
  branchName: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  type: string;
  qtyDelta: number;
  reasonCategory: string | null;
  unitCostC: number | null;
  note: string | null;
  actor: MovementActor | null;
}

/**
 * §5 Inventory movements.
 *
 * Pagination is applied PER BUSINESS and the pages merged, then re-sorted and
 * re-sliced. That over-fetches (page N of each business to serve page N of the
 * whole), which is the price of per-business windows; at pilot scale it is
 * cheap, and the single-business case — the one the portal actually uses —
 * fetches exactly one page.
 */
@Injectable()
export class InventoryReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async movements(query: MovementsQueryDto): Promise<Paginated<Movement>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const filters = { type: query.type, productId: query.productId };
    const scope = await this.scope.resolve(query);

    const rows: Movement[] = [];
    let total = 0;

    for (const business of scope.businesses) {
      const counted = await runScopedOne<CountRow>(this.raw, business, (b) =>
        movementsCountSql(b, filters),
      );
      total += Number(counted.total);

      for (const row of await runScoped<MovementRow>(this.raw, business, (b) =>
        movementsSql(b, filters, (page - 1) * pageSize, pageSize),
      )) {
        rows.push({
          id: row.id,
          createdAt: row.created_at,
          branchId: row.branch_id,
          branchName: row.branch_name,
          productId: row.product_id,
          variantId: row.variant_id,
          productName: row.product_name,
          variantName: row.variant_name,
          type: row.type,
          qtyDelta: Number(row.qty_delta),
          reasonCategory: row.reason_category,
          unitCostC: row.unit_cost_c,
          note: row.note,
          actor:
            row.actor_type === null || row.action === null
              ? null
              : {
                  actorType: row.actor_type,
                  actorId: row.actor_id,
                  action: row.action,
                },
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'inventory-movements',
      query.format ?? 'json',
    );

    return {
      data: rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, pageSize),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
```

- [ ] **Step 6: Write the CSV builder and controller**

Create `src/portal/analytics/inventory/inventory-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { Paginated } from '../../../common/types/pagination';
import type { Movement } from './inventory-report.service';

export function movementsCsv(page: Paginated<Movement>): CsvSection[] {
  return [
    {
      columns: [
        'When',
        'Branch',
        'Product',
        'Variant',
        'Type',
        'Qty change',
        'Reason',
        'Unit cost',
        'Note',
        'Actor',
        'Action',
      ],
      rows: page.data.map((m) => [
        m.createdAt.toISOString(),
        m.branchName,
        m.productName,
        m.variantName,
        m.type,
        m.qtyDelta,
        m.reasonCategory,
        centavosToPesos(m.unitCostC),
        m.note,
        m.actor?.actorType ?? null,
        m.actor?.action ?? null,
      ]),
    },
  ];
}
```

Create `src/portal/analytics/inventory/inventory-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { Paginated } from '../../../common/types/pagination';
import { MovementsQueryDto } from '../dto/movements-query.dto';
import { renderReport } from '../report-response';
import { movementsCsv } from './inventory-report.csv';
import {
  InventoryReportService,
  type Movement,
} from './inventory-report.service';

/** §5 Inventory — `GET /v1/portal/analytics/inventory/*`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class InventoryReportController {
  constructor(private readonly inventory: InventoryReportService) {}

  @Get('analytics/inventory/movements')
  async movements(
    @Query() query: MovementsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Paginated<Movement> | string> {
    const page = await this.inventory.movements(query);
    return renderReport(res, 'inventory-movements', query, page, movementsCsv);
  }
}
```

Register both in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS, all cases.

- [ ] **Step 8: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(analytics): paginated stock movement ledger with its audit-trail actor"
```

---

## Task 7: Shrinkage by reason (§5)

Adjustment losses split by damage, expiry, theft/loss and count correction, valued at cost.

**Files:**
- Modify: `src/portal/analytics/reports/inventory.sql.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.service.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScoped`.
- Produces:
  - `shrinkageSql(business)`, `ShrinkageRow`
  - `interface ShrinkageReport { from, to, rows: ShrinkageEntry[] }`
  - `InventoryReportService.shrinkage(query)`
  - `GET /v1/portal/analytics/inventory/shrinkage`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/portal-analytics-inventory.e2e-spec.ts`:

```ts
  const shrinkage = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/inventory/shrinkage?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('splits adjustment losses by reason and values them at cost', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    // Beans cost 15000/unit.
    await movement(c.branch.id, cat.beans.id, {
      type: 'adjustment',
      qtyDelta: '-2',
      reasonCategory: 'damage',
    });
    await movement(c.branch.id, cat.beans.id, {
      type: 'adjustment',
      qtyDelta: '-1',
      reasonCategory: 'theft_loss',
    });

    const res = await shrinkage(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    const byReason = Object.fromEntries(
      res.body.rows.map((r: any) => [r.reasonCategory, r]),
    );
    expect(byReason.damage).toMatchObject({ units: 2, valueC: 30000 });
    expect(byReason.theft_loss).toMatchObject({ units: 1, valueC: 15000 });
  });

  it('values a variant loss at the variants own cost', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    // The Large variant costs 5000; the parent Latte costs 4000.
    await movement(c.branch.id, cat.latte.id, {
      variantId: cat.latte.variantId,
      type: 'adjustment',
      qtyDelta: '-3',
      reasonCategory: 'expiry',
    });

    const res = await shrinkage(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      reasonCategory: 'expiry',
      units: 3,
      valueC: 15000,
    });
  });

  it('counts uncosted losses in units rather than valuing them at zero', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.mystery.id, {
      type: 'adjustment',
      qtyDelta: '-4',
      reasonCategory: 'damage',
    });

    const res = await shrinkage(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    // Valuing an unknown cost at zero would report "no loss" for four lost units.
    expect(res.body.rows[0]).toMatchObject({
      reasonCategory: 'damage',
      units: 4,
      valueC: null,
      uncostedUnits: 4,
    });
  });

  it('ignores receives and positive adjustments', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id, { type: 'receive', qtyDelta: '10' });
    await movement(c.branch.id, cat.beans.id, {
      type: 'adjustment',
      qtyDelta: '5',
      reasonCategory: 'count_correction',
    });

    const res = await shrinkage(
      c.token,
      `${RANGE}&businessId=${c.business.id}`,
    ).expect(200);

    expect(res.body.rows).toEqual([]);
  });

  it('exports shrinkage as CSV', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await movement(c.branch.id, cat.beans.id, {
      type: 'adjustment',
      qtyDelta: '-2',
      reasonCategory: 'damage',
    });

    const res = await shrinkage(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.text).toContain('damage,2,300.00');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: the shrinkage cases 404.

- [ ] **Step 3: Add the shrinkage SQL**

Append to `src/portal/analytics/reports/inventory.sql.ts`:

```ts
export interface ShrinkageRow {
  reason_category: string | null;
  units: string;
  value_c: bigint;
  costed_movements: bigint;
  uncosted_units: string;
}

/**
 * Adjustment losses by reason.
 *
 * Valued at the product's (or variant's) CURRENT cost, because
 * `stock_movements` records `unit_cost` only on receives — an adjustment has no
 * cost of its own. That is an approximation, and it is the same one the spec
 * asks for; it drifts if a product's cost changes after the loss.
 *
 * A product with no cost contributes UNITS but no value. Valuing it at zero
 * would report "no loss" for goods that walked out of the door.
 */
export function shrinkageSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      sm.reason_category::text AS reason_category,
      SUM(-sm.qty_delta)::text AS units,
      COALESCE(
        SUM(round(-sm.qty_delta * cost.unit_cost))
          FILTER (WHERE cost.unit_cost IS NOT NULL), 0
      )::bigint AS value_c,
      COUNT(*) FILTER (WHERE cost.unit_cost IS NOT NULL)::bigint AS costed_movements,
      COALESCE(
        SUM(-sm.qty_delta) FILTER (WHERE cost.unit_cost IS NULL), 0
      )::text AS uncosted_units
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    LEFT JOIN product_variants pv ON pv.id = sm.variant_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(pv.cost, p.cost) AS unit_cost
    ) cost
    WHERE sm.branch_id = ANY(${business.branchIds}::uuid[])
      AND sm.deleted_at IS NULL
      AND sm.type = 'adjustment'
      AND sm.qty_delta < 0
      AND sm.created_at >= ${business.fromUtc}
      AND sm.created_at <  ${business.toUtc}
    GROUP BY sm.reason_category
    ORDER BY value_c DESC
  `;
}
```

- [ ] **Step 4: Add the service method**

In `src/portal/analytics/inventory/inventory-report.service.ts`:

```ts
export interface ShrinkageEntry {
  reasonCategory: string | null;
  units: number;
  /** Null when nothing in this reason had a recorded cost. */
  valueC: number | null;
  uncostedUnits: number;
}

export interface ShrinkageReport {
  from: string;
  to: string;
  rows: ShrinkageEntry[];
}
```

```ts
  async shrinkage(query: AnalyticsQueryDto): Promise<ShrinkageReport> {
    const scope = await this.scope.resolve(query);
    const byReason = new Map<
      string,
      { units: number; valueC: number; costed: number; uncostedUnits: number }
    >();

    for (const business of scope.businesses) {
      for (const row of await runScoped<ShrinkageRow>(
        this.raw,
        business,
        shrinkageSql,
      )) {
        const reason = row.reason_category ?? '';
        const current = byReason.get(reason) ?? {
          units: 0,
          valueC: 0,
          costed: 0,
          uncostedUnits: 0,
        };
        byReason.set(reason, {
          units: current.units + Number(row.units),
          valueC: current.valueC + Number(row.value_c),
          costed: current.costed + Number(row.costed_movements),
          uncostedUnits: current.uncostedUnits + Number(row.uncosted_units),
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'inventory-shrinkage',
      query.format ?? 'json',
    );

    return {
      from: scope.from,
      to: scope.to,
      rows: [...byReason.entries()]
        .map(([reason, r]) => ({
          reasonCategory: reason === '' ? null : reason,
          units: r.units,
          valueC: r.costed === 0 ? null : r.valueC,
          uncostedUnits: r.uncostedUnits,
        }))
        .sort((a, b) => (b.valueC ?? 0) - (a.valueC ?? 0)),
    };
  }
```

with `AnalyticsQueryDto`, `shrinkageSql` and `ShrinkageRow` imported.

- [ ] **Step 5: Add the CSV builder and the route**

Append to `src/portal/analytics/inventory/inventory-report.csv.ts`:

```ts
import type { ShrinkageReport } from './inventory-report.service';

export function shrinkageCsv(report: ShrinkageReport): CsvSection[] {
  return [
    {
      columns: ['Reason', 'Units lost', 'Value at cost', 'Uncosted units'],
      rows: report.rows.map((r) => [
        r.reasonCategory ?? '(none given)',
        r.units,
        centavosToPesos(r.valueC),
        r.uncostedUnits,
      ]),
    },
  ];
}
```

Add to the controller:

```ts
  @Get('analytics/inventory/shrinkage')
  async shrinkage(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShrinkageReport | string> {
    const report = await this.inventory.shrinkage(query);
    return renderReport(res, 'inventory-shrinkage', query, report, shrinkageCsv);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(analytics): shrinkage by reason, valuing only what has a cost"
```

---

## Task 8: Stock on hand, valuation and days of stock (§5)

What is on the shelf, what it is worth, and when it runs out.

**Files:**
- Modify: `src/portal/analytics/reports/inventory.sql.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.service.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScoped`, `ResolvedScope.dayCount`.
- Produces:
  - `onHandSql(business)`, `OnHandRow`
  - `interface OnHandReport { from, to, rows: OnHandEntry[], totals: { valueC, uncostedItems } }`
  - `InventoryReportService.onHand(query)`
  - `GET /v1/portal/analytics/inventory/on-hand`

- [ ] **Step 1: Write the failing e2e tests**

Append to `test/portal-analytics-inventory.e2e-spec.ts`:

```ts
  const onHand = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/inventory/on-hand?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('reports quantity and value at cost per branch', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: { branchId: c.branch.id, productId: cat.beans.id, qty: '12' },
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      branchName: 'Main',
      name: 'Beans',
      qty: 12,
      unitCostC: 15000,
      valueC: 180000,
    });
    expect(res.body.totals.valueC).toBe(180000);
  });

  it('reports an uncosted product with a null value and counts it', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: { branchId: c.branch.id, productId: cat.mystery.id, qty: '5' },
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.rows[0]).toMatchObject({ qty: 5, unitCostC: null, valueC: null });
    expect(res.body.totals.valueC).toBe(0);
    expect(res.body.totals.uncostedItems).toBe(1);
  });

  it('flags a product at or below its low-stock threshold', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.createMany({
      data: [
        { branchId: c.branch.id, productId: cat.beans.id, qty: '10' },
        { branchId: c.branch.id, productId: cat.mystery.id, qty: '1' },
      ],
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    const beans = res.body.rows.find((r: any) => r.name === 'Beans');
    // Beans' threshold is 10 and qty is 10 — "at" the threshold counts as low.
    expect(beans.isLow).toBe(true);
    const mystery = res.body.rows.find((r: any) => r.name === 'Mystery Blend');
    // No threshold set: unmonitored, which is not the same as low.
    expect(mystery.lowStockThreshold).toBeNull();
    expect(mystery.isLow).toBe(false);
  });

  it('estimates days of stock from the trailing sales rate', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: { branchId: c.branch.id, productId: cat.beans.id, qty: '14' },
    });
    // 7 units over the 7-day range = 1/day, against 14 on hand = 14 days.
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Beans', productId: cat.beans.id, qty: 7, unitPriceC: 25000 }],
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.rows[0].daysOfStock).toBeCloseTo(14);
  });

  it('reports days of stock as null when nothing sold, not infinity', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: { branchId: c.branch.id, productId: cat.beans.id, qty: '14' },
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.rows[0].daysOfStock).toBeNull();
  });

  it('tracks a variant separately from its parent', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: {
        branchId: c.branch.id,
        productId: cat.latte.id,
        variantId: cat.latte.variantId,
        qty: '4',
      },
    });

    const res = await onHand(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      name: 'Latte — Large',
      qty: 4,
      unitCostC: 5000,
      valueC: 20000,
    });
  });

  it('exports on-hand as CSV with a totals section', async () => {
    const c = await ctx();
    const cat = await seedCatalog(raw, c.business.id);
    await raw.branchStock.create({
      data: { branchId: c.branch.id, productId: cat.beans.id, qty: '2' },
    });

    const res = await onHand(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.text).toContain('Beans');
    expect(res.text).toContain('Total value');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: the on-hand cases 404.

- [ ] **Step 3: Add the on-hand SQL**

Append to `src/portal/analytics/reports/inventory.sql.ts`:

```ts
export interface OnHandRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  qty: string;
  unit_cost_c: number | null;
  low_stock_threshold: string | null;
  sold_units: string;
}

/**
 * Stock on hand, with the units sold in the window beside it so the caller can
 * derive a days-of-stock estimate.
 *
 * `IS NOT DISTINCT FROM` matches the variant column NULL-to-NULL: a
 * variant-less product's stock row must pair with its variant-less sale lines,
 * and plain `=` would never match two NULLs.
 */
export function onHandSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      bs.branch_id::text  AS branch_id,
      b.name              AS branch_name,
      bs.product_id::text AS product_id,
      bs.variant_id::text AS variant_id,
      p.name              AS product_name,
      pv.name             AS variant_name,
      bs.qty::text        AS qty,
      COALESCE(pv.cost, p.cost)     AS unit_cost_c,
      p.low_stock_threshold::text   AS low_stock_threshold,
      COALESCE(sold.units, 0)::text AS sold_units
    FROM branch_stock bs
    JOIN branches b ON b.id = bs.branch_id
    JOIN products p ON p.id = bs.product_id
    LEFT JOIN product_variants pv ON pv.id = bs.variant_id
    LEFT JOIN LATERAL (
      SELECT SUM(si.qty) AS units
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE si.product_id = bs.product_id
        AND si.variant_id IS NOT DISTINCT FROM bs.variant_id
        AND s.branch_id = bs.branch_id
        AND si.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.status = 'completed'
        AND s.created_at >= ${business.fromUtc}
        AND s.created_at <  ${business.toUtc}
    ) sold ON true
    WHERE bs.branch_id = ANY(${business.branchIds}::uuid[])
      AND bs.deleted_at IS NULL
      AND p.deleted_at IS NULL
    ORDER BY b.name ASC, p.name ASC, pv.name ASC NULLS FIRST
  `;
}
```

- [ ] **Step 4: Add the service method**

In `src/portal/analytics/inventory/inventory-report.service.ts`:

```ts
export interface OnHandEntry {
  branchId: string;
  branchName: string;
  productId: string;
  variantId: string | null;
  name: string;
  qty: number;
  unitCostC: number | null;
  valueC: number | null;
  lowStockThreshold: number | null;
  isLow: boolean;
  /** Null when nothing sold in the range — an infinite runway is not a number. */
  daysOfStock: number | null;
}

export interface OnHandReport {
  from: string;
  to: string;
  rows: OnHandEntry[];
  totals: { valueC: number; uncostedItems: number };
}
```

```ts
  async onHand(query: AnalyticsQueryDto): Promise<OnHandReport> {
    const scope = await this.scope.resolve(query);
    const rows: OnHandEntry[] = [];

    for (const business of scope.businesses) {
      for (const row of await runScoped<OnHandRow>(
        this.raw,
        business,
        onHandSql,
      )) {
        const qty = Number(row.qty);
        const unitCostC = row.unit_cost_c;
        const threshold =
          row.low_stock_threshold === null
            ? null
            : Number(row.low_stock_threshold);
        const soldUnits = Number(row.sold_units);

        rows.push({
          branchId: row.branch_id,
          branchName: row.branch_name,
          productId: row.product_id,
          variantId: row.variant_id,
          name:
            row.variant_name === null
              ? row.product_name
              : `${row.product_name} — ${row.variant_name}`,
          qty,
          unitCostC,
          valueC: unitCostC === null ? null : Math.round(qty * unitCostC),
          lowStockThreshold: threshold,
          // "At" the threshold counts as low — that is when to reorder, not after.
          isLow: threshold !== null && qty <= threshold,
          daysOfStock:
            soldUnits === 0 ? null : qty / (soldUnits / scope.dayCount),
        });
      }
    }

    await this.reportAudit.log(
      scope,
      'inventory-on-hand',
      query.format ?? 'json',
    );

    return {
      from: scope.from,
      to: scope.to,
      rows,
      totals: {
        valueC: rows.reduce((sum, r) => sum + (r.valueC ?? 0), 0),
        uncostedItems: rows.filter((r) => r.valueC === null).length,
      },
    };
  }
```

with `onHandSql` and `OnHandRow` imported.

- [ ] **Step 5: Add the CSV builder and the route**

Append to `src/portal/analytics/inventory/inventory-report.csv.ts`:

```ts
import type { OnHandReport } from './inventory-report.service';

export function onHandCsv(report: OnHandReport): CsvSection[] {
  return [
    {
      columns: [
        'Branch',
        'Item',
        'Quantity',
        'Unit cost',
        'Value',
        'Low-stock threshold',
        'Low',
        'Days of stock',
      ],
      rows: report.rows.map((r) => [
        r.branchName,
        r.name,
        r.qty,
        centavosToPesos(r.unitCostC),
        centavosToPesos(r.valueC),
        r.lowStockThreshold,
        r.isLow ? 'yes' : 'no',
        r.daysOfStock === null ? '' : r.daysOfStock.toFixed(1),
      ]),
    },
    {
      title: 'Totals',
      columns: ['Total value', 'Items with no cost recorded'],
      rows: [
        [centavosToPesos(report.totals.valueC), report.totals.uncostedItems],
      ],
    },
  ];
}
```

Add to the controller:

```ts
  @Get('analytics/inventory/on-hand')
  async onHand(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OnHandReport | string> {
    const report = await this.inventory.onHand(query);
    return renderReport(res, 'inventory-on-hand', query, report, onHandCsv);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(analytics): stock on hand with valuation, low-stock flag and days of stock"
```

---

## Task 9: Extend the tenancy sweep and verify the whole suite

`test/portal-analytics-tenancy.e2e-spec.ts` carries the comment "Every report endpoint, so a new one cannot be added without a decision." This task is that decision, for all eight new endpoints.

**Files:**
- Modify: `test/portal-analytics-tenancy.e2e-spec.ts`

**Interfaces:**
- Consumes: every endpoint from Tasks 1–8.
- Produces: nothing — no source files change.

- [ ] **Step 1: Add the new endpoints to the sweep**

In `test/portal-analytics-tenancy.e2e-spec.ts`, extend `ENDPOINTS`:

```ts
/** Every report endpoint, so a new one cannot be added without a decision. */
const ENDPOINTS = [
  'analytics/overview',
  'analytics/sales/heatmap',
  'analytics/sales/trend',
  'analytics/sales/patterns',
  'analytics/sales/breakdowns',
  'analytics/tax',
  'analytics/products/top',
  'analytics/products/slow',
  'analytics/profit',
  'analytics/leaks',
  'analytics/inventory/movements',
  'analytics/inventory/shrinkage',
  'analytics/inventory/on-hand',
];
```

`analytics/products/:productId/trend` is not in this list because it takes a path parameter; it gets its own case below.

- [ ] **Step 2: Add a tenancy case for the per-product trend**

Append inside the same describe block:

```ts
  it('404s on a per-product trend for another owners product', async () => {
    const mine = await ownerCtx();
    const theirs = await ownerCtx();
    const category = await raw.category.create({
      data: { businessId: theirs.business.id, name: 'Theirs' },
    });
    const product = await raw.product.create({
      data: {
        businessId: theirs.business.id,
        categoryId: category.id,
        name: 'Not yours',
        price: 1000,
      },
    });

    await request(server())
      .get(
        `/v1/portal/analytics/products/${product.id}/trend?from=${RANGE.from}&to=${RANGE.to}&businessId=${mine.business.id}`,
      )
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(404);
  });
```

Use whatever the file already names its per-owner context helper in place of `ownerCtx` if it differs.

- [ ] **Step 3: Run the tenancy sweep**

```bash
npm run test:e2e -- portal-analytics-tenancy
```

Expected: PASS. A failure here means a new report's SQL lost its `branch_id` predicate or its ownership check — fix the source, never the assertion.

- [ ] **Step 4: Run everything**

```bash
npm test && npm run test:e2e && npm run lint && npm run build
```

Expected: all unit suites pass, all e2e suites pass, lint reports no errors, build clean.

- [ ] **Step 5: Verify the routes are actually registered**

```bash
grep -rn "@Get(" src/portal/analytics/*/*.controller.ts
```

Expected: 15 routes — the 7 from plan 1 plus `products/top`, `products/slow`, `products/:productId/trend`, `profit`, `leaks`, `inventory/movements`, `inventory/shrinkage`, `inventory/on-hand`.

- [ ] **Step 6: Commit**

```bash
git add test/portal-analytics-tenancy.e2e-spec.ts
git commit -m "test(analytics): extend the tenancy sweep to the product, profit and inventory reports"
```

---

## Self-review notes

**Spec coverage.** §3 top → Task 1; §3 slow + zeroSales → Task 2; §3 per-product trend → Task 3; §4 profit → Task 4; §4 leaks → Task 5; §5 movements → Task 6; §5 shrinkage → Task 7; §5 on-hand/valuation/days-of-stock → Task 8. The three §5 items the spec defers to sub-project B (expiring soon, stock-take history, transfer history) are absent by design — the features that write their data do not exist.

**Deliberate deviations, recorded so they are not read as bugs.**
1. `LeaksReportService` lives in the `profit/` folder and shares the `ProfitReportController`, rather than getting a folder of its own. §4 is one spec section and one portal tab; two folders for one tab would be filing, not structure.
2. Misc open-price lines are excluded from §3 rankings (they are not products) and reported in §4 leaks instead. The spec implies this; it is stated explicitly here because a reader could expect them in the product list.
3. Shrinkage values losses at the product's *current* cost — `stock_movements` records `unit_cost` only on receives, so an adjustment has no cost of its own. This is what the spec asks for and it drifts if cost changes after the loss.
4. Category rollups use the product's *live* category, since `sale_items` snapshots no category. Re-categorising a product moves its history.
5. `/analytics/inventory/movements` paginates per business and merges, which over-fetches in a multi-business scope. Per-business windows make a single global query impossible; the single-business case the portal uses fetches exactly one page.

**Interface consistency.** `LINE_MONEY_JOINS`/`LINE_NET_C`/`LINE_COST_C`/`completedLinesInWindow` are produced in Task 1 and used in Tasks 3, 4, 5. `marginOf` is produced in Task 1 and used in Tasks 1, 3, 4. `toProductRow`/`productColumns`/`productRowCells` are produced in Task 1 and reused in Task 2. `bucketExpr` is exported in Task 3 and used in Task 4's `profitOverTimeSql` — **Task 4 therefore depends on Task 3 and must not be reordered before it.** `movementWhere` and the `inventory.sql.ts` module are created in Task 6 and extended in Tasks 7 and 8. `InventoryReportService` is created in Task 6 and extended in Tasks 7 and 8.

**Task order is a dependency order.** 1 → 2 → 3 → 4 → 5, and 6 → 7 → 8, with 9 last. Tasks 1–5 and 6–8 are independent of each other and could run in parallel by two workers; 9 needs all of them.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-06-analytics-product-profit-inventory.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

