# Analytics: Product, Profit & Inventory Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the analytics section with §3 products sold, §4 profit & leaks, and §5 inventory movements — reusing the foundation shipped in plan 1 without adding any new infrastructure.

**Architecture:** New SQL builders under `reports/`, three new report services, three new controllers, all standing on the existing `AnalyticsScopeService` → `runScoped()` → `renderReport()` pipeline. No migrations, no changes to plan 1's shared code except adding to `analytics.module.ts` and the tenancy sweep.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest unit (`rootDir: src`) + Jest e2e (`test/*.e2e-spec.ts`, real Postgres), supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-portal-analytics-and-dashboard-design.md` §3, §4, §5. Plan 2 of 2; plan 1 (`2026-09-06-analytics-money-reports.md`) shipped §0, §1, §2, §6.

## Global Constraints

Every task's requirements implicitly include all of these. The first five are inherited from plan 1 and are already enforced by existing code — do not re-litigate them.

- **Integer centavos for money.** SQL casts money aggregates to `::bigint`; convert with `Number(...)` at the edge. Money fields end in `C`.
- **Quantities are `::float8`, money never is.** `qty` is `DECIMAL(10,3)`; `$queryRaw` would hand back a `Prisma.Decimal` object. Units are for ranking and display, and 3 decimal places are exact in float64, so quantities cast to `float8` and arrive as JS numbers. Money stays integer centavos and never touches a float.
- **A null cost is `null`, never `0`.** Reuse `grossProfitC()` / `marginPct()` from `overview/overview.math.ts` — they already return `null` when `costedLines === 0`.
- **Margins and percentages are FRACTIONS, not percentages.** `marginPct()` returns `0.4` for 40%, and `toKpi().changePct` likewise. Every new ratio field follows that convention; the portal multiplies.
- **Line revenue must add modifier prices back.** `sale_items.unit_price` is the base price; priced modifiers live in the `modifiers` jsonb with their own `priceDeltaC`. Copy the two `CROSS JOIN LATERAL` blocks from `reports/sales-aggregate.sql.ts` (`mods` then `line`) into every new line-level query. `qty * unit_price` alone is wrong.
- **Every analytics query goes through `runScoped()` / `runScopedOne()`** from `scoped-sql.ts`, which refuses SQL whose text lacks `branch_id`. Raw SQL bypasses the tenancy choke point; the branch ids from `AnalyticsScopeService` are the only scope it gets.
- **Every report queries per business and merges in TypeScript** — `dayStartTime` differs per business.
- **Voided sales contribute to no money figure and no transaction count; refunded sales contribute to no money figure but are counted.** §4 reports their values as leaks, which is the one place their money is deliberately surfaced.
- **Misc (open-price) lines have `product_id IS NULL`.** They are excluded from every §3 product report and from §4's per-product/per-category rollups, and surface only as §4's `miscLines`. Product reports therefore do not sum to net sales, by design.
- **Validation failures are 422 `validation`; a named id that is not the caller's is 404 `not_found`.** An owned business with no branches yields a zeroed 200.
- **Routes** are `@Controller('portal')` + `@UseGuards(PortalAuthGuard)` under the `v1` global prefix.
- **Sensitive reads** call `ReportAuditService.log(scope, name, format)`.
- **Never add a Claude co-author trailer. Never run `git push`.** Commit directly on `main`.

**Commands:** `npm test`, `npm run test:e2e` (needs `docker compose up -d db`), `npm run lint`, `npm run build`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/portal/analytics/reports/product-sales.sql.ts` | Per-product / per-category / per-variant sold aggregates and the zero-sales anti-join. |
| `src/portal/analytics/reports/leaks.sql.ts` | Discount attribution, SC/PWD, misc lines, void/refund reasons, over/short. |
| `src/portal/analytics/reports/inventory.sql.ts` | Movement ledger, shrinkage, stock on hand. |
| `src/portal/analytics/dto/product-report-query.dto.ts` | `by`, `limit` for §3. |
| `src/portal/analytics/dto/movements-query.dto.ts` | `type`, `productId`, `page`, `pageSize` for §5. |
| `src/portal/analytics/products/products-report.service.ts` | §3 computation. |
| `src/portal/analytics/products/products-report.controller.ts` | §3 routes. |
| `src/portal/analytics/products/products-report.csv.ts` | §3 CSV sections. |
| `src/portal/analytics/profit/profit-report.service.ts` | §4 profit computation. |
| `src/portal/analytics/profit/leaks-report.service.ts` | §4 leaks computation. |
| `src/portal/analytics/profit/profit-report.controller.ts` | §4 routes. |
| `src/portal/analytics/profit/profit-report.csv.ts` | §4 CSV sections. |
| `src/portal/analytics/inventory/inventory-report.service.ts` | §5 computation. |
| `src/portal/analytics/inventory/inventory-report.controller.ts` | §5 routes. |
| `src/portal/analytics/inventory/inventory-report.csv.ts` | §5 CSV sections. |
| `src/portal/analytics/inventory/days-of-stock.ts` | Pure days-of-stock / valuation maths. |
| `src/portal/analytics/inventory/days-of-stock.spec.ts` | Unit tests for the above. |
| `test/portal-analytics-products.e2e-spec.ts` | §3. |
| `test/portal-analytics-profit.e2e-spec.ts` | §4. |
| `test/portal-analytics-inventory.e2e-spec.ts` | §5. |

**Modified:**

| File | Change |
|---|---|
| `src/portal/analytics/analytics.module.ts` | Register three controllers and four services. |
| `test/portal-analytics-tenancy.e2e-spec.ts` | Add the seven new endpoints to `ENDPOINTS`. |

---

## Task 1: Product sales SQL and top / slow sellers (§3)

The "what sells" and "restock-or-retire" lists. This task also builds the per-product aggregate every §4 rollup reuses.

**Files:**
- Create: `src/portal/analytics/reports/product-sales.sql.ts`
- Create: `src/portal/analytics/dto/product-report-query.dto.ts`
- Create: `src/portal/analytics/products/products-report.service.ts`
- Create: `src/portal/analytics/products/products-report.controller.ts`
- Create: `src/portal/analytics/products/products-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-products.e2e-spec.ts`

**Interfaces:**
- Consumes: `ScopedBusiness`, `ResolvedScope`, `AnalyticsScopeService.resolve` (`scope/analytics-scope.service.ts`); `runScoped` (`scoped-sql.ts`); `renderReport` (`report-response.ts`); `ReportAuditService.log`; `centavosToPesos`, `CsvSection` (`csv.ts`); `grossProfitC`, `marginPct` (`overview/overview.math.ts`).
- Produces:
  - `LINE_MONEY_JOINS`/`LINE_NET_C`/`LINE_COST_C` (shared, in `reports/line-money.sql.ts`) — the two shared lateral blocks, exported for §4 to reuse
  - `productSalesSql(business): Prisma.Sql`, `ProductSalesRow`
  - `categorySalesSql(business): Prisma.Sql`, `CategorySalesRow`
  - `zeroSalesSql(business): Prisma.Sql`, `ZeroSalesRow`
  - `class ProductReportQueryDto extends AnalyticsQueryDto { by?: 'units' | 'revenue'; limit?: number }`
  - `interface SoldRow { productId; variantId; name; units; revenueC; grossProfitC; marginPct }`
  - `ProductsReportService.top(query)`, `.slow(query)`
  - `GET /v1/portal/analytics/products/top`, `GET /v1/portal/analytics/products/slow`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-products.e2e-spec.ts`. Copy the imports, `beforeAll`/`afterAll`/`beforeEach` bootstrap and the `seedTenant()` helper verbatim from `test/portal-analytics-overview.e2e-spec.ts`, renaming the describe to `'Portal analytics — products (e2e)'`. Then add a product fixture helper and these cases:

```ts
  const RANGE = { from: '2026-03-01', to: '2026-03-07' };
  const DURING = new Date('2026-03-02T02:00:00.000Z');

  async function seedProduct(
    businessId: string,
    name: string,
    over: Record<string, unknown> = {},
  ) {
    const category = await raw.category.upsert({
      where: { id: (over.categoryId as string) ?? '00000000-0000-0000-0000-000000000000' },
      create: { businessId, name: 'Grocery' },
      update: {},
    });
    return raw.product.create({
      data: {
        businessId,
        categoryId: category.id,
        name,
        price: 10000,
        ...over,
      },
    });
  }

  const top = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/products/top')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  const slow = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/products/slow')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('ranks by units sold, adding modifier prices into revenue', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    const bun = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Bun', price: 3000 },
    });

    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          productId: latte.id,
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
        { name: 'Bun', productId: bun.id, qty: 5, unitPriceC: 3000, costC: 1000 },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId, by: 'units' }).expect(200);

    expect(res.body.rows[0]).toMatchObject({ productId: bun.id, units: 5 });
    const latteRow = res.body.rows.find((r: any) => r.productId === latte.id);
    // 2 x (12000 + 2000) = 28000, not 2 x 12000.
    expect(latteRow.revenueC).toBe(28000);
    expect(latteRow.grossProfitC).toBe(20000);
  });

  it('ranks by revenue when asked', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    const bun = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Bun', price: 3000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 },
        { name: 'Bun', productId: bun.id, qty: 5, unitPriceC: 3000 },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId, by: 'revenue' }).expect(200);
    expect(res.body.rows[0].productId).toBe(latte.id);
  });

  it('rolls up categories alongside the product rows', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 }],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.categories).toEqual([
      expect.objectContaining({ categoryId: category.id, name: 'Coffee', units: 2, revenueC: 24000 }),
    ]);
  });

  it('reports margin as null for an uncosted product, never zero', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const tea = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Tea', price: 5000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Tea', productId: tea.id, qty: 1, unitPriceC: 5000, costC: null }],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].grossProfitC).toBeNull();
    expect(res.body.rows[0].marginPct).toBeNull();
  });

  it('names a deleted product from the sale-time snapshot', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const gone = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Retired', price: 5000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Retired blend', productId: gone.id, qty: 1, unitPriceC: 5000 }],
    });
    await raw.product.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].name).toBe('Retired blend');
  });

  it('reports each variant on its own row', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    const large = await raw.productVariant.create({
      data: { productId: latte.id, name: 'Large', price: 14000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Latte', productId: latte.id, qty: 1, unitPriceC: 12000 },
        { name: 'Latte — Large', productId: latte.id, variantId: large.id, qty: 1, unitPriceC: 14000 },
      ],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    const variantRow = res.body.rows.find((r: any) => r.variantId === large.id);
    expect(variantRow.revenueC).toBe(14000);
    expect(res.body.rows).toHaveLength(2);
  });

  it('leaves misc lines out of the product report entirely', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Open item', productId: null, qty: 1, unitPriceC: 9900 }],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('excludes voided sales', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      lines: [{ name: 'Latte', productId: latte.id, qty: 3, unitPriceC: 12000 }],
    });

    const res = await top(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('honours the limit', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    for (const name of ['A', 'B', 'C']) {
      const p = await raw.product.create({
        data: { businessId: t.businessId, categoryId: category.id, name, price: 5000 },
      });
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: DURING,
        lines: [{ name, productId: p.id, qty: 1, unitPriceC: 5000 }],
      });
    }

    const res = await top(t.token, { businessId: t.businessId, limit: '2' }).expect(200);
    expect(res.body.rows).toHaveLength(2);
  });

  it('rejects a limit outside 1..100 with 422', async () => {
    const t = await seedTenant();
    await top(t.token, { businessId: t.businessId, limit: '0' }).expect(422);
    await top(t.token, { businessId: t.businessId, limit: '101' }).expect(422);
  });

  it('rejects an unknown sort key with 422', async () => {
    const t = await seedTenant();
    await top(t.token, { businessId: t.businessId, by: 'profit' }).expect(422);
  });

  it('lists the worst sellers and the products that sold nothing', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const sold = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Sold', price: 5000 },
    });
    const never = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Never', price: 5000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Sold', productId: sold.id, qty: 1, unitPriceC: 5000 }],
    });

    const res = await slow(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.bottom[0].productId).toBe(sold.id);
    expect(res.body.zeroSales).toEqual([
      expect.objectContaining({ productId: never.id, name: 'Never', categoryName: 'Coffee' }),
    ]);
  });

  it('leaves archived products out of the zero-sales list', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    await raw.product.create({
      data: {
        businessId: t.businessId,
        categoryId: category.id,
        name: 'Archived',
        price: 5000,
        active: false,
      },
    });

    const res = await slow(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.zeroSales).toEqual([]);
  });

  it('exports as CSV', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000 }],
    });

    const res = await top(t.token, { businessId: t.businessId, format: 'csv' }).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Latte,2,240.00');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose up -d db
npm run test:e2e -- portal-analytics-products
```

Expected: every case 404s — the routes do not exist yet.

- [ ] **Step 3: Write the SQL builders**

Create `src/portal/analytics/reports/product-sales.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Per-product sold aggregates (analytics-spec §3), and the per-category rollup
 * and zero-sales anti-join that go with them.
 *
 * MISC LINES ARE EXCLUDED. An open-price line has `product_id IS NULL`; it is a
 * sale but not a product, and including it would put "Open item" at the top of
 * a catalogue report. It surfaces in §4's `miscLines` instead. The consequence
 * is deliberate: product revenue does NOT sum to net sales.
 *
 * Rows are keyed by (product_id, variant_id) because a variant is what actually
 * sells — a "Latte" total that merges Small and Large answers no question worth
 * asking. Names come from `name_snapshot`, so a product archived since the sale
 * still reports under the name it sold as.
 *
 * Quantities cast to `float8`: `qty` is DECIMAL(10,3) and Prisma would return a
 * Decimal object. Three decimal places are exact in float64 and these are
 * ranking/display figures. Money stays integer centavos.
 */

The modifier-aware line arithmetic and the completed-lines predicate already
live in `src/portal/analytics/reports/line-money.sql.ts` — import them rather
than writing a second copy:

```ts
import {
  LINE_COST_C,
  LINE_MONEY_JOINS,
  LINE_NET_C,
  completedLinesInWindow,
} from './line-money.sql';
```

export interface ProductSalesRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  units: number;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

export function productSalesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      si.product_id::text AS product_id,
      si.variant_id::text AS variant_id,
      (ARRAY_AGG(si.name_snapshot ORDER BY s.created_at DESC))[1] AS name,
      COALESCE(SUM(si.qty), 0)::float8 AS units,
      COALESCE(SUM(line.net_c), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY si.product_id, si.variant_id
  `;
}

export interface CategorySalesRow {
  category_id: string;
  name: string;
  units: number;
  revenue_c: bigint;
}

export function categorySalesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id::text AS category_id,
      c.name     AS name,
      COALESCE(SUM(si.qty), 0)::float8 AS units,
      COALESCE(SUM(line.net_c), 0)::bigint AS revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    JOIN categories c ON c.id = p.category_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY c.id, c.name
  `;
}

export interface ZeroSalesRow {
  product_id: string;
  name: string;
  category_name: string;
}

/**
 * Active products with no sale in the window — the restock-or-retire list.
 *
 * The `branch_id` predicate lives in the NOT EXISTS subquery, which is what the
 * `runScoped` tripwire looks for and is genuinely where the scope belongs: the
 * outer list is products of this business, the inner check is "did it sell in
 * these branches". Archived (`active = false`) products are excluded — they were
 * retired on purpose and do not need retiring again.
 */
export function zeroSalesSql(business: ScopedBusiness): Prisma.Sql {
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
          AND s.branch_id = ANY(${business.branchIds}::uuid[])
          AND s.deleted_at IS NULL
          AND si.deleted_at IS NULL
          AND s.status = 'completed'
          AND s.created_at >= ${business.fromUtc}
          AND s.created_at <  ${business.toUtc}
      )
    ORDER BY p.name ASC
  `;
}
```

- [ ] **Step 4: Write the query DTO**

Create `src/portal/analytics/dto/product-report-query.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class ProductReportQueryDto extends AnalyticsQueryDto {
  /** Ranking key. Defaults to `units`. */
  @IsOptional()
  @IsIn(['units', 'revenue'])
  by?: 'units' | 'revenue';

  /** 1–100, default 20. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
```

- [ ] **Step 5: Write the service**

Create `src/portal/analytics/products/products-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import { grossProfitC, marginPct } from '../overview/overview.math';
import {
  categorySalesSql,
  productSalesSql,
  zeroSalesSql,
  type CategorySalesRow,
  type ProductSalesRow,
  type ZeroSalesRow,
} from '../reports/product-sales.sql';

const DEFAULT_LIMIT = 20;

export interface SoldRow {
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
  by: 'units' | 'revenue';
  rows: SoldRow[];
  categories: CategoryRow[];
}

export interface SlowProductsReport {
  from: string;
  to: string;
  bottom: SoldRow[];
  zeroSales: { productId: string; name: string; categoryName: string }[];
}

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

/**
 * §3 Products (sold).
 *
 * Rows are keyed by `productId:variantId` across businesses — the same product
 * id cannot exist in two businesses, so the key is globally safe and merging is
 * just addition.
 *
 * Profit reuses `overview.math`: a row whose lines carried no cost reports
 * `null` margin, never a zero that would read as 100%.
 */
@Injectable()
export class ProductsReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async top(query: ProductReportQueryDto): Promise<TopProductsReport> {
    const scope = await this.scope.resolve(query);
    const by = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;

    const sold = await this.sold(scope.businesses);
    const categories = new Map<string, CategoryRow>();
    for (const business of scope.businesses) {
      for (const row of await runScoped<CategorySalesRow>(
        this.raw,
        business,
        categorySalesSql,
      )) {
        const current = categories.get(row.category_id);
        if (current) {
          current.units += row.units;
          current.revenueC += Number(row.revenue_c);
        } else {
          categories.set(row.category_id, {
            categoryId: row.category_id,
            name: row.name,
            units: row.units,
            revenueC: Number(row.revenue_c),
          });
        }
      }
    }

    await this.reportAudit.log(scope, 'products-top', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      by,
      rows: rank(sold, by, 'desc').slice(0, limit),
      categories: [...categories.values()].sort((a, b) => b.revenueC - a.revenueC),
    };
  }

  async slow(query: ProductReportQueryDto): Promise<SlowProductsReport> {
    const scope = await this.scope.resolve(query);
    const by = query.by ?? 'units';
    const limit = query.limit ?? DEFAULT_LIMIT;

    const sold = await this.sold(scope.businesses);

    const zeroSales: SlowProductsReport['zeroSales'] = [];
    for (const business of scope.businesses) {
      for (const row of await runScoped<ZeroSalesRow>(
        this.raw,
        business,
        zeroSalesSql,
      )) {
        zeroSales.push({
          productId: row.product_id,
          name: row.name,
          categoryName: row.category_name,
        });
      }
    }

    await this.reportAudit.log(scope, 'products-slow', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      bottom: rank(sold, by, 'asc').slice(0, limit),
      zeroSales,
    };
  }

  private async sold(
    businesses: { branchIds: string[] }[] & Parameters<typeof runScoped>[1][],
  ): Promise<Accumulated[]> {
    const merged = new Map<string, Accumulated>();

    for (const business of businesses) {
      for (const row of await runScoped<ProductSalesRow>(
        this.raw,
        business,
        productSalesSql,
      )) {
        const key = `${row.product_id}:${row.variant_id ?? ''}`;
        const current = merged.get(key);
        const add: Accumulated = {
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
          units: row.units,
          revenueC: Number(row.revenue_c),
          costedLines: Number(row.costed_lines),
          costedRevenueC: Number(row.costed_revenue_c),
          costedCostC: Number(row.costed_cost_c),
        };
        if (!current) {
          merged.set(key, add);
        } else {
          current.units += add.units;
          current.revenueC += add.revenueC;
          current.costedLines += add.costedLines;
          current.costedRevenueC += add.costedRevenueC;
          current.costedCostC += add.costedCostC;
        }
      }
    }

    return [...merged.values()];
  }
}

/**
 * `overview.math`'s profit helpers take the same shape these rows carry, so a
 * row's margin is computed by exactly the code the overview card uses.
 */
function toSoldRow(row: Accumulated): SoldRow {
  const totals = {
    grossSalesC: 0,
    discountsC: 0,
    serviceChargeC: 0,
    transactions: 0,
    voidCount: 0,
    refundCount: 0,
    costedLines: row.costedLines,
    costedRevenueC: row.costedRevenueC,
    costedCostC: row.costedCostC,
    uncostedRevenueC: 0,
  };
  return {
    productId: row.productId,
    variantId: row.variantId,
    name: row.name,
    units: row.units,
    revenueC: row.revenueC,
    grossProfitC: grossProfitC(totals),
    marginPct: marginPct(totals),
  };
}

function rank(
  rows: Accumulated[],
  by: 'units' | 'revenue',
  direction: 'asc' | 'desc',
): SoldRow[] {
  const sorted = [...rows].sort((a, b) => {
    const left = by === 'units' ? a.units : a.revenueC;
    const right = by === 'units' ? b.units : b.revenueC;
    return direction === 'desc' ? right - left : left - right;
  });
  return sorted.map(toSoldRow);
}
```

If the `sold()` parameter type above fights the compiler, type it as
`private async sold(businesses: ScopedBusiness[]): Promise<Accumulated[]>` and
import `ScopedBusiness` from `../scope/analytics-scope.service` — that is the
intended signature; the inline form above is only shorthand.

- [ ] **Step 6: Write the CSV builder**

Create `src/portal/analytics/products/products-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type {
  SlowProductsReport,
  SoldRow,
  TopProductsReport,
} from './products-report.service';

const soldColumns = ['Product', 'Units', 'Revenue', 'Gross profit', 'Margin'];

const soldRows = (rows: SoldRow[]) =>
  rows.map((r) => [
    r.name,
    r.units,
    centavosToPesos(r.revenueC),
    centavosToPesos(r.grossProfitC),
    r.marginPct === null ? '' : (r.marginPct * 100).toFixed(1),
  ]);

export function topProductsCsv(report: TopProductsReport): CsvSection[] {
  return [
    { columns: soldColumns, rows: soldRows(report.rows) },
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

export function slowProductsCsv(report: SlowProductsReport): CsvSection[] {
  return [
    { columns: soldColumns, rows: soldRows(report.bottom) },
    {
      title: 'No sales in this period',
      columns: ['Product', 'Category'],
      rows: report.zeroSales.map((z) => [z.name, z.categoryName]),
    },
  ];
}
```

- [ ] **Step 7: Write the controller and register it**

Create `src/portal/analytics/products/products-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { ProductReportQueryDto } from '../dto/product-report-query.dto';
import { renderReport } from '../report-response';
import { slowProductsCsv, topProductsCsv } from './products-report.csv';
import {
  ProductsReportService,
  type SlowProductsReport,
  type TopProductsReport,
} from './products-report.service';

/** §3 Products sold — `GET /v1/portal/analytics/products/{top,slow}`. */
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

  @Get('analytics/products/slow')
  async slow(
    @Query() query: ProductReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SlowProductsReport | string> {
    const report = await this.products.slow(query);
    return renderReport(res, 'products-slow', query, report, slowProductsCsv);
  }
}
```

In `src/portal/analytics/analytics.module.ts` add `ProductsReportController` to `controllers` and `ProductsReportService` to `providers`, with the matching imports.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: PASS. If a Latte row reads 24000 instead of 28000, `LINE_MONEY_JOINS` is missing from that query.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-products.e2e-spec.ts
git commit -m "feat(api): top and slow product sellers with category rollups"
```

---

## Task 2: Per-product trend (§3)

Units, revenue and margin over time for one product — the drill-down from the top-sellers list.

**Files:**
- Modify: `src/portal/analytics/reports/sales-series.sql.ts` (export the bucket expression)
- Modify: `src/portal/analytics/reports/product-sales.sql.ts` (add `productTrendSql`)
- Modify: `src/portal/analytics/products/products-report.service.ts`
- Modify: `src/portal/analytics/products/products-report.controller.ts`
- Modify: `src/portal/analytics/products/products-report.csv.ts`
- Test: `test/portal-analytics-products.e2e-spec.ts`

**Interfaces:**
- Consumes: `SalesTrendQueryDto` (`dto/sales-trend-query.dto.ts`), `Granularity`, `SCOPED_PRISMA`.
- Produces:
  - `bucketExpr(business, granularity): Prisma.Sql` — exported from `sales-series.sql.ts`
  - `productTrendSql(business, productId, granularity): Prisma.Sql`, `ProductTrendRow`
  - `ProductsReportService.trend(productId, query)`
  - `GET /v1/portal/analytics/products/:productId/trend`

- [ ] **Step 1: Write the failing tests**

Append to `test/portal-analytics-products.e2e-spec.ts`:

```ts
  const trend = (token: string, productId: string, query: Record<string, string> = {}) =>
    request(server())
      .get(`/v1/portal/analytics/products/${productId}/trend`)
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('reports one product units, revenue and margin per bucket', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000, costC: 4000 }],
    });

    const res = await trend(t.token, latte.id, {
      businessId: t.businessId,
      granularity: 'day',
    }).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-02');
    expect(day).toMatchObject({ units: 2, revenueC: 24000, grossProfitC: 16000 });
    // Margins are FRACTIONS, matching overview.math.
    expect(day.marginPct).toBeCloseTo(16000 / 24000);
  });

  it('zero-fills days with no sales of that product', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });

    const res = await trend(t.token, latte.id, {
      businessId: t.businessId,
      granularity: 'day',
    }).expect(200);

    expect(res.body.buckets).toHaveLength(7);
    expect(res.body.buckets[0]).toEqual({
      bucket: '2026-03-01',
      units: 0,
      revenueC: 0,
      grossProfitC: null,
      marginPct: null,
    });
  });

  it('404s for a product the caller does not own', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: theirs.businessId, name: 'Coffee' },
    });
    const notMine = await raw.product.create({
      data: { businessId: theirs.businessId, categoryId: category.id, name: 'X', price: 100 },
    });

    await trend(mine.token, notMine.id, { businessId: mine.businessId }).expect(404);
  });

  it('422s on a productId that is not a uuid', async () => {
    const t = await seedTenant();
    await trend(t.token, 'not-a-uuid', { businessId: t.businessId }).expect(422);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: the four new cases fail with 404 (no route); the Task 1 cases still pass.

- [ ] **Step 3: Export the bucket expression from the series builder**

In `src/portal/analytics/reports/sales-series.sql.ts`, rename the private `truncated` to an exported `bucketExpr` and update its two internal call sites (`trendSalesSql`, `trendLinesSql`):

```ts
/**
 * The bucket a sale falls in, at the requested granularity. `date_trunc` on the
 * business-day date, so weeks start Monday as §2 asks.
 *
 * Exported because §3's per-product trend and §4's profit-over-time bucket
 * exactly the same way — three reports disagreeing about what a "week" is would
 * be a bug nobody could see.
 */
export function bucketExpr(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  if (granularity === 'day') return dayBucketExpr(business);
  return Prisma.sql`(date_trunc(${granularity}, ${dayBucketExpr(business)}::timestamp)::date)`;
}
```

- [ ] **Step 4: Add the per-product trend SQL**

Append to `src/portal/analytics/reports/product-sales.sql.ts`:

```ts
import { bucketExpr, type Granularity } from './sales-series.sql';

export interface ProductTrendRow {
  bucket: Date;
  units: number;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * One product's sales per bucket, variants included — the drill-down from the
 * top-sellers list, where the question is "how is this product doing", not
 * "how is this SKU doing".
 */
export function productTrendSql(
  business: ScopedBusiness,
  productId: string,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${bucketExpr(business, granularity)} AS bucket,
      COALESCE(SUM(si.qty), 0)::float8 AS units,
      COALESCE(SUM(line.net_c), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedLinesInWindow(business)}
      AND si.product_id = ${productId}::uuid
    GROUP BY 1
  `;
}
```

- [ ] **Step 5: Add the service method**

Add to `ProductsReportService` (inject `@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma` in the constructor):

```ts
export interface ProductTrendBucket {
  bucket: string;
  units: number;
  revenueC: number;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProductTrendReport {
  productId: string;
  from: string;
  to: string;
  granularity: Granularity;
  buckets: ProductTrendBucket[];
}
```

```ts
  /**
   * Ownership is enforced by the SCOPED client, not by a business-id match: the
   * choke point already filters products to the caller's businesses, so a
   * product that comes back null is either missing or somebody else's, and both
   * answer 404 without leaking which.
   */
  async trend(
    productId: string,
    query: SalesTrendQueryDto,
  ): Promise<ProductTrendReport> {
    const owned = await this.scoped.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundError('Product not found.');

    const scope = await this.scope.resolve(query);
    const granularity = query.granularity ?? 'day';

    const merged = new Map<
      string,
      { units: number; revenueC: number; costedLines: number; costedRevenueC: number; costedCostC: number }
    >();

    for (const business of scope.businesses) {
      for (const row of await runScoped<ProductTrendRow>(this.raw, business, (b) =>
        productTrendSql(b, productId, granularity),
      )) {
        const key = row.bucket.toISOString().slice(0, 10);
        const current = merged.get(key) ?? {
          units: 0,
          revenueC: 0,
          costedLines: 0,
          costedRevenueC: 0,
          costedCostC: 0,
        };
        merged.set(key, {
          units: current.units + row.units,
          revenueC: current.revenueC + Number(row.revenue_c),
          costedLines: current.costedLines + Number(row.costed_lines),
          costedRevenueC: current.costedRevenueC + Number(row.costed_revenue_c),
          costedCostC: current.costedCostC + Number(row.costed_cost_c),
        });
      }
    }

    // Day granularity zero-fills from the requested range so a gap reads as a
    // gap; coarser buckets come from the data, where a partial week at the edge
    // would otherwise look like a quiet one.
    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...merged.keys()].sort();

    await this.reportAudit.log(scope, 'product-trend', query.format ?? 'json');

    return {
      productId,
      from: scope.from,
      to: scope.to,
      granularity,
      buckets: keys.map((bucket) => {
        const row = merged.get(bucket);
        const totals = {
          grossSalesC: 0,
          discountsC: 0,
          serviceChargeC: 0,
          transactions: 0,
          voidCount: 0,
          refundCount: 0,
          costedLines: row?.costedLines ?? 0,
          costedRevenueC: row?.costedRevenueC ?? 0,
          costedCostC: row?.costedCostC ?? 0,
          uncostedRevenueC: 0,
        };
        return {
          bucket,
          units: row?.units ?? 0,
          revenueC: row?.revenueC ?? 0,
          grossProfitC: grossProfitC(totals),
          marginPct: marginPct(totals),
        };
      }),
    };
  }
```

Add the imports it needs: `Inject` from `@nestjs/common`, `SCOPED_PRISMA`/`ScopedPrisma` from `../../../prisma/scoped-prisma.provider`, `NotFoundError` from `../../../common/errors/api-errors`, `businessDaySeries` from `../scope/business-day`, `SalesTrendQueryDto` from `../dto/sales-trend-query.dto`, and `productTrendSql`/`ProductTrendRow`/`Granularity`.

- [ ] **Step 6: Add the route and CSV**

In the controller:

```ts
  @Get('analytics/products/:productId/trend')
  async trend(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductTrendReport | string> {
    const report = await this.products.trend(productId, query);
    return renderReport(res, 'product-trend', query, report, productTrendCsv);
  }
```

`ParseUUIDPipe` throws a 400 by default, and this codebase renders validation as 422 — pass the status explicitly:
`@Param('productId', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }))`.

In the CSV module:

```ts
export function productTrendCsv(report: ProductTrendReport): CsvSection[] {
  return [
    {
      columns: ['Bucket', 'Units', 'Revenue', 'Gross profit', 'Margin'],
      rows: report.buckets.map((b) => [
        b.bucket,
        b.units,
        centavosToPesos(b.revenueC),
        centavosToPesos(b.grossProfitC),
        b.marginPct === null ? '' : (b.marginPct * 100).toFixed(1),
      ]),
    },
  ];
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-products
```

Expected: PASS, whole file.

- [ ] **Step 8: Commit**

```bash
git add src/portal/analytics test/portal-analytics-products.e2e-spec.ts
git commit -m "feat(api): per-product sales trend with shared bucket expression"
```

---

## Task 3: Profit report (§4)

Profit over time, by product and by category, with an explicit statement of how much revenue the profit figure covers.

**Files:**
- Modify: `src/portal/analytics/reports/product-sales.sql.ts` (add costed columns to `categorySalesSql`)
- Create: `src/portal/analytics/profit/profit-report.service.ts`
- Create: `src/portal/analytics/profit/profit-report.controller.ts`
- Create: `src/portal/analytics/profit/profit-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-profit.e2e-spec.ts`

**Interfaces:**
- Consumes: `productSalesSql`, `categorySalesSql`, `trendLinesSql`/`TrendProfitRow` (`sales-series.sql.ts`), `lineAggregateSql`/`LineAggregateRow` (`sales-aggregate.sql.ts`), `grossProfitC`, `marginPct`, `runScoped`, `runScopedOne`.
- Produces:
  - `interface ProfitReport { from; to; granularity; overTime; byProduct; byCategory; costedRevenueC; uncostedRevenueC }`
  - `ProfitReportService.run(query: SalesTrendQueryDto)`
  - `GET /v1/portal/analytics/profit`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-profit.e2e-spec.ts` with the standard bootstrap and `seedTenant()`, describe `'Portal analytics — profit & leaks (e2e)'`, then:

```ts
  const profit = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/profit')
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

  it('reports profit over time, by product and by category', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const latte = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Latte', price: 12000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', productId: latte.id, qty: 2, unitPriceC: 12000, costC: 4000 }],
    });

    const res = await profit(t.token, { businessId: t.businessId }).expect(200);

    const day = res.body.overTime.find((b: any) => b.bucket === '2026-03-02');
    expect(day.grossProfitC).toBe(16000);
    expect(res.body.byProduct[0]).toMatchObject({
      productId: latte.id,
      revenueC: 24000,
      costC: 8000,
      grossProfitC: 16000,
    });
    expect(res.body.byCategory[0]).toMatchObject({
      categoryId: category.id,
      revenueC: 24000,
      grossProfitC: 16000,
    });
  });

  it('says how much of the revenue the profit figure covers', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const costed = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Costed', price: 10000 },
    });
    const uncosted = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Uncosted', price: 5000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Costed', productId: costed.id, qty: 1, unitPriceC: 10000, costC: 6000 },
        { name: 'Uncosted', productId: uncosted.id, qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const res = await profit(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.costedRevenueC).toBe(10000);
    expect(res.body.uncostedRevenueC).toBe(5000);

    const unknown = res.body.byProduct.find((p: any) => p.productId === uncosted.id);
    // Unknown, not zero — the whole point of the null-cost rule.
    expect(unknown.costC).toBeNull();
    expect(unknown.grossProfitC).toBeNull();
    expect(unknown.marginPct).toBeNull();
  });

  it('exports profit as CSV with an empty margin for unknown cost', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Coffee' },
    });
    const uncosted = await raw.product.create({
      data: { businessId: t.businessId, categoryId: category.id, name: 'Uncosted', price: 5000 },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Uncosted', productId: uncosted.id, qty: 1, unitPriceC: 5000, costC: null }],
    });

    const res = await profit(t.token, {
      businessId: t.businessId,
      format: 'csv',
    }).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Uncosted,50.00,,,');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: 404 on every case.

- [ ] **Step 3: Add costed columns to the category rollup**

In `src/portal/analytics/reports/product-sales.sql.ts`, extend `CategorySalesRow` and `categorySalesSql` so §4 can compute category margin from the same query §3 already uses for units and revenue. Task 1's consumer simply ignores the extra columns:

```ts
export interface CategorySalesRow {
  category_id: string;
  name: string;
  units: number;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}
```

Add to the SELECT list of `categorySalesSql`, before `FROM`:

```sql
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
```

- [ ] **Step 4: Write the service**

Create `src/portal/analytics/profit/profit-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import { grossProfitC, marginPct } from '../overview/overview.math';
import {
  lineAggregateSql,
  type LineAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  trendLinesSql,
  type Granularity,
  type TrendProfitRow,
} from '../reports/sales-series.sql';
import {
  categorySalesSql,
  productSalesSql,
  type CategorySalesRow,
  type ProductSalesRow,
} from '../reports/product-sales.sql';

export interface MarginRow {
  revenueC: number;
  costC: number | null;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProductMarginRow extends MarginRow {
  productId: string;
  variantId: string | null;
  name: string;
}

export interface CategoryMarginRow extends MarginRow {
  categoryId: string;
  name: string;
}

export interface ProfitBucket {
  bucket: string;
  grossProfitC: number | null;
  marginPct: number | null;
}

export interface ProfitReport {
  from: string;
  to: string;
  granularity: Granularity;
  overTime: ProfitBucket[];
  byProduct: ProductMarginRow[];
  byCategory: CategoryMarginRow[];
  costedRevenueC: number;
  uncostedRevenueC: number;
}

interface Costed {
  revenueC: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
}

/** Pad a costed tally into the shape `overview.math` expects. */
function asTotals(c: Costed) {
  return {
    grossSalesC: 0,
    discountsC: 0,
    serviceChargeC: 0,
    transactions: 0,
    voidCount: 0,
    refundCount: 0,
    costedLines: c.costedLines,
    costedRevenueC: c.costedRevenueC,
    costedCostC: c.costedCostC,
    uncostedRevenueC: 0,
  };
}

function toMarginRow(c: Costed): MarginRow {
  const totals = asTotals(c);
  return {
    revenueC: c.revenueC,
    // Cost is UNKNOWN, not zero, when no line in the group carried one.
    costC: c.costedLines === 0 ? null : c.costedCostC,
    grossProfitC: grossProfitC(totals),
    marginPct: marginPct(totals),
  };
}

function accumulate<T extends Costed>(
  into: Map<string, T>,
  key: string,
  make: () => T,
  add: Costed,
): void {
  const current = into.get(key) ?? make();
  current.revenueC += add.revenueC;
  current.costedLines += add.costedLines;
  current.costedRevenueC += add.costedRevenueC;
  current.costedCostC += add.costedCostC;
  into.set(key, current);
}

/**
 * §4 Profit.
 *
 * Every margin here comes from `overview.math`, so a product's margin, a
 * category's margin and the overview card's margin are computed by one
 * function. A cost that was never recorded reports `null` at every level — the
 * report says "unknown", and the portal renders an em dash.
 */
@Injectable()
export class ProfitReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: SalesTrendQueryDto): Promise<ProfitReport> {
    const scope = await this.scope.resolve(query);
    const granularity = query.granularity ?? 'day';

    const overTime = new Map<string, Costed>();
    const byProduct = new Map<string, ProductMarginRow & Costed>();
    const byCategory = new Map<string, CategoryMarginRow & Costed>();
    let costedRevenueC = 0;
    let uncostedRevenueC = 0;

    for (const business of scope.businesses) {
      for (const row of await runScoped<TrendProfitRow>(this.raw, business, (b) =>
        trendLinesSql(b, granularity),
      )) {
        const key = row.bucket.toISOString().slice(0, 10);
        accumulate(
          overTime,
          key,
          () => ({ revenueC: 0, costedLines: 0, costedRevenueC: 0, costedCostC: 0 }),
          {
            revenueC: 0,
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          },
        );
      }

      for (const row of await runScoped<ProductSalesRow>(
        this.raw,
        business,
        productSalesSql,
      )) {
        accumulate(
          byProduct,
          `${row.product_id}:${row.variant_id ?? ''}`,
          () => ({
            productId: row.product_id,
            variantId: row.variant_id,
            name: row.name,
            revenueC: 0,
            costC: null,
            grossProfitC: null,
            marginPct: null,
            costedLines: 0,
            costedRevenueC: 0,
            costedCostC: 0,
          }),
          {
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          },
        );
      }

      for (const row of await runScoped<CategorySalesRow>(
        this.raw,
        business,
        categorySalesSql,
      )) {
        accumulate(
          byCategory,
          row.category_id,
          () => ({
            categoryId: row.category_id,
            name: row.name,
            revenueC: 0,
            costC: null,
            grossProfitC: null,
            marginPct: null,
            costedLines: 0,
            costedRevenueC: 0,
            costedCostC: 0,
          }),
          {
            revenueC: Number(row.revenue_c),
            costedLines: Number(row.costed_lines),
            costedRevenueC: Number(row.costed_revenue_c),
            costedCostC: Number(row.costed_cost_c),
          },
        );
      }

      const totals = await runScopedOne<LineAggregateRow>(this.raw, business, (b) =>
        lineAggregateSql(b, b.fromUtc, b.toUtc),
      );
      costedRevenueC += Number(totals.costed_revenue_c);
      uncostedRevenueC += Number(totals.uncosted_revenue_c);
    }

    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...overTime.keys()].sort();

    await this.reportAudit.log(scope, 'profit', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      granularity,
      overTime: keys.map((bucket) => {
        const totals = asTotals(
          overTime.get(bucket) ?? {
            revenueC: 0,
            costedLines: 0,
            costedRevenueC: 0,
            costedCostC: 0,
          },
        );
        return {
          bucket,
          grossProfitC: grossProfitC(totals),
          marginPct: marginPct(totals),
        };
      }),
      byProduct: [...byProduct.values()]
        .map((row) => ({ ...row, ...toMarginRow(row) }))
        .sort((a, b) => b.revenueC - a.revenueC),
      byCategory: [...byCategory.values()]
        .map((row) => ({ ...row, ...toMarginRow(row) }))
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
import type { MarginRow, ProfitReport } from './profit-report.service';

const margin = (m: MarginRow) => [
  centavosToPesos(m.revenueC),
  centavosToPesos(m.costC),
  centavosToPesos(m.grossProfitC),
  m.marginPct === null ? '' : (m.marginPct * 100).toFixed(1),
];

export function profitCsv(report: ProfitReport): CsvSection[] {
  return [
    {
      title: 'Over time',
      columns: ['Bucket', 'Gross profit', 'Margin'],
      rows: report.overTime.map((b) => [
        b.bucket,
        centavosToPesos(b.grossProfitC),
        b.marginPct === null ? '' : (b.marginPct * 100).toFixed(1),
      ]),
    },
    {
      title: 'By product',
      columns: ['Product', 'Revenue', 'Cost', 'Gross profit', 'Margin'],
      rows: report.byProduct.map((p) => [p.name, ...margin(p)]),
    },
    {
      title: 'By category',
      columns: ['Category', 'Revenue', 'Cost', 'Gross profit', 'Margin'],
      rows: report.byCategory.map((c) => [c.name, ...margin(c)]),
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

Create `src/portal/analytics/profit/profit-report.controller.ts` with a `GET analytics/profit` handler following the exact shape of `TaxReportController`, calling `renderReport(res, 'profit', query, report, profitCsv)` and taking `SalesTrendQueryDto`. Register `ProfitReportController` and `ProfitReportService` in `analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-profit.e2e-spec.ts
git commit -m "feat(api): profit report over time, by product and by category"
```

---

## Task 4: Leaks report (§4)

Where the money goes that isn't cost: discounts, SC/PWD, misc rings, voids, refunds, and drawer variance.

**Files:**
- Create: `src/portal/analytics/reports/leaks.sql.ts`
- Create: `src/portal/analytics/profit/leaks-report.service.ts`
- Modify: `src/portal/analytics/profit/profit-report.controller.ts`
- Modify: `src/portal/analytics/profit/profit-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-profit.e2e-spec.ts`

**Interfaces:**
- Consumes: `LINE_MONEY_JOINS`/`LINE_NET_C`/`LINE_COST_C` (shared, in `reports/line-money.sql.ts`) (Task 1); `salesAggregateSql` (`sales-aggregate.sql.ts`); `runScoped`, `runScopedOne`.
- Produces:
  - `discountTotalsSql`, `lineDiscountsSql`, `orderDiscountsSql`, `miscLinesSql`, `statusValueSql`, `overShortSql` with their row types
  - `interface LeaksReport`
  - `LeaksReportService.run(query: AnalyticsQueryDto)`
  - `GET /v1/portal/analytics/leaks`

- [ ] **Step 1: Write the failing e2e test**

Append to `test/portal-analytics-profit.e2e-spec.ts`:

```ts
  const leaks = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/leaks')
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

  it('attributes a named line discount to its name', async () => {
    const t = await seedTenant();
    const discount = await raw.discount.create({
      data: {
        businessId: t.businessId,
        name: 'Staff 10%',
        kind: 'percent',
        value: 10,
        appliesTo: 'line',
      },
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          name: 'Latte',
          qty: 1,
          unitPriceC: 10000,
          discount: {
            source: 'named',
            discountId: discount.id,
            name: 'Staff 10%',
            kind: 'percent',
            value: 10,
          },
        },
      ],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.discountsByName).toEqual([
      expect.objectContaining({
        discountId: discount.id,
        name: 'Staff 10%',
        timesUsed: 1,
        amountC: 1000,
      }),
    ]);
  });

  it('reports the order-level discount as the unattributed remainder', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 10000 }],
      orderDiscount: { source: 'free', kind: 'fixed', value: 2500 },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    // sales.discount carries line promos PLUS the order discount; no line
    // discount here, so the whole 2500 is order-level.
    expect(res.body.orderLevelDiscountC).toBe(2500);
  });

  it('reports SC/PWD discount, VAT-exempt sales and the sale count', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [{ name: 'Meal', qty: 1, unitPriceC: 10000, scPwdMarked: true }],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.scPwd.saleCount).toBe(1);
    expect(res.body.scPwd.discountC).toBeGreaterThan(0);
    expect(res.body.scPwd.vatExemptSalesC).toBeGreaterThan(0);
  });

  it('reports misc rings as a share of net sales', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { name: 'Open item', productId: null, qty: 1, unitPriceC: 2500 },
        { name: 'Latte', qty: 1, unitPriceC: 7500 },
      ],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.miscLines.revenueC).toBe(2500);
    // A FRACTION, like every other ratio in these reports.
    expect(res.body.miscLines.pctOfNetSales).toBeCloseTo(0.25);
  });

  it('ranks void and refund reasons by value', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Wrong order',
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'voided',
      statusReason: 'Customer left',
      lines: [{ name: 'Latte', qty: 5, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      status: 'refunded',
      statusReason: 'Spoiled',
      lines: [{ name: 'Latte', qty: 1, unitPriceC: 20000 }],
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.voids.count).toBe(2);
    expect(res.body.voids.valueC).toBe(60000);
    expect(res.body.voids.reasons[0]).toMatchObject({
      reason: 'Customer left',
      valueC: 50000,
    });
    expect(res.body.refunds).toMatchObject({ count: 1, valueC: 20000 });
  });

  it('reports over/short per closed shift, negative meaning short', async () => {
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date('2026-03-02T00:00:00.000Z'),
        closedAt: new Date('2026-03-02T10:00:00.000Z'),
        openingCash: 100000,
        expectedCash: 150000,
        closingCash: 149500,
      },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

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
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date('2026-03-02T00:00:00.000Z'),
        openingCash: 100000,
      },
    });

    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.overShort).toEqual([]);
  });

  it('reports zero and empty rather than failing on a quiet period', async () => {
    const t = await seedTenant();
    const res = await leaks(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.orderLevelDiscountC).toBe(0);
    expect(res.body.miscLines).toEqual({ revenueC: 0, pctOfNetSales: null });
    expect(res.body.voids).toEqual({ count: 0, valueC: 0, reasons: [] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: the leaks cases 404; the Task 3 cases still pass.

- [ ] **Step 3: Write the leaks SQL**

Create `src/portal/analytics/reports/leaks.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import { LINE_MONEY_JOINS, LINE_NET_C } from './line-money.sql';

/**
 * The leaks queries (analytics-spec §4).
 *
 * Discount attribution is the subtle part. From the totals engine:
 *   `sales.discount`        = line promos PLUS the order-level discount
 *   `sales.sc_pwd_discount` = the SC/PWD amounts
 *   `sale_items.discount`   = whatever was applied to that line (promo OR
 *                             SC/PWD — the higher wins, never both)
 *
 * So Σ line promos = Σ `sale_items.discount` − Σ `sales.sc_pwd_discount`, and
 * the order-level amount is `sales.discount` minus that. It is derived rather
 * than stored because the engine never writes it down separately; getting this
 * wrong double-counts every order discount.
 */

const COMPLETED = (business: ScopedBusiness): Prisma.Sql => Prisma.sql`
  s.branch_id = ANY(${business.branchIds}::uuid[])
  AND s.deleted_at IS NULL
  AND s.status = 'completed'
  AND s.created_at >= ${business.fromUtc}
  AND s.created_at <  ${business.toUtc}
`;

/** Per-sale sum of its line discounts, for the order-level derivation. */
const LINE_DISCOUNTS_LATERAL = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(si.discount), 0) AS line_discounts
    FROM sale_items si
    WHERE si.sale_id = s.id AND si.deleted_at IS NULL
  ) li
`;

export interface DiscountTotalsRow {
  sale_discount_c: bigint;
  line_discount_c: bigint;
  sc_pwd_discount_c: bigint;
  vat_exempt_sales_c: bigint;
  sc_pwd_sales: bigint;
  net_sales_c: bigint;
}

export function discountTotalsSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(s.discount), 0)::bigint          AS sale_discount_c,
      COALESCE(SUM(li.line_discounts), 0)::bigint   AS line_discount_c,
      COALESCE(SUM(s.sc_pwd_discount), 0)::bigint   AS sc_pwd_discount_c,
      COALESCE(SUM(s.vat_exempt_sales), 0)::bigint  AS vat_exempt_sales_c,
      COUNT(*) FILTER (WHERE s.sc_pwd IS NOT NULL)::bigint AS sc_pwd_sales,
      COALESCE(SUM(s.subtotal - s.discount - s.sc_pwd_discount), 0)::bigint AS net_sales_c
    FROM sales s
    ${LINE_DISCOUNTS_LATERAL}
    WHERE ${COMPLETED(business)}
  `;
}

export interface NamedDiscountRow {
  discount_id: string;
  name: string;
  kind: string;
  times_used: bigint;
  amount_c: bigint;
}

/**
 * Named discounts applied at LINE level. `sale_items.discount_id` is set only
 * when the applied discount was a named promo (`sales.service.ts:496`), so
 * `sale_items.discount` on those rows is exactly the promo amount.
 */
export function lineDiscountsSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT d.id::text AS discount_id, d.name AS name, d.kind::text AS kind,
           COUNT(*)::bigint AS times_used,
           COALESCE(SUM(si.discount), 0)::bigint AS amount_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN discounts d ON d.id = si.discount_id
    WHERE ${COMPLETED(business)}
      AND si.deleted_at IS NULL
    GROUP BY 1, 2, 3
  `;
}

/** Named discounts applied at ORDER level, using the derived remainder. */
export function orderDiscountsSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT d.id::text AS discount_id, d.name AS name, d.kind::text AS kind,
           COUNT(*)::bigint AS times_used,
           COALESCE(SUM(s.discount - (li.line_discounts - s.sc_pwd_discount)), 0)::bigint
             AS amount_c
    FROM sales s
    JOIN discounts d ON d.id = s.discount_id
    ${LINE_DISCOUNTS_LATERAL}
    WHERE ${COMPLETED(business)}
    GROUP BY 1, 2, 3
  `;
}

export interface MiscLinesRow {
  revenue_c: bigint;
}

/** Open-price lines — `product_id IS NULL` is what makes a line "misc". */
export function miscLinesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(SUM(line.net_c), 0)::bigint AS revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${COMPLETED(business)}
      AND si.deleted_at IS NULL
      AND si.product_id IS NULL
  `;
}

export interface StatusValueRow {
  status: string;
  reason: string;
  count: bigint;
  value_c: bigint;
}

/**
 * Voided and refunded sales with their reasons. This is the one report where
 * their money is deliberately surfaced — everywhere else they are excluded.
 */
export function statusValueSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT s.status::text AS status,
           COALESCE(NULLIF(s.status_reason, ''), '(no reason given)') AS reason,
           COUNT(*)::bigint AS count,
           COALESCE(SUM(s.subtotal - s.discount - s.sc_pwd_discount), 0)::bigint AS value_c
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.status IN ('voided', 'refunded')
      AND s.created_at >= ${business.fromUtc}
      AND s.created_at <  ${business.toUtc}
    GROUP BY 1, 2
  `;
}

export interface OverShortRow {
  shift_id: string;
  branch_id: string;
  branch_name: string;
  closed_at: Date;
  expected_cash: number | null;
  closing_cash: number | null;
}

/**
 * Closed shifts and their drawer variance.
 *
 * Windowed on `closed_at`, not `created_at`: a shift belongs to the period it
 * was counted in, and a shift opened on the 6th and closed on the 7th is the
 * 7th's variance.
 */
export function overShortSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT sh.id::text AS shift_id,
           sh.branch_id::text AS branch_id,
           b.name AS branch_name,
           sh.closed_at AS closed_at,
           sh.expected_cash AS expected_cash,
           sh.closing_cash AS closing_cash
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

- [ ] **Step 4: Write the leaks service**

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
  lineDiscountsSql,
  miscLinesSql,
  orderDiscountsSql,
  overShortSql,
  statusValueSql,
  type DiscountTotalsRow,
  type MiscLinesRow,
  type NamedDiscountRow,
  type OverShortRow,
  type StatusValueRow,
} from '../reports/leaks.sql';

export interface NamedDiscount {
  discountId: string;
  name: string;
  kind: string;
  timesUsed: number;
  amountC: number;
}

export interface StatusBucket {
  count: number;
  valueC: number;
  reasons: { reason: string; count: number; valueC: number }[];
}

export interface LeaksReport {
  from: string;
  to: string;
  discountsByName: NamedDiscount[];
  orderLevelDiscountC: number;
  scPwd: { discountC: number; vatExemptSalesC: number; saleCount: number };
  miscLines: { revenueC: number; pctOfNetSales: number | null };
  voids: StatusBucket;
  refunds: StatusBucket;
  overShort: {
    shiftId: string;
    branchId: string;
    branchName: string;
    closedAt: Date;
    expectedCashC: number | null;
    closingCashC: number | null;
    varianceC: number | null;
  }[];
}

function emptyBucket(): StatusBucket {
  return { count: 0, valueC: 0, reasons: [] };
}

/**
 * §4 Leaks.
 *
 * `pctOfNetSales` is `null` rather than `0` when there were no net sales: a
 * ratio with nothing underneath it is not zero, it is undefined, and the portal
 * shows an em dash. Same reasoning as the null-cost rule.
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

    const named = new Map<string, NamedDiscount>();
    const voidReasons = new Map<string, { count: number; valueC: number }>();
    const refundReasons = new Map<string, { count: number; valueC: number }>();
    const overShort: LeaksReport['overShort'] = [];

    let orderLevelDiscountC = 0;
    let scPwdDiscountC = 0;
    let vatExemptSalesC = 0;
    let scPwdSales = 0;
    let miscRevenueC = 0;
    let netSalesC = 0;

    for (const business of scope.businesses) {
      const totals = await runScopedOne<DiscountTotalsRow>(
        this.raw,
        business,
        discountTotalsSql,
      );
      const linePromos =
        Number(totals.line_discount_c) - Number(totals.sc_pwd_discount_c);
      orderLevelDiscountC += Number(totals.sale_discount_c) - linePromos;
      scPwdDiscountC += Number(totals.sc_pwd_discount_c);
      vatExemptSalesC += Number(totals.vat_exempt_sales_c);
      scPwdSales += Number(totals.sc_pwd_sales);
      netSalesC += Number(totals.net_sales_c);

      const misc = await runScopedOne<MiscLinesRow>(
        this.raw,
        business,
        miscLinesSql,
      );
      miscRevenueC += Number(misc.revenue_c);

      for (const sql of [lineDiscountsSql, orderDiscountsSql]) {
        for (const row of await runScoped<NamedDiscountRow>(
          this.raw,
          business,
          sql,
        )) {
          const current = named.get(row.discount_id);
          if (current) {
            current.timesUsed += Number(row.times_used);
            current.amountC += Number(row.amount_c);
          } else {
            named.set(row.discount_id, {
              discountId: row.discount_id,
              name: row.name,
              kind: row.kind,
              timesUsed: Number(row.times_used),
              amountC: Number(row.amount_c),
            });
          }
        }
      }

      for (const row of await runScoped<StatusValueRow>(
        this.raw,
        business,
        statusValueSql,
      )) {
        const target = row.status === 'voided' ? voidReasons : refundReasons;
        const current = target.get(row.reason) ?? { count: 0, valueC: 0 };
        target.set(row.reason, {
          count: current.count + Number(row.count),
          valueC: current.valueC + Number(row.value_c),
        });
      }

      for (const row of await runScoped<OverShortRow>(
        this.raw,
        business,
        overShortSql,
      )) {
        const expectedCashC = row.expected_cash;
        const closingCashC = row.closing_cash;
        overShort.push({
          shiftId: row.shift_id,
          branchId: row.branch_id,
          branchName: row.branch_name,
          closedAt: row.closed_at,
          expectedCashC,
          closingCashC,
          // Unknown, not zero, if the close never recorded both figures.
          varianceC:
            expectedCashC === null || closingCashC === null
              ? null
              : closingCashC - expectedCashC,
        });
      }
    }

    await this.reportAudit.log(scope, 'leaks', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      discountsByName: [...named.values()].sort((a, b) => b.amountC - a.amountC),
      orderLevelDiscountC,
      scPwd: {
        discountC: scPwdDiscountC,
        vatExemptSalesC,
        saleCount: scPwdSales,
      },
      miscLines: {
        revenueC: miscRevenueC,
        pctOfNetSales: netSalesC === 0 ? null : miscRevenueC / netSalesC,
      },
      voids: toBucket(voidReasons),
      refunds: toBucket(refundReasons),
      overShort: overShort.sort(
        (a, b) => b.closedAt.getTime() - a.closedAt.getTime(),
      ),
    };
  }
}

function toBucket(
  reasons: Map<string, { count: number; valueC: number }>,
): StatusBucket {
  if (reasons.size === 0) return emptyBucket();
  const rows = [...reasons.entries()]
    .map(([reason, r]) => ({ reason, ...r }))
    .sort((a, b) => b.valueC - a.valueC);
  return {
    count: rows.reduce((sum, r) => sum + r.count, 0),
    valueC: rows.reduce((sum, r) => sum + r.valueC, 0),
    reasons: rows,
  };
}
```

- [ ] **Step 5: Add the route and CSV, and register the service**

Add to `ProfitReportController`:

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

Add `leaksCsv` to `profit-report.csv.ts` with sections: `Discounts by name` (Name, Kind, Times used, Amount), `Summary` (Order-level discount, SC/PWD discount, VAT-exempt sales, Misc revenue, Misc % of net sales), `Voids` and `Refunds` (Reason, Count, Value), and `Over / short` (Branch, Closed at, Expected, Counted, Variance). Register `LeaksReportService` in `analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-profit
```

Expected: PASS, whole file. If `orderLevelDiscountC` comes back doubled, the line-promo subtraction is missing.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-profit.e2e-spec.ts
git commit -m "feat(api): leaks report — discounts, sc/pwd, misc rings, voids, refunds, over/short"
```

---

## Task 5: Inventory movement ledger (§5)

The full stock ledger, paginated, each row carrying who did it and why from the audit trail.

**Files:**
- Create: `src/portal/analytics/reports/inventory.sql.ts`
- Create: `src/portal/analytics/dto/movements-query.dto.ts`
- Create: `src/portal/analytics/inventory/inventory-report.service.ts`
- Create: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Create: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `Paginated<T>` (`common/types/pagination.ts`), `runScoped`, `runScopedOne`.
- Produces:
  - `movementsSql(business, filter, limit)`, `movementsCountSql(business, filter)`, `MovementRow`
  - `class MovementsQueryDto extends AnalyticsQueryDto { type?: MovementType; productId?: string; page?: number; pageSize?: number }`
  - `InventoryReportService.movements(query): Promise<Paginated<Movement>>`
  - `GET /v1/portal/analytics/inventory/movements`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-inventory.e2e-spec.ts` with the standard bootstrap and `seedTenant()`, describe `'Portal analytics — inventory (e2e)'`, plus a movement fixture:

```ts
  const RANGE = { from: '2026-03-01', to: '2026-03-07' };
  const DURING = new Date('2026-03-02T02:00:00.000Z');

  async function seedProduct(businessId: string, over: Record<string, unknown> = {}) {
    const category = await raw.category.create({
      data: { businessId, name: `C-${Math.random()}` },
    });
    return raw.product.create({
      data: {
        businessId,
        categoryId: category.id,
        name: 'Rice',
        price: 5000,
        cost: 3000,
        ...over,
      },
    });
  }

  const movements = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/inventory/movements')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('lists movements newest first with product and branch names', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: [
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'receive',
          refId: product.id,
          qtyDelta: '10',
          unitCost: 3000,
          createdAt: new Date('2026-03-02T01:00:00.000Z'),
        },
        {
          branchId: t.branchId,
          productId: product.id,
          type: 'adjustment',
          refId: product.id,
          qtyDelta: '-2',
          reasonCategory: 'damage',
          note: 'Dropped a sack',
          createdAt: new Date('2026-03-02T03:00:00.000Z'),
        },
      ],
    });

    const res = await movements(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.data[0]).toMatchObject({
      type: 'adjustment',
      qtyDelta: -2,
      reasonCategory: 'damage',
      note: 'Dropped a sack',
      productName: 'Rice',
      branchName: 'Main',
    });
    expect(res.body.data[1].type).toBe('receive');
  });

  it('filters by movement type and by product', async () => {
    const t = await seedTenant();
    const rice = await seedProduct(t.businessId);
    const beans = await seedProduct(t.businessId, { name: 'Beans' });
    await raw.stockMovement.createMany({
      data: [
        { branchId: t.branchId, productId: rice.id, type: 'receive', refId: rice.id, qtyDelta: '5', createdAt: DURING },
        { branchId: t.branchId, productId: beans.id, type: 'adjustment', refId: beans.id, qtyDelta: '-1', createdAt: DURING },
      ],
    });

    const byType = await movements(t.token, {
      businessId: t.businessId,
      type: 'receive',
    }).expect(200);
    expect(byType.body.total).toBe(1);

    const byProduct = await movements(t.token, {
      businessId: t.businessId,
      productId: beans.id,
    }).expect(200);
    expect(byProduct.body.total).toBe(1);
    expect(byProduct.body.data[0].productName).toBe('Beans');
  });

  it('paginates', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        branchId: t.branchId,
        productId: product.id,
        type: 'receive' as const,
        refId: product.id,
        qtyDelta: '1',
        createdAt: new Date(`2026-03-02T0${i}:00:00.000Z`),
      })),
    });

    const res = await movements(t.token, {
      businessId: t.businessId,
      pageSize: '2',
      page: '2',
    }).expect(200);

    expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect(res.body.data).toHaveLength(2);
  });

  it('surfaces who and why from the audit trail when a row exists', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    const movement = await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        type: 'adjustment',
        refId: product.id,
        qtyDelta: '-1',
        reasonCategory: 'theft_loss',
        createdAt: DURING,
      },
    });
    await raw.auditLog.create({
      data: {
        actorType: 'owner',
        actorId: t.ownerId,
        ownerId: t.ownerId,
        businessId: t.businessId,
        branchId: t.branchId,
        action: 'stock.adjust',
        entityType: 'stock_movement',
        entityId: movement.id,
        changes: {},
        metadata: {},
      },
    });

    const res = await movements(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.data[0].actor).toMatchObject({
      actorType: 'owner',
      action: 'stock.adjust',
    });
  });

  it('reports a null actor rather than inventing one when no audit row matches', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.create({
      data: {
        branchId: t.branchId,
        productId: product.id,
        type: 'receive',
        refId: product.id,
        qtyDelta: '1',
        createdAt: DURING,
      },
    });

    const res = await movements(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.data[0].actor).toBeNull();
  });

  it('rejects a page beyond the merge bound with 422', async () => {
    const t = await seedTenant();
    await movements(t.token, {
      businessId: t.businessId,
      pageSize: '200',
      page: '20',
    }).expect(422);
  });

  it('rejects an unknown movement type with 422', async () => {
    const t = await seedTenant();
    await movements(t.token, { businessId: t.businessId, type: 'teleport' }).expect(422);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: 404 on every case.

- [ ] **Step 3: Write the movement SQL**

Create `src/portal/analytics/reports/inventory.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { MovementType } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/** Optional narrowing applied to the ledger. */
export interface MovementFilter {
  type?: MovementType;
  productId?: string;
}

function movementWhere(
  business: ScopedBusiness,
  filter: MovementFilter,
): Prisma.Sql {
  return Prisma.sql`
    m.branch_id = ANY(${business.branchIds}::uuid[])
    AND m.deleted_at IS NULL
    AND m.created_at >= ${business.fromUtc}
    AND m.created_at <  ${business.toUtc}
    ${filter.type ? Prisma.sql`AND m.type = ${filter.type}::"MovementType"` : Prisma.empty}
    ${filter.productId ? Prisma.sql`AND m.product_id = ${filter.productId}::uuid` : Prisma.empty}
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
  qty_delta: number;
  reason_category: string | null;
  unit_cost: number | null;
  note: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action: string | null;
}

/**
 * The movement ledger.
 *
 * The "who and why" the spec asks for comes from `audit_logs`, joined on the
 * movement id as `entity_id`. It is a LEFT JOIN LATERAL taking the earliest
 * match: a movement written before the audit trail existed, or by a path that
 * does not audit, reports a null actor rather than a fabricated one.
 */
export function movementsSql(
  business: ScopedBusiness,
  filter: MovementFilter,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT m.id::text AS id,
           m.created_at AS created_at,
           m.branch_id::text AS branch_id,
           b.name AS branch_name,
           m.product_id::text AS product_id,
           m.variant_id::text AS variant_id,
           p.name AS product_name,
           v.name AS variant_name,
           m.type::text AS type,
           m.qty_delta::float8 AS qty_delta,
           m.reason_category::text AS reason_category,
           m.unit_cost AS unit_cost,
           m.note AS note,
           a.actor_type::text AS actor_type,
           a.actor_id::text AS actor_id,
           a.action AS action
    FROM stock_movements m
    JOIN branches b ON b.id = m.branch_id
    JOIN products p ON p.id = m.product_id
    LEFT JOIN product_variants v ON v.id = m.variant_id
    LEFT JOIN LATERAL (
      SELECT al.actor_type, al.actor_id, al.action
      FROM audit_logs al
      WHERE al.entity_id = m.id
      ORDER BY al.created_at ASC
      LIMIT 1
    ) a ON true
    WHERE ${movementWhere(business, filter)}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit}
  `;
}

export interface CountRow {
  total: bigint;
}

export function movementsCountSql(
  business: ScopedBusiness,
  filter: MovementFilter,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS total
    FROM stock_movements m
    WHERE ${movementWhere(business, filter)}
  `;
}
```

- [ ] **Step 4: Write the query DTO**

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
import { ValidationFailedError } from '../../../common/errors/api-errors';
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

/**
 * The deepest page this endpoint will serve.
 *
 * Reports query per business and merge in TypeScript, so serving page N means
 * fetching N x pageSize rows from EACH business (the global top-N is always a
 * subset of the union of the per-business top-Ns — that is what makes the merge
 * correct). Bounding the product keeps memory predictable; past it the honest
 * answer is "narrow the scope", not a slow query.
 */
const MAX_MERGE_ROWS = 2000;

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
  actor: { actorType: string; actorId: string | null; action: string } | null;
}

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
    const reach = page * pageSize;
    if (reach > MAX_MERGE_ROWS) {
      throw new ValidationFailedError(
        `page x pageSize must not exceed ${MAX_MERGE_ROWS} — narrow the date range, branch, or product instead.`,
      );
    }

    const scope = await this.scope.resolve(query);
    const filter = { type: query.type, productId: query.productId };

    const rows: Movement[] = [];
    let total = 0;

    for (const business of scope.businesses) {
      const counted = await runScopedOne<CountRow>(this.raw, business, (b) =>
        movementsCountSql(b, filter),
      );
      total += Number(counted.total);

      for (const row of await runScoped<MovementRow>(this.raw, business, (b) =>
        movementsSql(b, filter, reach),
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
          qtyDelta: row.qty_delta,
          reasonCategory: row.reason_category,
          unitCostC: row.unit_cost,
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

    rows.sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
    });

    await this.reportAudit.log(
      scope,
      'inventory-movements',
      query.format ?? 'json',
    );

    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}
```

- [ ] **Step 6: Write the controller and CSV, and register**

Create `src/portal/analytics/inventory/inventory-report.controller.ts` with `GET analytics/inventory/movements` taking `MovementsQueryDto`, returning `renderReport(res, 'inventory-movements', query, report, movementsCsv)`.

Create `src/portal/analytics/inventory/inventory-report.csv.ts` with `movementsCsv` — columns `['Date', 'Branch', 'Product', 'Variant', 'Type', 'Quantity', 'Reason', 'Unit cost', 'Note', 'Actor', 'Action']`, money through `centavosToPesos`, `null` left empty. Register the controller and service in `analytics.module.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(api): inventory movement ledger with audit-trail attribution"
```

---

## Task 6: Shrinkage by reason (§5)

Adjustment losses split by reason and valued at cost — where stock goes when it isn't sold.

**Files:**
- Modify: `src/portal/analytics/reports/inventory.sql.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.service.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Produces: `shrinkageSql(business)`, `ShrinkageRow`, `InventoryReportService.shrinkage(query)`, `GET /v1/portal/analytics/inventory/shrinkage`

- [ ] **Step 1: Write the failing tests**

Append to `test/portal-analytics-inventory.e2e-spec.ts`:

```ts
  const shrinkage = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/inventory/shrinkage')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('splits adjustment losses by reason and values them at cost', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: 3000 });
    await raw.stockMovement.createMany({
      data: [
        { branchId: t.branchId, productId: product.id, type: 'adjustment', refId: product.id, qtyDelta: '-2', reasonCategory: 'damage', createdAt: DURING },
        { branchId: t.branchId, productId: product.id, type: 'adjustment', refId: product.id, qtyDelta: '-1', reasonCategory: 'expiry', createdAt: DURING },
      ],
    });

    const res = await shrinkage(t.token, { businessId: t.businessId }).expect(200);

    const damage = res.body.rows.find((r: any) => r.reasonCategory === 'damage');
    expect(damage).toMatchObject({ units: 2, valueC: 6000, uncostedUnits: 0 });
    expect(res.body.rows.find((r: any) => r.reasonCategory === 'expiry').valueC).toBe(3000);
  });

  it('counts uncosted units instead of valuing them at zero', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: null });
    await raw.stockMovement.create({
      data: { branchId: t.branchId, productId: product.id, type: 'adjustment', refId: product.id, qtyDelta: '-4', reasonCategory: 'theft_loss', createdAt: DURING },
    });

    const res = await shrinkage(t.token, { businessId: t.businessId }).expect(200);

    const row = res.body.rows[0];
    expect(row).toMatchObject({ reasonCategory: 'theft_loss', units: 4, uncostedUnits: 4 });
    // Unknown value, not zero value.
    expect(row.valueC).toBeNull();
  });

  it('ignores positive adjustments, receives and sales', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.stockMovement.createMany({
      data: [
        { branchId: t.branchId, productId: product.id, type: 'adjustment', refId: product.id, qtyDelta: '5', reasonCategory: 'count_correction', createdAt: DURING },
        { branchId: t.branchId, productId: product.id, type: 'receive', refId: product.id, qtyDelta: '10', createdAt: DURING },
        { branchId: t.branchId, productId: product.id, type: 'sale', refId: product.id, qtyDelta: '-3', createdAt: DURING },
      ],
    });

    const res = await shrinkage(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows).toEqual([]);
  });

  it('prefers a variant cost over the parent cost', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: 3000 });
    const variant = await raw.productVariant.create({
      data: { productId: product.id, name: 'Large', price: 8000, cost: 5000 },
    });
    await raw.stockMovement.create({
      data: { branchId: t.branchId, productId: product.id, variantId: variant.id, type: 'adjustment', refId: product.id, qtyDelta: '-2', reasonCategory: 'damage', createdAt: DURING },
    });

    const res = await shrinkage(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].valueC).toBe(10000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: the shrinkage cases 404.

- [ ] **Step 3: Write the SQL**

Append to `src/portal/analytics/reports/inventory.sql.ts`:

```ts
export interface ShrinkageRow {
  reason_category: string;
  units: number;
  costed_rows: bigint;
  value_c: bigint;
  uncosted_units: number;
}

/**
 * Adjustment LOSSES only: `type = 'adjustment'` and `qty_delta < 0`. A positive
 * adjustment is a correction upward, not shrinkage, and sales/receives are not
 * losses at all.
 *
 * Valued at the CURRENT cost of the thing that shrank — the variant's when the
 * movement names one, otherwise the product's (analytics-spec §5). Rows whose
 * cost is unset contribute their units to `uncosted_units` and nothing to
 * `value_c`: shrinkage of unknown value is not shrinkage of zero value.
 */
export function shrinkageSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT m.reason_category::text AS reason_category,
           COALESCE(SUM(-m.qty_delta), 0)::float8 AS units,
           COUNT(*) FILTER (WHERE COALESCE(v.cost, p.cost) IS NOT NULL)::bigint AS costed_rows,
           COALESCE(SUM(round(-m.qty_delta * COALESCE(v.cost, p.cost)))
             FILTER (WHERE COALESCE(v.cost, p.cost) IS NOT NULL), 0)::bigint AS value_c,
           COALESCE(SUM(-m.qty_delta) FILTER (WHERE COALESCE(v.cost, p.cost) IS NULL), 0)::float8
             AS uncosted_units
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN product_variants v ON v.id = m.variant_id
    WHERE m.branch_id = ANY(${business.branchIds}::uuid[])
      AND m.deleted_at IS NULL
      AND m.type = 'adjustment'
      AND m.qty_delta < 0
      AND m.reason_category IS NOT NULL
      AND m.created_at >= ${business.fromUtc}
      AND m.created_at <  ${business.toUtc}
    GROUP BY 1
  `;
}
```

- [ ] **Step 4: Add the service method, route and CSV**

Add to `InventoryReportService`:

```ts
export interface ShrinkageEntry {
  reasonCategory: string;
  units: number;
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
    const merged = new Map<
      string,
      { units: number; costedRows: number; valueC: number; uncostedUnits: number }
    >();

    for (const business of scope.businesses) {
      for (const row of await runScoped<ShrinkageRow>(
        this.raw,
        business,
        shrinkageSql,
      )) {
        const current = merged.get(row.reason_category) ?? {
          units: 0,
          costedRows: 0,
          valueC: 0,
          uncostedUnits: 0,
        };
        merged.set(row.reason_category, {
          units: current.units + row.units,
          costedRows: current.costedRows + Number(row.costed_rows),
          valueC: current.valueC + Number(row.value_c),
          uncostedUnits: current.uncostedUnits + row.uncosted_units,
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
      rows: [...merged.entries()]
        .map(([reasonCategory, r]) => ({
          reasonCategory,
          units: r.units,
          // Null when NOTHING in this reason bucket had a cost.
          valueC: r.costedRows === 0 ? null : r.valueC,
          uncostedUnits: r.uncostedUnits,
        }))
        .sort((a, b) => (b.valueC ?? 0) - (a.valueC ?? 0)),
    };
  }
```

Add `GET analytics/inventory/shrinkage` to the controller and `shrinkageCsv` (columns `['Reason', 'Units', 'Value at cost', 'Uncosted units']`) to the CSV module.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(api): shrinkage by reason valued at cost, uncosted units counted"
```

---

## Task 7: Stock on hand, valuation and days of stock (§5)

What is on the shelf, what it is worth, and when it runs out.

**Files:**
- Create: `src/portal/analytics/inventory/days-of-stock.ts`
- Test: `src/portal/analytics/inventory/days-of-stock.spec.ts`
- Modify: `src/portal/analytics/reports/inventory.sql.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.service.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.controller.ts`
- Modify: `src/portal/analytics/inventory/inventory-report.csv.ts`
- Test: `test/portal-analytics-inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `halfUp` (`common/totals/money.ts`).
- Produces:
  - `daysOfStock(qty, unitsSold, dayCount): number | null`
  - `valuationC(qty, unitCostC): number | null`
  - `isLow(qty, threshold): boolean`
  - `onHandSql(business)`, `OnHandRow`
  - `InventoryReportService.onHand(query)`
  - `GET /v1/portal/analytics/inventory/on-hand`

- [ ] **Step 1: Write the failing unit tests**

Create `src/portal/analytics/inventory/days-of-stock.spec.ts`:

```ts
import { daysOfStock, isLow, valuationC } from './days-of-stock';

describe('daysOfStock', () => {
  it('divides stock by the trailing average daily sales', () => {
    // 30 sold over 10 days = 3/day; 12 on hand lasts 4 days.
    expect(daysOfStock(12, 30, 10)).toBeCloseTo(4);
  });

  // An infinite runway is not a number a report can render, and 0 would say
  // "out on Thursday" about something that never sells at all.
  it('is null when nothing sold in the period', () => {
    expect(daysOfStock(12, 0, 10)).toBeNull();
  });

  it('is null when the period is empty', () => {
    expect(daysOfStock(12, 5, 0)).toBeNull();
  });

  it('is zero when there is nothing on the shelf', () => {
    expect(daysOfStock(0, 30, 10)).toBe(0);
  });
});

describe('valuationC', () => {
  it('multiplies quantity by unit cost, rounded half up', () => {
    expect(valuationC(2.5, 333)).toBe(833);
  });

  it('is null when the cost is unknown — never zero', () => {
    expect(valuationC(10, null)).toBeNull();
  });
});

describe('isLow', () => {
  it('is true at or below the threshold', () => {
    expect(isLow(3, 10)).toBe(true);
    expect(isLow(10, 10)).toBe(true);
  });

  it('is false above it', () => {
    expect(isLow(11, 10)).toBe(false);
  });

  // No threshold means unmonitored, which is not the same as low.
  it('is false when no threshold is set', () => {
    expect(isLow(0, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- days-of-stock
```

Expected: FAIL — `Cannot find module './days-of-stock'`.

- [ ] **Step 3: Write the pure module**

Create `src/portal/analytics/inventory/days-of-stock.ts`:

```ts
import { halfUp } from '../../../common/totals/money';

/**
 * Stock-on-hand maths (analytics-spec §5). Pure — no Prisma, no Nest.
 *
 * Each function has one null case, and each null means "unknown", never zero.
 * That distinction is the whole point: a zero valuation reads as worthless
 * stock, and a zero runway reads as "out today".
 */

/**
 * How many days the shelf lasts at the period's average rate:
 * `qty ÷ (unitsSold ÷ dayCount)`.
 *
 * Null when the product did not sell in the period (the runway is unbounded,
 * which is not a number) or the period has no days.
 */
export function daysOfStock(
  qty: number,
  unitsSold: number,
  dayCount: number,
): number | null {
  if (unitsSold <= 0 || dayCount <= 0) return null;
  return qty / (unitsSold / dayCount);
}

/** `qty × unitCost` in centavos, or null when no cost is recorded. */
export function valuationC(qty: number, unitCostC: number | null): number | null {
  if (unitCostC === null) return null;
  return halfUp(qty * unitCostC);
}

/** At or below the threshold. A product with no threshold is unmonitored. */
export function isLow(qty: number, threshold: number | null): boolean {
  if (threshold === null) return false;
  return qty <= threshold;
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npm test -- days-of-stock
```

Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

Append to `test/portal-analytics-inventory.e2e-spec.ts`:

```ts
  const onHand = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/inventory/on-hand')
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('reports quantity, valuation and the low-stock flag', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, {
      cost: 3000,
      lowStockThreshold: '10',
    });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '4' },
    });

    const res = await onHand(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.rows[0]).toMatchObject({
      productId: product.id,
      name: 'Rice',
      qty: 4,
      unitCostC: 3000,
      valueC: 12000,
      lowStockThreshold: 10,
      isLow: true,
    });
    expect(res.body.totals).toMatchObject({ valueC: 12000, uncostedItems: 0 });
  });

  it('counts uncosted stock rather than valuing it at zero', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { cost: null });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '7' },
    });

    const res = await onHand(t.token, { businessId: t.businessId }).expect(200);

    expect(res.body.rows[0].valueC).toBeNull();
    expect(res.body.totals).toMatchObject({ valueC: 0, uncostedItems: 1 });
  });

  it('estimates days of stock from sales in the period', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '14' },
    });
    // 7 sold across a 7-day range = 1/day, so 14 on hand lasts 14 days.
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ name: 'Rice', productId: product.id, qty: 7, unitPriceC: 5000 }],
    });

    const res = await onHand(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].daysOfStock).toBeCloseTo(14);
  });

  it('reports days of stock as null for something that never sold', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId);
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '14' },
    });

    const res = await onHand(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].daysOfStock).toBeNull();
  });

  it('is not low when no threshold is set, however empty the shelf', async () => {
    const t = await seedTenant();
    const product = await seedProduct(t.businessId, { lowStockThreshold: null });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '0' },
    });

    const res = await onHand(t.token, { businessId: t.businessId }).expect(200);
    expect(res.body.rows[0].isLow).toBe(false);
  });
```

- [ ] **Step 6: Write the SQL**

Append to `src/portal/analytics/reports/inventory.sql.ts`:

```ts
export interface OnHandRow {
  branch_id: string;
  branch_name: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  qty: number;
  unit_cost: number | null;
  low_stock_threshold: number | null;
  units_sold: number;
}

/**
 * Stock on hand per branch, with the units sold in the window beside it so the
 * caller can compute a runway.
 *
 * The `units_sold` lateral matches on product AND variant with `IS NOT
 * DISTINCT FROM`, because a plain `=` never matches when both sides are NULL —
 * which is exactly the common case of a product with no variants.
 */
export function onHandSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT bs.branch_id::text AS branch_id,
           b.name AS branch_name,
           bs.product_id::text AS product_id,
           bs.variant_id::text AS variant_id,
           CASE WHEN v.name IS NULL THEN p.name ELSE p.name || ' — ' || v.name END AS name,
           bs.qty::float8 AS qty,
           COALESCE(v.cost, p.cost) AS unit_cost,
           p.low_stock_threshold::float8 AS low_stock_threshold,
           COALESCE(sold.units, 0)::float8 AS units_sold
    FROM branch_stock bs
    JOIN branches b ON b.id = bs.branch_id
    JOIN products p ON p.id = bs.product_id
    LEFT JOIN product_variants v ON v.id = bs.variant_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(si.qty), 0) AS units
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE si.product_id = bs.product_id
        AND si.variant_id IS NOT DISTINCT FROM bs.variant_id
        AND s.branch_id = bs.branch_id
        AND s.deleted_at IS NULL
        AND si.deleted_at IS NULL
        AND s.status = 'completed'
        AND s.created_at >= ${business.fromUtc}
        AND s.created_at <  ${business.toUtc}
    ) sold ON true
    WHERE bs.branch_id = ANY(${business.branchIds}::uuid[])
      AND bs.deleted_at IS NULL
      AND p.deleted_at IS NULL
    ORDER BY b.name ASC, p.name ASC
  `;
}
```

- [ ] **Step 7: Add the service method, route and CSV**

Add to `InventoryReportService` (importing `daysOfStock`, `isLow`, `valuationC`):

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
    let valueC = 0;
    let uncostedItems = 0;

    for (const business of scope.businesses) {
      for (const row of await runScoped<OnHandRow>(
        this.raw,
        business,
        onHandSql,
      )) {
        const value = valuationC(row.qty, row.unit_cost);
        if (value === null) uncostedItems += 1;
        else valueC += value;

        rows.push({
          branchId: row.branch_id,
          branchName: row.branch_name,
          productId: row.product_id,
          variantId: row.variant_id,
          name: row.name,
          qty: row.qty,
          unitCostC: row.unit_cost,
          valueC: value,
          lowStockThreshold: row.low_stock_threshold,
          isLow: isLow(row.qty, row.low_stock_threshold),
          daysOfStock: daysOfStock(row.qty, row.units_sold, scope.dayCount),
        });
      }
    }

    await this.reportAudit.log(scope, 'inventory-on-hand', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      rows,
      totals: { valueC, uncostedItems },
    };
  }
```

Add `GET analytics/inventory/on-hand` to the controller and `onHandCsv` — columns `['Branch', 'Item', 'Quantity', 'Unit cost', 'Value', 'Low stock threshold', 'Low', 'Days of stock']`, with a `Totals` section.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm test -- days-of-stock && npm run test:e2e -- portal-analytics-inventory
```

Expected: PASS, both.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-inventory.e2e-spec.ts
git commit -m "feat(api): stock on hand with valuation, low-stock flag and days-of-stock runway"
```

---

## Task 8: Extend the tenancy sweep to the new endpoints

Plan 1's tenancy spec exists so a new report cannot ship without a cross-tenant decision. Seven new reports means seven new entries.

**Files:**
- Modify: `test/portal-analytics-tenancy.e2e-spec.ts`

**Interfaces:**
- Consumes: every route from Tasks 1–7.
- Produces: nothing — no source files.

- [ ] **Step 1: Add the new endpoints to the sweep**

In `test/portal-analytics-tenancy.e2e-spec.ts`, extend the `ENDPOINTS` array:

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

`analytics/products/:productId/trend` is deliberately absent: it needs a product id, so its ownership case lives with the product tests (Task 2), where a foreign product id asserts 404.

- [ ] **Step 2: Run the sweep to verify the new endpoints pass it**

```bash
npm run test:e2e -- portal-analytics-tenancy
```

Expected: PASS for all thirteen endpoints. A failure here means a query lost its `branch_id` predicate — fix the SQL, never the assertion.

- [ ] **Step 3: Run everything**

```bash
npm test && npm run test:e2e && npm run lint && npm run build
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/portal-analytics-tenancy.e2e-spec.ts
git commit -m "test(api): extend the analytics tenancy sweep to product, profit and inventory reports"
```

---

## Self-review notes

**Spec coverage.** §3 top/slow → Task 1; §3 per-product trend → Task 2; §4 profit → Task 3; §4 leaks → Task 4; §5 movements → Task 5; §5 shrinkage → Task 6; §5 on-hand with valuation, low-stock and days-of-stock → Task 7. Tenancy → Task 8. Expiring-soon, stock-take history and transfer history stay deferred to sub-project B for the reasons the spec records.

**Deliberate decisions worth flagging to a reviewer.**
1. Misc lines are excluded from every §3 and §4 per-product/per-category rollup, so product revenue does not sum to net sales. They surface only as §4 `miscLines`.
2. §3 rows are keyed by (product, variant); a product's total is the sum of its variant rows. The per-product trend (Task 2) deliberately merges variants, because that drill-down asks a different question.
3. Movements pagination fetches `page × pageSize` rows per business and merges, bounded at 2000; deeper pages return 422 asking for a narrower scope.
4. Over/short windows on `closed_at`, not `created_at`.
5. `orderLevelDiscountC` is derived (`sales.discount − (Σ line discounts − sc_pwd_discount)`) because the engine never stores it separately.

**Interface consistency.** `LINE_MONEY_JOINS`/`LINE_NET_C`/`LINE_COST_C` come from the existing `reports/line-money.sql.ts` and are reused by Tasks 1, 2 and 4. `bucketExpr` is exported in Task 2 and reused in Task 3. `categorySalesSql` gains costed columns in Task 3, which Task 1's consumer ignores. `runScopedOne` (existing) is used for every single-row aggregate. Margins are fractions everywhere, matching `overview.math`.

**Task order is a dependency order.** 1 → 2 (needs `productSalesSql`). 1, 2 → 3 (needs `productSalesSql`, `categorySalesSql`, `bucketExpr`). 1 → 4 (needs the laterals). 5 → 6 → 7 (same file and service, built up). All → 8.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-analytics-product-profit-inventory.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

