# Analytics Money Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the portal dashboard (§0), overview (§1), sales (§2) and tax (§6) reports with CSV export, on a shared analytics foundation, plus the product→modifier-group read the portal is missing.

**Architecture:** A scope resolver turns a shared query DTO into per-business windows through the tenant-scoped Prisma client; hand-written SQL runs per business behind one `runScoped()` guard, because the tenancy choke point does not cover raw queries; results merge in TypeScript. Every report renders as JSON or CSV from one object.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest (unit, `rootDir: src`) + Jest e2e (`test/*.e2e-spec.ts`, real Postgres via docker compose), supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-portal-analytics-and-dashboard-design.md`. Plan 1 of 2; plan 2 covers §3 products, §4 profit & leaks, §5 inventory.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Integer centavos everywhere.** SQL aggregates cast to `::bigint`; convert with `Number(...)` at the edge. Money fields are suffixed `C`.
- **A null cost is `null`, never `0`.** Zero would report 100% margin on uncosted products.
- **Line gross is `round(qty * (unit_price + Σ modifier priceDeltaC))` — never `qty * unit_price`.** `sale_items.unit_price` is the base price without modifier deltas (`sales.service.ts:507`); the engine adds `lineUnitWithModsC()` (`cart.ts:49`). `cost_snapshot` is the **unit** cost (`sales.service.ts:664`), so line cost is `round(qty * cost_snapshot)`.
- **Every analytics query runs per business** and results merge in TypeScript, because `dayStartTime` differs per business.
- **Every analytics SQL query goes through `runScoped()`** and carries a `branch_id` predicate bound from ids the choke point produced. `$queryRaw` bypasses the tenancy extension (`scoped-prisma.ts:737` hooks `$allModels` only).
- **Voided sales are excluded from every money figure and from `transactions`; refunded sales are excluded from money figures but their count is reported.**
- **Asia/Manila is UTC+8 year-round** (no DST since 1978), so fixed-offset arithmetic is correct. `MANILA_OFFSET_MINUTES = 480`.
- **Validation failures are 422 `validation`** (the global `ValidationPipe` sets `errorHttpStatusCode: UNPROCESSABLE_ENTITY`, `main.ts:16`); a named id that isn't yours is 404 `not_found`. An owned business with no branches is a 200 with zeros, never a 404.
- **Routes** are `@Controller('portal')` + `@UseGuards(PortalAuthGuard)` under the `v1` global prefix.
- **Sensitive reads** append `audit.report_read`; CSV exports append `audit.report_export`.
- **Never add a Claude co-author trailer to a commit. Never run `git push`.** Commit directly on `main`.

**Commands:** `npm test` (unit), `npm run test:e2e` (needs `docker compose up -d db`), `npm run lint`, `npm run build`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/portal/analytics/scope/business-day.ts` | Pure business-day ↔ UTC arithmetic. No I/O. |
| `src/portal/analytics/scope/business-day.spec.ts` | Unit tests for the above. |
| `src/portal/analytics/csv.ts` | RFC 4180 CSV writer + centavos→pesos formatting. Pure. |
| `src/portal/analytics/csv.spec.ts` | Unit tests for the above. |
| `src/portal/analytics/dto/analytics-query.dto.ts` | The shared query DTO for every report. |
| `src/portal/analytics/scope/analytics-scope.service.ts` | `BusinessBranches`, `ScopedBusiness`, `ResolvedScope`, `withWindow()`, `AnalyticsScopeService`. |
| `src/portal/analytics/scope/analytics-scope.service.spec.ts` | Unit tests with a stubbed scoped client. |
| `src/portal/analytics/scoped-sql.ts` | `runScoped()` — the one door raw analytics SQL goes through. |
| `src/portal/analytics/scoped-sql.spec.ts` | Unit tests for its two guards. |
| `src/portal/analytics/report-response.ts` | `renderReport()` — JSON or CSV from one object. |
| `src/portal/analytics/report-response.spec.ts` | Unit tests for header/format behaviour. |
| `src/portal/analytics/report-audit.service.ts` | `audit.report_read` / `audit.report_export` rows. |
| `src/portal/analytics/analytics.module.ts` | Wires providers and controllers. |
| `src/portal/analytics/reports/sales-aggregate.sql.ts` | Sale-level and line-level aggregate SQL builders. |
| `src/portal/analytics/reports/sales-buckets.sql.ts` | Bucketed/grouped SQL for §2. |
| `src/portal/analytics/reports/dashboard.sql.ts` | Low-stock count SQL for §0. |
| `src/portal/analytics/overview/overview.service.ts` | §1 computation. |
| `src/portal/analytics/overview/overview.controller.ts` | §1 route. |
| `src/portal/analytics/overview/overview.csv.ts` | §1 CSV sections. |
| `src/portal/analytics/sales/sales-report.service.ts` | §2 computation. |
| `src/portal/analytics/sales/sales-report.controller.ts` | §2 routes. |
| `src/portal/analytics/sales/sales-report.csv.ts` | §2 CSV sections. |
| `src/portal/analytics/tax/tax-report.service.ts` | §6 computation. |
| `src/portal/analytics/tax/tax-report.controller.ts` | §6 route. |
| `src/portal/analytics/tax/tax-report.csv.ts` | §6 CSV sections. |
| `src/portal/analytics/dashboard/dashboard.service.ts` | §0 computation. |
| `src/portal/analytics/dashboard/dashboard.controller.ts` | §0 route. |
| `test/helpers/sales.ts` | `seedSale()` — writes sales through the real totals engine. |
| `test/portal-analytics-overview.e2e-spec.ts` | §1 against real data. |
| `test/portal-analytics-sales.e2e-spec.ts` | §2 against real data. |
| `test/portal-analytics-tax.e2e-spec.ts` | §6 against real data. |
| `test/portal-analytics-dashboard.e2e-spec.ts` | §0 against real data. |
| `test/portal-analytics-invariants.e2e-spec.ts` | Tenancy, null-cost, business-day, modifier-revenue. |

**Modified:**

| File | Change |
|---|---|
| `src/common/validation-constants.ts` | Add `ISO_DATE_REGEX`. |
| `src/portal/catalog/products.service.ts` | `PRODUCT_INCLUDE`, `modifierGroupIds` on `ProductResponse`. |
| `src/portal/portal.module.ts` | Import `AnalyticsModule`. |
| `test/portal-modifiers-discounts.e2e-spec.ts` | Two cases for the product read. |

---

## Task 1: Product read returns its linked modifier groups

The portal's modifier-links editor currently warns on screen that it cannot show the current selection, because no endpoint returns it. This closes that gap. Independent of everything else in this plan.

**Files:**
- Modify: `src/portal/catalog/products.service.ts`
- Test: `test/portal-modifiers-discounts.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProductResponse.modifierGroupIds: string[]` on every product read (`list`, `get`, `create`, `update`, `remove`).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('Portal modifiers + discounts (e2e)', ...)` block in `test/portal-modifiers-discounts.e2e-spec.ts`. The `ctx()` and `createGroup()` helpers already exist in that file; `milkGroup()` is defined at module scope.

```ts
  it('returns the linked modifier group ids on a product read', async () => {
    const { token, businessId, productId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [group.id] })
      .expect(200);

    const res = await request(server())
      .get(`/v1/portal/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.modifierGroupIds).toEqual([group.id]);
  });

  it('reports an empty link set as [] after the links are cleared', async () => {
    const { token, businessId, productId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [group.id] })
      .expect(200);
    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [] })
      .expect(200);

    const res = await request(server())
      .get(`/v1/portal/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.modifierGroupIds).toEqual([]);
  });

  it('lists products with their link sets too, so the list never lies by omission', async () => {
    const { token, businessId, productId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    await request(server())
      .put(`/v1/portal/products/${productId}/modifier-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send({ groupIds: [group.id] })
      .expect(200);

    const res = await request(server())
      .get(`/v1/portal/businesses/${businessId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = res.body.find((p: any) => p.id === productId);
    expect(row.modifierGroupIds).toEqual([group.id]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-modifiers-discounts
```

Expected: three failures, each `expect(received).toEqual(expected)` with `received: undefined` — `modifierGroupIds` is not on the response yet.

- [ ] **Step 3: Find every read path that must carry the relation**

```bash
grep -n "VARIANTS_INCLUDE\|ProductWithVariants" src/portal/catalog/products.service.ts
```

Every occurrence gets replaced in Step 4. The point of using one shared include constant is that the compiler then forces all read paths to carry the relation — a path that skipped it would return `[]` and quietly claim the product has no linked groups.

- [ ] **Step 4: Add the relation to the include, the type, and the response**

In `src/portal/catalog/products.service.ts`, replace the `ProductWithVariants` type and the `VARIANTS_INCLUDE` constant:

```ts
type ProductWithRelations = Prisma.ProductGetPayload<{
  include: {
    variants: true;
    productModifierGroups: { select: { groupId: true } };
  };
}>;

/**
 * Variants load oldest-first within a product (stable display order); products
 * themselves list newest-first (see `list`). The choke point injects
 * `deletedAt: null`, so only live variants come back.
 *
 * `productModifierGroups` is a CHILD_ONLY model (`model-scope-map.ts:60`) — it
 * has no top-level tenant access, and is legitimately reached here through its
 * scoped parent. It rides EVERY product read on purpose: `serializeProduct`
 * requires the relation, so the compiler rejects any read path that would
 * return `modifierGroupIds: []` for a product that actually has links.
 */
const PRODUCT_INCLUDE = {
  variants: { orderBy: { createdAt: 'asc' as const } },
  productModifierGroups: {
    select: { groupId: true },
    orderBy: { createdAt: 'asc' as const },
  },
};
```

Add the field to `ProductResponse`, after `variants`:

```ts
  variants: VariantResponse[];
  /** Ids of the linked modifier groups — the full set, replace-set on PUT. */
  modifierGroupIds: string[];
```

Change `serializeProduct` to **require** both relations (no optional `?`, no `?? []` fallback — the missing-relation case must be a compile error, not an empty array):

```ts
function serializeProduct(
  p: Product & {
    variants: ProductVariant[];
    productModifierGroups: { groupId: string }[];
  },
): ProductResponse {
```

and add to its returned object, after `variants`:

```ts
    variants: p.variants.map(serializeVariant),
    modifierGroupIds: p.productModifierGroups.map((link) => link.groupId),
```

Then replace every remaining `VARIANTS_INCLUDE` with `PRODUCT_INCLUDE` and every `ProductWithVariants` with `ProductWithRelations`.

- [ ] **Step 5: Compile and fix any read path the compiler rejects**

```bash
npm run build
```

Expected: clean. If a call site fails with "Property 'productModifierGroups' is missing", that path was reading a product without the include — give it `PRODUCT_INCLUDE`. That error is the guard working.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-modifiers-discounts
```

Expected: PASS, whole file green (the existing link and group tests must not regress).

- [ ] **Step 7: Commit**

```bash
git add src/portal/catalog/products.service.ts test/portal-modifiers-discounts.e2e-spec.ts
git commit -m "feat(portal): return a product's linked modifier group ids on read"
```

---

## Task 2: Business-day arithmetic

`Business.dayStartTime` has existed since the first migration and nothing reads it. This pure module is its first consumer, and every bucketed report depends on it being right.

**Files:**
- Create: `src/portal/analytics/scope/business-day.ts`
- Test: `src/portal/analytics/scope/business-day.spec.ts`

**Interfaces:**
- Consumes: nothing. No I/O, no Prisma, no Nest.
- Produces:
  - `MANILA_OFFSET_MINUTES: 480`
  - `parseDayStart(dayStartTime: string): number`
  - `businessDayStartUtc(date: string, dayStartMinutes: number): Date`
  - `businessDayOf(instant: Date, dayStartMinutes: number): string`
  - `businessDayRangeUtc(from: string, to: string, dayStartMinutes: number): { fromUtc: Date; toUtc: Date }`
  - `businessDaySeries(from: string, to: string): string[]`
  - `addDays(date: string, days: number): string`
  - `previousPeriod(fromUtc: Date, toUtc: Date): { fromUtc: Date; toUtc: Date }`

- [ ] **Step 1: Write the failing tests**

Create `src/portal/analytics/scope/business-day.spec.ts`:

```ts
import {
  MANILA_OFFSET_MINUTES,
  addDays,
  businessDayOf,
  businessDayRangeUtc,
  businessDaySeries,
  businessDayStartUtc,
  parseDayStart,
  previousPeriod,
} from './business-day';

describe('parseDayStart', () => {
  it('reads HH:mm as minutes past midnight', () => {
    expect(parseDayStart('00:00')).toBe(0);
    expect(parseDayStart('04:00')).toBe(240);
    expect(parseDayStart('23:59')).toBe(1439);
  });

  it('rejects anything that is not HH:mm on a 24-hour clock', () => {
    expect(() => parseDayStart('24:00')).toThrow(/HH:mm/);
    expect(() => parseDayStart('4:00')).toThrow(/HH:mm/);
    expect(() => parseDayStart('')).toThrow(/HH:mm/);
  });
});

describe('businessDayStartUtc', () => {
  it('starts a midnight business day at 16:00 UTC the day before', () => {
    // Manila is UTC+8, so 2026-03-02 00:00 local is 2026-03-01 16:00Z.
    expect(businessDayStartUtc('2026-03-02', 0).toISOString()).toBe(
      '2026-03-01T16:00:00.000Z',
    );
  });

  it('starts an 04:00 business day at 20:00 UTC the day before', () => {
    expect(businessDayStartUtc('2026-03-02', 240).toISOString()).toBe(
      '2026-03-01T20:00:00.000Z',
    );
  });
});

describe('businessDayOf', () => {
  // The café case: 03:00 Manila trading belongs to the PREVIOUS business day
  // when the day starts at 04:00. This is the whole reason dayStartTime exists.
  const threeAmManila = new Date('2026-03-01T19:00:00.000Z'); // 2026-03-02 03:00 +08

  it('puts 3 AM trading on the previous day for an 04:00 start', () => {
    expect(businessDayOf(threeAmManila, 240)).toBe('2026-03-01');
  });

  it('puts the same instant on the calendar day for a midnight start', () => {
    expect(businessDayOf(threeAmManila, 0)).toBe('2026-03-02');
  });

  it('puts 5 AM trading on the same day for an 04:00 start', () => {
    const fiveAmManila = new Date('2026-03-01T21:00:00.000Z');
    expect(businessDayOf(fiveAmManila, 240)).toBe('2026-03-02');
  });

  it('agrees with businessDayStartUtc at the exact boundary', () => {
    const start = businessDayStartUtc('2026-03-02', 240);
    expect(businessDayOf(start, 240)).toBe('2026-03-02');
    expect(businessDayOf(new Date(start.getTime() - 1), 240)).toBe('2026-03-01');
  });
});

describe('businessDayRangeUtc', () => {
  it('is inclusive of the from-day and exclusive of the day after the to-day', () => {
    const { fromUtc, toUtc } = businessDayRangeUtc('2026-03-01', '2026-03-03', 0);
    expect(fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-03-03T16:00:00.000Z');
  });

  it('covers exactly one day when from equals to', () => {
    const { fromUtc, toUtc } = businessDayRangeUtc('2026-03-01', '2026-03-01', 0);
    expect(toUtc.getTime() - fromUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('businessDaySeries', () => {
  it('lists every day from and to inclusive', () => {
    expect(businessDaySeries('2026-03-01', '2026-03-04')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('crosses a month boundary', () => {
    expect(businessDaySeries('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('throws when to is before from', () => {
    expect(() => businessDaySeries('2026-03-04', '2026-03-01')).toThrow(
      /must not be before/,
    );
  });

  it('rejects a malformed date', () => {
    expect(() => businessDaySeries('2026-3-1', '2026-03-01')).toThrow(
      /YYYY-MM-DD/,
    );
  });

  // `2026-13-45` matches the YYYY-MM-DD shape but is not a real date, and
  // Date.UTC would silently roll it over to 2027-02-14. Silent rollover would
  // report a window nobody asked for, so it must throw.
  it('rejects a well-shaped date that does not exist', () => {
    expect(() => businessDaySeries('2026-13-45', '2026-12-31')).toThrow(
      /not a real date/,
    );
    expect(() => businessDaySeries('2026-02-30', '2026-03-01')).toThrow(
      /not a real date/,
    );
  });
});

describe('addDays', () => {
  it('advances across a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('goes backwards with a negative count', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('previousPeriod', () => {
  it('is the equal-length window ending where this one begins', () => {
    const fromUtc = new Date('2026-03-08T00:00:00.000Z');
    const toUtc = new Date('2026-03-15T00:00:00.000Z');
    const prev = previousPeriod(fromUtc, toUtc);
    expect(prev.toUtc).toEqual(fromUtc);
    expect(prev.fromUtc.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('MANILA_OFFSET_MINUTES', () => {
  it('is a fixed +08:00 because the Philippines observes no DST', () => {
    expect(MANILA_OFFSET_MINUTES).toBe(480);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- business-day
```

Expected: FAIL — `Cannot find module './business-day'`.

- [ ] **Step 3: Write the implementation**

Create `src/portal/analytics/scope/business-day.ts`:

```ts
/**
 * Business-day arithmetic (project-spec §7 "Business day").
 *
 * A business day runs `[date + dayStartTime, nextDate + dayStartTime)` in
 * Asia/Manila. A café that opens at 2 AM sets `04:00`, so its 3 AM trading
 * belongs to the previous business day.
 *
 * Pure: no Prisma, no Nest, no clock reads beyond what callers pass in.
 *
 * Asia/Manila is a FIXED UTC+8 — the Philippines has observed no daylight
 * saving since 1978. That is why plain offset arithmetic is correct here and
 * no timezone library is needed. If the platform ever adds a per-business
 * timezone (project-spec §7 defers it to "the multi-currency era"), this module
 * is the one place that has to change.
 */

/** Asia/Manila's fixed offset from UTC, in minutes. */
export const MANILA_OFFSET_MINUTES = 480;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** `'HH:mm'` → minutes past midnight. Throws on anything else. */
export function parseDayStart(dayStartTime: string): number {
  if (!HHMM.test(dayStartTime)) {
    throw new Error(
      `dayStartTime must be HH:mm on a 24-hour clock, got "${dayStartTime}"`,
    );
  }
  const [hours, minutes] = dayStartTime.split(':').map(Number);
  return hours * 60 + minutes;
}

function assertIsoDate(date: string): void {
  if (!ISO_DATE.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  }
}

/**
 * Midnight UTC on a calendar date, as a millisecond epoch.
 *
 * The round-trip check is load-bearing: `Date.UTC(2026, 12, 45)` does not fail,
 * it silently becomes 2027-02-14. A report is not allowed to answer about a
 * window nobody asked for, so a well-shaped but impossible date throws.
 */
function utcMidnight(date: string): number {
  assertIsoDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`"${date}" is not a real date`);
  }
  return ms;
}

/** The UTC instant at which the given business day begins. */
export function businessDayStartUtc(
  date: string,
  dayStartMinutes: number,
): Date {
  return new Date(
    utcMidnight(date) +
      (dayStartMinutes - MANILA_OFFSET_MINUTES) * MS_PER_MINUTE,
  );
}

/** The business day (`YYYY-MM-DD`) an instant falls on. */
export function businessDayOf(instant: Date, dayStartMinutes: number): string {
  const shifted = new Date(
    instant.getTime() +
      (MANILA_OFFSET_MINUTES - dayStartMinutes) * MS_PER_MINUTE,
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * The half-open UTC interval covering business days `from`..`to`, both
 * inclusive as dates. `toUtc` is exclusive as an instant.
 */
export function businessDayRangeUtc(
  from: string,
  to: string,
  dayStartMinutes: number,
): { fromUtc: Date; toUtc: Date } {
  assertIsoDate(from);
  assertIsoDate(to);
  return {
    fromUtc: businessDayStartUtc(from, dayStartMinutes),
    toUtc: businessDayStartUtc(addDays(to, 1), dayStartMinutes),
  };
}

/** Shift a `YYYY-MM-DD` by whole days. */
export function addDays(date: string, days: number): string {
  return new Date(utcMidnight(date) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** Every business day from `from` to `to` inclusive — used to zero-fill. */
export function businessDaySeries(from: string, to: string): string[] {
  const start = utcMidnight(from);
  const end = utcMidnight(to);
  if (end < start) {
    throw new Error(`"to" (${to}) must not be before "from" (${from})`);
  }
  const days: string[] = [];
  for (let t = start; t <= end; t += MS_PER_DAY) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** The equal-length window ending exactly where this one begins. */
export function previousPeriod(
  fromUtc: Date,
  toUtc: Date,
): { fromUtc: Date; toUtc: Date } {
  const span = toUtc.getTime() - fromUtc.getTime();
  return { fromUtc: new Date(fromUtc.getTime() - span), toUtc: fromUtc };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- business-day
```

Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/portal/analytics/scope/business-day.ts src/portal/analytics/scope/business-day.spec.ts
git commit -m "feat(analytics): business-day arithmetic against each business's day start"
```

---

## Task 3: CSV writer

Every report exports through this, over the same object the JSON response returns, so an export can never drift from what is on screen.

**Files:**
- Create: `src/portal/analytics/csv.ts`
- Test: `src/portal/analytics/csv.spec.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces:
  - `interface CsvSection { title?: string; columns: string[]; rows: CsvValue[][] }`
  - `type CsvValue = string | number | null`
  - `toCsv(sections: CsvSection[]): string`
  - `centavosToPesos(c: number | null): string`
  - `formatPct(value: number | null): string`

- [ ] **Step 1: Write the failing tests**

Create `src/portal/analytics/csv.spec.ts`:

```ts
import { centavosToPesos, formatPct, toCsv } from './csv';

describe('centavosToPesos', () => {
  it('renders centavos as a plain two-decimal peso amount', () => {
    expect(centavosToPesos(125000)).toBe('1250.00');
    expect(centavosToPesos(5)).toBe('0.05');
    expect(centavosToPesos(0)).toBe('0.00');
  });

  it('keeps the sign on a negative amount', () => {
    expect(centavosToPesos(-2550)).toBe('-25.50');
  });

  it('renders null as an empty field, never as zero', () => {
    expect(centavosToPesos(null)).toBe('');
  });

  it('does not group thousands — a CSV is parsed, not read', () => {
    expect(centavosToPesos(123456789)).toBe('1234567.89');
  });
});

describe('formatPct', () => {
  it('renders one decimal place', () => {
    expect(formatPct(12.345)).toBe('12.3');
  });

  it('renders null as an empty field', () => {
    expect(formatPct(null)).toBe('');
  });
});

describe('toCsv', () => {
  const simple = [{ columns: ['a', 'b'], rows: [[1, 2]] }];

  it('starts with a BOM so Excel reads UTF-8 correctly', () => {
    expect(toCsv(simple).startsWith('﻿')).toBe(true);
  });

  it('uses CRLF line endings and ends with one', () => {
    expect(toCsv(simple)).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('quotes a field containing a comma', () => {
    const csv = toCsv([{ columns: ['name'], rows: [['Beans, green']] }]);
    expect(csv).toContain('"Beans, green"');
  });

  it('doubles embedded quotes', () => {
    const csv = toCsv([{ columns: ['name'], rows: [['12" pizza']] }]);
    expect(csv).toContain('"12"" pizza"');
  });

  it('quotes a field containing a newline', () => {
    const csv = toCsv([{ columns: ['note'], rows: [['line one\nline two']] }]);
    expect(csv).toContain('"line one\nline two"');
  });

  it('writes null as an empty field', () => {
    const csv = toCsv([{ columns: ['a', 'b'], rows: [[null, 'x']] }]);
    expect(csv).toBe('﻿a,b\r\n,x\r\n');
  });

  it('separates sections with a blank line and a title row', () => {
    const csv = toCsv([
      { title: 'Totals', columns: ['a'], rows: [[1]] },
      { title: 'By branch', columns: ['b'], rows: [[2]] },
    ]);
    expect(csv).toBe('﻿Totals\r\na\r\n1\r\n\r\nBy branch\r\nb\r\n2\r\n');
  });

  it('emits a header-only section when there are no rows', () => {
    expect(toCsv([{ columns: ['a', 'b'], rows: [] }])).toBe('﻿a,b\r\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- csv
```

Expected: FAIL — `Cannot find module './csv'`.

- [ ] **Step 3: Write the implementation**

Create `src/portal/analytics/csv.ts`:

```ts
/**
 * RFC 4180 CSV writer for report exports.
 *
 * Every report exports through this, over THE SAME object its JSON response
 * returns — one code path, so a CSV can never drift from what is on screen.
 *
 * Money is written as pesos with two decimals rather than centavos: a report
 * CSV goes to an accountant or a spreadsheet, not to a parser. Nulls are
 * written as empty fields, never as zero (see the null-cost rule in the spec).
 */

export type CsvValue = string | number | null;

export interface CsvSection {
  /** Optional heading row, for reports that export several tables. */
  title?: string;
  columns: string[];
  rows: CsvValue[][];
}

const BOM = '﻿';
const EOL = '\r\n';
const NEEDS_QUOTING = /[",\r\n]/;

/** Centavos → a plain two-decimal peso string. `null` → `''`. */
export function centavosToPesos(c: number | null): string {
  if (c === null) return '';
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${cents}`;
}

/** A percentage to one decimal place. `null` → `''`. */
export function formatPct(value: number | null): string {
  return value === null ? '' : value.toFixed(1);
}

function escapeField(value: CsvValue): string {
  if (value === null) return '';
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(sections: CsvSection[]): string {
  const lines: string[] = [];

  sections.forEach((section, index) => {
    if (index > 0) lines.push('');
    if (section.title !== undefined) lines.push(escapeField(section.title));
    lines.push(section.columns.map(escapeField).join(','));
    for (const row of section.rows) {
      lines.push(row.map(escapeField).join(','));
    }
  });

  return BOM + lines.join(EOL) + EOL;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- csv
```

Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/portal/analytics/csv.ts src/portal/analytics/csv.spec.ts
git commit -m "feat(analytics): RFC 4180 CSV writer with peso formatting and null-as-empty"
```

---

## Task 4: Query DTO and scope resolver

Turns a query into the set of businesses the caller may report on, each with its own UTC window. Resolution runs through the tenant-scoped Prisma client, so the choke point — not this service — decides visibility.

**Files:**
- Create: `src/portal/analytics/dto/analytics-query.dto.ts`
- Create: `src/portal/analytics/scope/analytics-scope.service.ts`
- Test: `src/portal/analytics/scope/analytics-scope.service.spec.ts`
- Modify: `src/common/validation-constants.ts`

**Interfaces:**
- Consumes: `parseDayStart`, `businessDayRangeUtc`, `businessDaySeries`, `previousPeriod` (Task 2); `SCOPED_PRISMA`/`ScopedPrisma`; `NotFoundError`, `ValidationFailedError`.
- Produces:
  - `class AnalyticsQueryDto { businessId?: string; branchId?: string; from: string; to: string; format?: 'json' | 'csv' }`
  - `interface BusinessBranches { id; name; dayStartTime; dayStartMinutes; taxRate; branchIds }`
  - `interface ScopedBusiness extends BusinessBranches { fromUtc; toUtc; previousFromUtc; previousToUtc }`
  - `interface ResolvedScope { businesses: ScopedBusiness[]; branchIds: string[]; from: string; to: string; dayCount: number }`
  - `withWindow(business: BusinessBranches, from: string, to: string): ScopedBusiness`
  - `AnalyticsScopeService.resolveBusinesses(filter): Promise<BusinessBranches[]>`
  - `AnalyticsScopeService.resolve(query: AnalyticsQueryDto): Promise<ResolvedScope>`

- [ ] **Step 1: Add the shared date regex**

Append to `src/common/validation-constants.ts`:

```ts
/** `YYYY-MM-DD` calendar date (shape only — realness is checked downstream). */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
```

- [ ] **Step 2: Write the query DTO**

Create `src/portal/analytics/dto/analytics-query.dto.ts`:

```ts
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { ISO_DATE_REGEX } from '../../../common/validation-constants';

/**
 * The shared query for every analytics report.
 *
 * Dates are BUSINESS days (project-spec §7), inclusive at both ends, and are
 * resolved per business against its own `dayStartTime`.
 *
 * Range presets (today / 7 days / this month) deliberately resolve in the
 * PORTAL, not here: the API takes explicit dates only, which keeps "what is
 * today" one question answered against one business day rather than a second
 * clock in the API.
 */
export class AnalyticsQueryDto {
  /** Omit to span every non-demo business the caller owns. */
  @IsOptional()
  @IsUUID()
  businessId?: string;

  /** Requires `businessId`; 422 without it. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @Matches(ISO_DATE_REGEX, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(ISO_DATE_REGEX, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/portal/analytics/scope/analytics-scope.service.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../../common/errors/api-errors';
import type { ScopedPrisma } from '../../../prisma/scoped-prisma.provider';
import { AnalyticsScopeService } from './analytics-scope.service';

interface FakeBusiness {
  id: string;
  name: string;
  dayStartTime: string;
  taxRate: Prisma.Decimal;
}

function business(over: Partial<FakeBusiness> = {}): FakeBusiness {
  return {
    id: 'b-1',
    name: 'Kape',
    dayStartTime: '00:00',
    taxRate: new Prisma.Decimal('0.12'),
    ...over,
  };
}

function fakeScoped(businesses: FakeBusiness[], branches: unknown[]) {
  const businessFindMany = jest.fn().mockResolvedValue(businesses);
  const branchFindMany = jest.fn().mockResolvedValue(branches);
  const scoped = {
    business: { findMany: businessFindMany },
    branch: { findMany: branchFindMany },
  } as unknown as ScopedPrisma;
  return { scoped, businessFindMany, branchFindMany };
}

const RANGE = { from: '2026-03-01', to: '2026-03-07' };

describe('AnalyticsScopeService.resolve', () => {
  it('rejects a branchId without a businessId', async () => {
    const { scoped } = fakeScoped([business()], []);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ ...RANGE, branchId: 'br-1' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a to-date before the from-date', async () => {
    const { scoped } = fakeScoped([business()], [{ id: 'br-1', businessId: 'b-1' }]);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ from: '2026-03-07', to: '2026-03-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a range longer than 366 days', async () => {
    const { scoped } = fakeScoped([business()], [{ id: 'br-1', businessId: 'b-1' }]);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ from: '2025-01-01', to: '2026-03-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a well-shaped but impossible date', async () => {
    const { scoped } = fakeScoped([business()], [{ id: 'br-1', businessId: 'b-1' }]);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ from: '2026-02-30', to: '2026-03-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('404s when the named business is not the callers', async () => {
    const { scoped } = fakeScoped([], []);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ ...RANGE, businessId: 'someone-elses' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s when the named branch is not the callers', async () => {
    const { scoped } = fakeScoped([business()], []);
    const service = new AnalyticsScopeService(scoped);
    await expect(
      service.resolve({ ...RANGE, businessId: 'b-1', branchId: 'someone-elses' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // A brand-new business with no branches is a legitimate thing to ask about.
  // Answering 404 would be a lie; the reports return their zero shape instead.
  it('returns an empty business list — not a 404 — for an owned business with no branches', async () => {
    const { scoped } = fakeScoped([business()], []);
    const service = new AnalyticsScopeService(scoped);
    const scope = await service.resolve({ ...RANGE, businessId: 'b-1' });
    expect(scope.businesses).toEqual([]);
    expect(scope.branchIds).toEqual([]);
  });

  it('excludes demo businesses when no business is named', async () => {
    const { scoped, businessFindMany } = fakeScoped(
      [business()],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const service = new AnalyticsScopeService(scoped);
    await service.resolve(RANGE);
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDemo: false } }),
    );
  });

  it('asks for one business by id when one is named, demo or not', async () => {
    const { scoped, businessFindMany } = fakeScoped(
      [business()],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const service = new AnalyticsScopeService(scoped);
    await service.resolve({ ...RANGE, businessId: 'b-1' });
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b-1' } }),
    );
  });

  it('gives each business its own window from its own day start', async () => {
    const { scoped } = fakeScoped(
      [
        business({ id: 'b-1', dayStartTime: '00:00' }),
        business({ id: 'b-2', name: 'Cafe', dayStartTime: '04:00' }),
      ],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-2', businessId: 'b-2' },
      ],
    );
    const service = new AnalyticsScopeService(scoped);
    const scope = await service.resolve(RANGE);

    const [midnight, cafe] = scope.businesses;
    expect(midnight.fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(cafe.fromUtc.toISOString()).toBe('2026-02-28T20:00:00.000Z');
    expect(cafe.dayStartMinutes).toBe(240);
  });

  it('groups each businesss own branches and unions them on the scope', async () => {
    const { scoped } = fakeScoped(
      [business({ id: 'b-1' }), business({ id: 'b-2', name: 'Two' })],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-2', businessId: 'b-1' },
        { id: 'br-3', businessId: 'b-2' },
      ],
    );
    const service = new AnalyticsScopeService(scoped);
    const scope = await service.resolve(RANGE);

    expect(scope.businesses[0].branchIds).toEqual(['br-1', 'br-2']);
    expect(scope.businesses[1].branchIds).toEqual(['br-3']);
    expect(scope.branchIds).toEqual(['br-1', 'br-2', 'br-3']);
  });

  it('reports the previous period as the equal window before this one', async () => {
    const { scoped } = fakeScoped([business()], [{ id: 'br-1', businessId: 'b-1' }]);
    const service = new AnalyticsScopeService(scoped);
    const [only] = (await service.resolve(RANGE)).businesses;

    expect(only.previousToUtc).toEqual(only.fromUtc);
    expect(only.toUtc.getTime() - only.fromUtc.getTime()).toBe(
      only.previousToUtc.getTime() - only.previousFromUtc.getTime(),
    );
  });

  it('counts the days in the range', async () => {
    const { scoped } = fakeScoped([business()], [{ id: 'br-1', businessId: 'b-1' }]);
    const service = new AnalyticsScopeService(scoped);
    expect((await service.resolve(RANGE)).dayCount).toBe(7);
  });

  it('converts the tax rate off Prisma Decimal', async () => {
    const { scoped } = fakeScoped(
      [business({ taxRate: new Prisma.Decimal('0.12') })],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const service = new AnalyticsScopeService(scoped);
    const [only] = (await service.resolve(RANGE)).businesses;
    expect(only.taxRate).toBe(0.12);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npm test -- analytics-scope
```

Expected: FAIL — `Cannot find module './analytics-scope.service'`.

- [ ] **Step 5: Write the implementation**

Create `src/portal/analytics/scope/analytics-scope.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../../common/errors/api-errors';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import {
  businessDayRangeUtc,
  businessDaySeries,
  parseDayStart,
  previousPeriod,
} from './business-day';

const MAX_RANGE_DAYS = 366;

/** A business the caller may report on, with its in-scope branches. */
export interface BusinessBranches {
  id: string;
  name: string;
  dayStartTime: string;
  dayStartMinutes: number;
  taxRate: number;
  branchIds: string[];
}

/** A business plus the UTC window derived from ITS OWN day start. */
export interface ScopedBusiness extends BusinessBranches {
  fromUtc: Date;
  toUtc: Date;
  previousFromUtc: Date;
  previousToUtc: Date;
}

export interface ResolvedScope {
  businesses: ScopedBusiness[];
  /** The union, for guards and messages. */
  branchIds: string[];
  from: string;
  to: string;
  dayCount: number;
}

/**
 * Attach a window to a business. Exported because the dashboard builds its own
 * per-business windows ("today" differs between a 00:00 business and an 04:00
 * café) rather than sharing one range.
 */
export function withWindow(
  business: BusinessBranches,
  from: string,
  to: string,
): ScopedBusiness {
  const { fromUtc, toUtc } = businessDayRangeUtc(
    from,
    to,
    business.dayStartMinutes,
  );
  const previous = previousPeriod(fromUtc, toUtc);
  return {
    ...business,
    fromUtc,
    toUtc,
    previousFromUtc: previous.fromUtc,
    previousToUtc: previous.toUtc,
  };
}

/**
 * Resolves what a report may see.
 *
 * Every id comes back through the SCOPED client, so the Task 4 choke point —
 * not this service — decides visibility. That matters more here than anywhere
 * else in the app, because the report queries themselves are raw SQL and the
 * choke point cannot see them (`scoped-prisma.ts:737` hooks `$allModels` only).
 * The branch ids this service returns are the ONLY thing standing between a
 * report and another tenant's data.
 *
 * 404 is reserved for a NAMED id that is not the caller's. An owned business
 * with no branches yet resolves to nothing and the reports answer with zeros —
 * "not found" would be a lie about a business the caller just created.
 */
@Injectable()
export class AnalyticsScopeService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async resolveBusinesses(filter: {
    businessId?: string;
    branchId?: string;
  }): Promise<BusinessBranches[]> {
    if (filter.branchId && !filter.businessId) {
      throw new ValidationFailedError('branchId requires businessId.');
    }

    const businesses = await this.scoped.business.findMany({
      where: filter.businessId ? { id: filter.businessId } : { isDemo: false },
      select: { id: true, name: true, dayStartTime: true, taxRate: true },
      orderBy: { createdAt: 'asc' },
    });
    if (businesses.length === 0) {
      throw new NotFoundError('Business not found.');
    }

    const branches = await this.scoped.branch.findMany({
      where: {
        businessId: { in: businesses.map((b) => b.id) },
        ...(filter.branchId ? { id: filter.branchId } : {}),
      },
      select: { id: true, businessId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (filter.branchId && branches.length === 0) {
      throw new NotFoundError('Branch not found.');
    }

    return businesses
      .map((b) => ({
        id: b.id,
        name: b.name,
        dayStartTime: b.dayStartTime,
        dayStartMinutes: parseDayStart(b.dayStartTime),
        taxRate: Number(b.taxRate),
        branchIds: branches
          .filter((branch) => branch.businessId === b.id)
          .map((branch) => branch.id),
      }))
      .filter((b) => b.branchIds.length > 0);
  }

  async resolve(query: AnalyticsQueryDto): Promise<ResolvedScope> {
    // business-day helpers throw plain Errors; a bad range is the caller's
    // mistake, so it must surface as 422, not 500.
    let days: string[];
    try {
      days = businessDaySeries(query.from, query.to);
    } catch (err) {
      throw new ValidationFailedError(
        err instanceof Error ? err.message : 'Invalid date range.',
      );
    }
    if (days.length > MAX_RANGE_DAYS) {
      throw new ValidationFailedError(
        `The date range must not exceed ${MAX_RANGE_DAYS} days.`,
      );
    }

    const businesses = (await this.resolveBusinesses(query)).map((b) =>
      withWindow(b, query.from, query.to),
    );

    return {
      businesses,
      branchIds: businesses.flatMap((b) => b.branchIds),
      from: query.from,
      to: query.to,
      dayCount: days.length,
    };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- analytics-scope
```

Expected: PASS, all suites.

- [ ] **Step 7: Commit**

```bash
git add src/common/validation-constants.ts src/portal/analytics/dto src/portal/analytics/scope/analytics-scope.service.ts src/portal/analytics/scope/analytics-scope.service.spec.ts
git commit -m "feat(analytics): scope resolver with per-business windows through the choke point"
```

---

## Task 5: The scoped-SQL door, report rendering, audit, and the module

Three small pieces that every report depends on, plus the Nest module that wires them. `runScoped()` is the security-critical one: raw SQL is invisible to the tenancy extension, so this is the only place a report may reach the database.

**Files:**
- Create: `src/portal/analytics/scoped-sql.ts`
- Test: `src/portal/analytics/scoped-sql.spec.ts`
- Create: `src/portal/analytics/report-response.ts`
- Test: `src/portal/analytics/report-response.spec.ts`
- Create: `src/portal/analytics/report-audit.service.ts`
- Create: `src/portal/analytics/analytics.module.ts`
- Modify: `src/portal/portal.module.ts`

**Interfaces:**
- Consumes: `ScopedBusiness`, `ResolvedScope` (Task 4); `CsvSection`, `toCsv` (Task 3); `PrismaService`; `AuditService`.
- Produces:
  - `runScoped<T>(raw: PrismaService, business: ScopedBusiness, build: (b: ScopedBusiness) => Prisma.Sql): Promise<T[]>`
  - `renderReport<T>(res: Response, reportName: string, query: AnalyticsQueryDto, data: T, toSections: (data: T) => CsvSection[]): T | string`
  - `ReportAuditService.log(scope: ResolvedScope, report: string, format: 'json' | 'csv'): Promise<void>`
  - `AnalyticsModule`

- [ ] **Step 1: Write the failing tests for `runScoped`**

Create `src/portal/analytics/scoped-sql.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';
import { runScoped } from './scoped-sql';

function fakeRaw(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return { raw: { $queryRaw: queryRaw } as unknown as PrismaService, queryRaw };
}

function scopedBusiness(over: Partial<ScopedBusiness> = {}): ScopedBusiness {
  return {
    id: 'b-1',
    name: 'Kape',
    dayStartTime: '00:00',
    dayStartMinutes: 0,
    taxRate: 0.12,
    branchIds: ['br-1'],
    fromUtc: new Date('2026-03-01T00:00:00.000Z'),
    toUtc: new Date('2026-03-08T00:00:00.000Z'),
    previousFromUtc: new Date('2026-02-22T00:00:00.000Z'),
    previousToUtc: new Date('2026-03-01T00:00:00.000Z'),
    ...over,
  };
}

const scopedQuery = (b: ScopedBusiness) =>
  Prisma.sql`SELECT 1 FROM sales WHERE branch_id = ANY(${b.branchIds}::uuid[])`;

describe('runScoped', () => {
  it('runs the built query and returns its rows', async () => {
    const { raw, queryRaw } = fakeRaw([{ n: 1 }]);
    const rows = await runScoped(raw, scopedBusiness(), scopedQuery);
    expect(rows).toEqual([{ n: 1 }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  // An empty IN-list would make `branch_id = ANY('{}')` match nothing, which
  // looks harmless — but it means a caller reached the database with no scope
  // at all, and the next refactor might drop the predicate entirely.
  it('refuses to run with no branches in scope', async () => {
    const { raw, queryRaw } = fakeRaw();
    await expect(
      runScoped(raw, scopedBusiness({ branchIds: [] }), scopedQuery),
    ).rejects.toThrow(/no branches in scope/);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // The tripwire: raw SQL bypasses the tenancy choke point entirely, so a
  // builder that forgets its scope predicate would silently read every tenant.
  it('refuses to run SQL that does not mention branch_id', async () => {
    const { raw, queryRaw } = fakeRaw();
    await expect(
      runScoped(raw, scopedBusiness(), () => Prisma.sql`SELECT 1 FROM sales`),
    ).rejects.toThrow(/branch_id/);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- scoped-sql
```

Expected: FAIL — `Cannot find module './scoped-sql'`.

- [ ] **Step 3: Write `runScoped`**

Create `src/portal/analytics/scoped-sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';

/**
 * THE door for every analytics query.
 *
 * Reports need SQL Prisma cannot express: `sale_items` has no top-level tenant
 * access (`model-scope-map.ts:60`), and `groupBy` offers no date bucketing,
 * joins, or conditional aggregates. Raw SQL is therefore unavoidable — and raw
 * SQL is INVISIBLE to the tenancy choke point, which hooks `$allModels` only
 * (`scoped-prisma.ts:737`). Nothing stops a raw query reading every tenant in
 * the database except the predicate the builder writes.
 *
 * So both guards below are deliberate, and neither is decoration:
 *
 *  1. No branches in scope → refuse. Running with an empty id list would look
 *     harmless (it matches nothing) while proving the caller reached the
 *     database with no scope at all.
 *  2. SQL that never mentions `branch_id` → refuse. Crude, cheap, and it is the
 *     one check that catches a builder which forgot its scope predicate.
 *
 * Every report query goes through here. There is no second path.
 */
export async function runScoped<T>(
  raw: PrismaService,
  business: ScopedBusiness,
  build: (business: ScopedBusiness) => Prisma.Sql,
): Promise<T[]> {
  if (business.branchIds.length === 0) {
    throw new Error(
      `runScoped: refusing to query with no branches in scope (business ${business.id})`,
    );
  }

  const sql = build(business);
  if (!sql.text.includes('branch_id')) {
    throw new Error(
      'runScoped: refusing to run analytics SQL with no branch_id predicate',
    );
  }

  return raw.$queryRaw<T[]>(sql);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- scoped-sql
```

Expected: PASS, three tests.

- [ ] **Step 5: Write the failing tests for `renderReport`**

Create `src/portal/analytics/report-response.spec.ts`:

```ts
import type { Response } from 'express';
import type { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { renderReport } from './report-response';

interface Payload {
  totalC: number;
}

const sections = (data: Payload) => [
  { columns: ['Total'], rows: [[data.totalC]] },
];

function fakeRes() {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

const query = (over: Partial<AnalyticsQueryDto> = {}): AnalyticsQueryDto =>
  ({ from: '2026-03-01', to: '2026-03-07', ...over }) as AnalyticsQueryDto;

describe('renderReport', () => {
  it('returns the object unchanged when the format is json', () => {
    const { res, setHeader } = fakeRes();
    const data = { totalC: 1000 };
    expect(renderReport(res, 'overview', query(), data, sections)).toBe(data);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('returns the object unchanged when no format is given', () => {
    const { res } = fakeRes();
    const data = { totalC: 1000 };
    expect(renderReport(res, 'overview', query(), data, sections)).toBe(data);
  });

  it('renders CSV from the same object the JSON response would carry', () => {
    const { res } = fakeRes();
    const csv = renderReport(
      res,
      'overview',
      query({ format: 'csv' }),
      { totalC: 1000 },
      sections,
    );
    expect(csv).toBe('﻿Total\r\n1000\r\n');
  });

  it('sets the CSV content type and a dated attachment filename', () => {
    const { res, setHeader } = fakeRes();
    renderReport(res, 'overview', query({ format: 'csv' }), { totalC: 0 }, sections);
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/csv; charset=utf-8',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="overview-2026-03-01-2026-03-07.csv"',
    );
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

```bash
npm test -- report-response
```

Expected: FAIL — `Cannot find module './report-response'`.

- [ ] **Step 7: Write `renderReport`**

Create `src/portal/analytics/report-response.ts`:

```ts
import type { Response } from 'express';
import { toCsv, type CsvSection } from './csv';
import type { AnalyticsQueryDto } from './dto/analytics-query.dto';

/**
 * Renders a report as JSON or CSV.
 *
 * The CSV is built from THE SAME object the JSON response returns, so an export
 * can never disagree with what is on screen. That is the whole reason this is
 * one function rather than a second set of export endpoints.
 */
export function renderReport<T>(
  res: Response,
  reportName: string,
  query: Pick<AnalyticsQueryDto, 'from' | 'to' | 'format'>,
  data: T,
  toSections: (data: T) => CsvSection[],
): T | string {
  if (query.format !== 'csv') return data;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${reportName}-${query.from}-${query.to}.csv"`,
  );
  return toCsv(toSections(data));
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm test -- report-response
```

Expected: PASS, four tests.

- [ ] **Step 9: Write the report audit service**

Create `src/portal/analytics/report-audit.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../auth/audit.service';
import type { ResolvedScope } from './scope/analytics-scope.service';

/**
 * Report reads are SENSITIVE READS (project-spec §11): report views and CSV
 * exports are logged, the same as the activity-log browse already is.
 *
 * One row per business in scope, so an all-businesses rollup still surfaces in
 * each business's own activity log rather than vanishing into a scope nobody
 * can filter by.
 */
@Injectable()
export class ReportAuditService {
  constructor(private readonly audit: AuditService) {}

  async log(
    scope: ResolvedScope,
    report: string,
    format: 'json' | 'csv',
  ): Promise<void> {
    const action =
      format === 'csv' ? 'audit.report_export' : 'audit.report_read';

    for (const business of scope.businesses) {
      await this.audit.logPortal(action, 'report', null, business.id, {
        report,
        from: scope.from,
        to: scope.to,
      });
    }
  }
}
```

- [ ] **Step 10: Wire the module**

Create `src/portal/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AnalyticsScopeService } from './scope/analytics-scope.service';
import { ReportAuditService } from './report-audit.service';

/**
 * Analytics (tenant scope), `analytics-spec.md` §0–§6.
 *
 * Controllers arrive one report at a time; this module starts as the shared
 * foundation (scope resolution + sensitive-read auditing) that all of them use.
 * `PrismaService` (raw, for `runScoped`) and `SCOPED_PRISMA` come from the
 * global `PrismaModule`; `AuthModule` supplies `PortalAuthGuard` and
 * `AuditService`.
 */
@Module({
  imports: [AuthModule],
  controllers: [],
  providers: [AnalyticsScopeService, ReportAuditService],
})
export class AnalyticsModule {}
```

Then import it in `src/portal/portal.module.ts` — add to the imports list beside `CatalogModule` and `StockModule`:

```ts
import { AnalyticsModule } from './analytics/analytics.module';
```

```ts
  imports: [AuthModule, CatalogModule, StockModule, AnalyticsModule],
```

- [ ] **Step 11: Verify the app still boots and everything passes**

```bash
npm run build && npm test && npm run lint
```

Expected: build clean, all unit suites pass, lint clean.

- [ ] **Step 12: Commit**

```bash
git add src/portal/analytics src/portal/portal.module.ts
git commit -m "feat(analytics): scoped-SQL guard, report rendering, sensitive-read audit, module"
```

---

## Task 6: Sale-seeding test helper

Every analytics e2e needs sales in the database. Going through the real POS flow (pair a terminal, open a shift, complete a sale) for each fixture would make the suites slow and brittle. This helper writes sale rows directly — but computes their money **with the real totals engine**, so a fixture can never disagree with what the POS would have written.

**Files:**
- Create: `test/helpers/sales.ts`
- Test: `test/portal-analytics-invariants.e2e-spec.ts` (first case only; the rest of that file lands in Task 11)

**Interfaces:**
- Consumes: `computeTotals` (`src/common/totals/totals`), `Cart`/`CartLine` (`src/common/totals/cart`).
- Produces:
  - `interface SeedLine { name?: string; productId?: string | null; variantId?: string | null; qty: number; unitPriceC: number; costC?: number | null; modifiers?: { groupId: string; modifierId: string; name: string; priceDeltaC: number }[]; discount?: DiscountSpec | null; scPwdMarked?: boolean }`
  - `interface SeedSaleOptions { branchId: string; terminalId: string; shiftId?: string | null; createdAt: Date; lines: SeedLine[]; orderType?: OrderType; status?: SaleStatus; statusReason?: string | null; taxRate?: number; serviceChargeRate?: number; scPwd?: { idNo: string; name: string } | null; orderDiscount?: DiscountSpec | null; paymentMethod?: PaymentMethod; receiptNo?: string }`
  - `seedSale(raw: PrismaClient, options: SeedSaleOptions): Promise<{ saleId: string; totals: CartTotals }>`
  - `seedBranchInfra(raw: PrismaClient, branchId: string): Promise<{ terminalId: string }>`

- [ ] **Step 1: Write the failing test**

Create `test/portal-analytics-invariants.e2e-spec.ts` with the bootstrap block and this first case. (Task 11 adds the tenancy, null-cost and business-day cases to the same file.)

```ts
/*
 * Analytics invariants (e2e).
 *
 * The cases here are the ones that keep the whole analytics design honest:
 * revenue must agree with the totals engine, raw SQL must not cross tenants,
 * a null cost must never read as zero, and a business day must respect its
 * own start time. Each is cheap to write and expensive to discover in
 * production.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { PrismaClient } from '@prisma/client';
import { resetDb, closeDb } from './helpers/db';
import { seedBranchInfra, seedSale } from './helpers/sales';

const raw = new PrismaClient();

describe('Analytics invariants (e2e)', () => {
  beforeAll(async () => {
    await raw.$connect();
  });

  afterAll(async () => {
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function seedBranch() {
    const owner = await raw.owner.create({
      data: { name: 'O', email: `o-${Date.now()}@t.com`, status: 'active' },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'B', type: 'fnb', taxRate: '0.12' },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const { terminalId } = await seedBranchInfra(raw, branch.id);
    return { owner, business, branch, terminalId };
  }

  // sale_items.unit_price is the BASE price; the engine's line gross adds each
  // modifier's priceDeltaC. A fixture that stored the wrong number would make
  // every revenue assertion in every other suite meaningless.
  it('seeds a sale whose stored subtotal matches the totals engine, modifiers included', async () => {
    const { branch, terminalId } = await seedBranch();

    const { saleId, totals } = await seedSale(raw, {
      branchId: branch.id,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      lines: [
        {
          name: 'Latte',
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

    const stored = await raw.sale.findUniqueOrThrow({ where: { id: saleId } });

    // 2 × (12000 + 2000) = 28000 — NOT 2 × 12000.
    expect(totals.subtotalC).toBe(28000);
    expect(stored.subtotal).toBe(28000);

    const items = await raw.saleItem.findMany({ where: { saleId } });
    expect(items[0].unitPrice).toBe(12000);
    expect(items[0].costSnapshot).toBe(4000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker compose up -d db
npm run test:e2e -- portal-analytics-invariants
```

Expected: FAIL — `Cannot find module './helpers/sales'`.

- [ ] **Step 3: Write the helper**

Create `test/helpers/sales.ts`:

```ts
import { randomUUID } from 'crypto';
import type { OrderType, PaymentMethod, PrismaClient, SaleStatus } from '@prisma/client';
import { computeTotals, type CartTotals } from '../../src/common/totals/totals';
import type { Cart, CartLine, CartModifier, DiscountSpec } from '../../src/common/totals/cart';

/**
 * Seeds sales for the analytics suites.
 *
 * Rows are written directly rather than through the POS flow (pairing, shift
 * open, sale complete) because the analytics reports only READ — the setup cost
 * of the real flow buys nothing here.
 *
 * But the money is computed by the REAL totals engine (`computeTotals`), not by
 * hand, and stored in exactly the columns `sales.service.ts` writes. That is
 * what stops a fixture drifting from production: if the engine changes, the
 * fixtures change with it, and `unit_price` keeps storing the BASE price while
 * the subtotal keeps including modifier deltas.
 */

export interface SeedLine {
  name?: string;
  productId?: string | null;
  variantId?: string | null;
  qty: number;
  unitPriceC: number;
  /** null (the default) means "no cost recorded" — margin must read unknown. */
  costC?: number | null;
  modifiers?: CartModifier[];
  discount?: DiscountSpec | null;
  scPwdMarked?: boolean;
}

export interface SeedSaleOptions {
  branchId: string;
  terminalId: string;
  shiftId?: string | null;
  /** Server timestamp the reports bucket on. */
  createdAt: Date;
  lines: SeedLine[];
  orderType?: OrderType;
  status?: SaleStatus;
  statusReason?: string | null;
  taxRate?: number;
  serviceChargeRate?: number;
  scPwd?: { idNo: string; name: string } | null;
  orderDiscount?: DiscountSpec | null;
  paymentMethod?: PaymentMethod;
  receiptNo?: string;
}

let receiptCounter = 0;

/** A terminal to hang sales off. Sales require one; most tests do not care. */
export async function seedBranchInfra(
  raw: PrismaClient,
  branchId: string,
): Promise<{ terminalId: string }> {
  const terminal = await raw.terminal.create({
    data: {
      branchId,
      name: `T-${(receiptCounter += 1)}`,
      code: `T${receiptCounter}`,
      lastSeenAt: new Date(),
    },
  });
  return { terminalId: terminal.id };
}

export async function seedSale(
  raw: PrismaClient,
  options: SeedSaleOptions,
): Promise<{ saleId: string; totals: CartTotals }> {
  const orderType = options.orderType ?? 'none';
  const taxRate = options.taxRate ?? 0.12;
  const serviceChargeRate = options.serviceChargeRate ?? 0;

  const lines: CartLine[] = options.lines.map((line) => ({
    id: randomUUID(),
    productId: line.productId ?? null,
    variantId: line.variantId ?? null,
    name: line.name ?? 'Item',
    soldBy: 'unit',
    qty: line.qty,
    unitPriceC: line.unitPriceC,
    modifiers: line.modifiers ?? [],
    discount: line.discount ?? null,
    scPwdMarked: line.scPwdMarked ?? false,
    trackStock: false,
  }));

  const cart: Cart = {
    id: randomUUID(),
    orderType,
    lines,
    orderDiscount: options.orderDiscount ?? null,
    scPwd: options.scPwd ?? null,
  };
  const totals = computeTotals(cart, { taxRate, serviceChargeRate });

  const saleId = randomUUID();
  receiptCounter += 1;

  await raw.sale.create({
    data: {
      id: saleId,
      branchId: options.branchId,
      terminalId: options.terminalId,
      shiftId: options.shiftId ?? null,
      receiptNo: options.receiptNo ?? `R-${receiptCounter}`,
      orderType,
      status: options.status ?? 'completed',
      statusReason: options.statusReason ?? null,
      subtotal: totals.subtotalC,
      discount: totals.promoDiscountC,
      serviceCharge: totals.serviceChargeC,
      scPwd: options.scPwd ?? undefined,
      scPwdDiscount: totals.scPwdDiscountC,
      vatExemptSales: totals.vatExemptSalesC,
      tax: totals.vatC,
      total: totals.totalC,
      createdAt: options.createdAt,
      createdAtDevice: options.createdAt,
      draft: {},
      items: {
        create: lines.map((line, index) => {
          const lineTotals = totals.lines[index];
          return {
            productId: line.productId,
            variantId: line.variantId,
            nameSnapshot: line.name,
            qty: line.qty,
            // The BASE price, exactly as sales.service.ts:507 stores it —
            // modifier deltas live in `modifiers`, not in this column.
            unitPrice: line.unitPriceC,
            costSnapshot: options.lines[index].costC ?? null,
            discount: lineTotals.grossC - lineTotals.netC,
            modifiers: line.modifiers,
          };
        }),
      },
      payments: {
        create: [
          {
            method: options.paymentMethod ?? 'cash',
            amount: totals.totalC,
            tendered: totals.totalC,
            change: 0,
          },
        ],
      },
    },
  });

  return { saleId, totals };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:e2e -- portal-analytics-invariants
```

Expected: PASS. If `subtotal` comes back as 24000 instead of 28000, the engine is not being used — the fixture must never compute money by hand.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/sales.ts test/portal-analytics-invariants.e2e-spec.ts
git commit -m "test(analytics): sale-seeding helper that computes money with the real totals engine"
```

---

## Task 7: Overview report (§1)

The KPI set with change against the previous equal period. This is the first report, so it also establishes the shared SQL builders every later report reuses.

**Files:**
- Create: `src/portal/analytics/reports/sales-aggregate.sql.ts`
- Create: `src/portal/analytics/overview/overview.service.ts`
- Create: `src/portal/analytics/overview/overview.controller.ts`
- Create: `src/portal/analytics/overview/overview.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-overview.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScoped` (Task 5), `AnalyticsScopeService`, `ScopedBusiness`, `ReportAuditService`, `renderReport`, `AnalyticsQueryDto`, `centavosToPesos`/`formatPct`/`CsvSection`.
- Produces:
  - `LINE_MODS_JOIN`, `LINE_NET_C`, `LINE_COST_C` — shared SQL fragments used by every revenue query in both plans
  - `saleAggregateSql(business, fromUtc, toUtc): Prisma.Sql`, `SaleAggregateRow`
  - `lineAggregateSql(business, fromUtc, toUtc): Prisma.Sql`, `LineAggregateRow`
  - `interface Kpi { value: number | null; previous: number | null; changePct: number | null }`
  - `interface OverviewReport`
  - `OverviewService.run(query: AnalyticsQueryDto): Promise<OverviewReport>`
  - `overviewCsv(report: OverviewReport): CsvSection[]`
  - `GET /v1/portal/analytics/overview`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-overview.e2e-spec.ts`:

```ts
/*
 * Analytics overview §1 (e2e).
 *
 * Asserts real figures against seeded sales, not just response shape: the KPI
 * definitions in the spec are the contract, and a shape-only test would pass
 * with every number wrong.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { resetDb, closeDb } from './helpers/db';
import { seedBranchInfra, seedSale } from './helpers/sales';

const raw = new PrismaClient();
let seq = 0;

describe('Analytics overview (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await raw.$connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter(app.get(PrismaService)));
    await app.init();
    auth = app.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function ctx(over: { dayStartTime?: string; isDemo?: boolean } = {}) {
    seq += 1;
    const owner = await raw.owner.create({
      data: {
        name: `O${seq}`,
        email: `o-${seq}-${Date.now()}@t.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `u-${seq}-${Date.now()}@t.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: 'x',
      },
    });
    const business = await raw.business.create({
      data: {
        ownerId: owner.id,
        name: `B${seq}`,
        type: 'fnb',
        taxRate: '0.12',
        dayStartTime: over.dayStartTime ?? '00:00',
        isDemo: over.isDemo ?? false,
      },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const { terminalId } = await seedBranchInfra(raw, branch.id);
    const { accessToken } = await auth.mintTokenPair(user.id, 'owner', owner.id);
    return { owner, business, branch, terminalId, token: accessToken };
  }

  const get = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/overview?${query}`)
      .set('Authorization', `Bearer ${token}`);

  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const inRange = new Date('2026-03-03T04:00:00.000Z');

  it('reports gross sales, discounts and net sales from the seeded sales', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 2, unitPriceC: 10000 }],
      orderDiscount: { source: 'free', kind: 'fixed', value: 5000 },
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossSalesC.value).toBe(20000);
    expect(res.body.discountsC.value).toBe(5000);
    expect(res.body.netSalesC.value).toBe(15000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.averageBasketC.value).toBe(15000);
  });

  it('includes modifier prices in revenue', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [
        {
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

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    // 2 × (12000 + 2000), not 2 × 12000.
    expect(res.body.grossSalesC.value).toBe(28000);
    // Profit uses the same modifier-aware revenue: 28000 − (2 × 4000).
    expect(res.body.grossProfitC.value).toBe(20000);
  });

  it('reports margin as null, never zero, when nothing is costed', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossProfitC.value).toBeNull();
    expect(res.body.marginPct.value).toBeNull();
    expect(res.body.uncostedRevenueC).toBe(10000);
    expect(res.body.costedRevenueC).toBe(0);
  });

  it('reports profit over costed items only and says how much revenue that covers', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [
        { qty: 1, unitPriceC: 10000, costC: 6000 },
        { qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossProfitC.value).toBe(4000);
    expect(res.body.costedRevenueC).toBe(10000);
    expect(res.body.uncostedRevenueC).toBe(5000);
  });

  it('excludes voided sales from money and counts them separately', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      status: 'voided',
      lines: [{ qty: 1, unitPriceC: 99900 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossSalesC.value).toBe(10000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.voidCount.value).toBe(1);
  });

  it('excludes refunded sales from money but reports their count', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      status: 'refunded',
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossSalesC.value).toBe(0);
    expect(res.body.transactions.value).toBe(0);
    expect(res.body.refundCount.value).toBe(1);
  });

  it('compares against the equal period immediately before', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 20000 }],
    });
    // 2026-02-25 falls in the previous 7-day window (02-22 .. 02-28).
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-02-25T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossSalesC.value).toBe(20000);
    expect(res.body.grossSalesC.previous).toBe(10000);
    expect(res.body.grossSalesC.changePct).toBeCloseTo(100);
  });

  it('reports changePct as null rather than infinity when the previous period was zero', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 20000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.grossSalesC.previous).toBe(0);
    expect(res.body.grossSalesC.changePct).toBeNull();
  });

  it('returns zeros for an owned business with no branches, not a 404', async () => {
    const c = await ctx();
    const empty = await raw.business.create({
      data: { ownerId: c.owner.id, name: 'Fresh', type: 'retail', taxRate: '0.12' },
    });

    const res = await get(c.token, `${RANGE}&businessId=${empty.id}`).expect(200);

    expect(res.body.grossSalesC.value).toBe(0);
    expect(res.body.transactions.value).toBe(0);
    expect(res.body.grossProfitC.value).toBeNull();
  });

  it('excludes demo businesses from an all-businesses rollup', async () => {
    const c = await ctx();
    const demo = await raw.business.create({
      data: {
        ownerId: c.owner.id,
        name: 'Demo',
        type: 'retail',
        taxRate: '0.12',
        isDemo: true,
      },
    });
    const demoBranch = await raw.branch.create({
      data: { businessId: demo.id, name: 'D', code: 'DM', address: 'x' },
    });
    const { terminalId } = await seedBranchInfra(raw, demoBranch.id);
    await seedSale(raw, {
      branchId: demoBranch.id,
      terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 77700 }],
    });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, RANGE).expect(200);

    expect(res.body.grossSalesC.value).toBe(10000);
  });

  it('rejects a branchId without a businessId with 422', async () => {
    const c = await ctx();
    await get(c.token, `${RANGE}&branchId=${c.branch.id}`).expect(422);
  });

  it('rejects a to-date before the from-date with 422', async () => {
    const c = await ctx();
    await get(c.token, 'from=2026-03-07&to=2026-03-01').expect(422);
  });

  it('rejects a malformed date with 422', async () => {
    const c = await ctx();
    await get(c.token, 'from=03-01-2026&to=2026-03-07').expect(422);
  });

  it('404s on a business the caller does not own', async () => {
    const c = await ctx();
    const other = await ctx();
    await get(c.token, `${RANGE}&businessId=${other.business.id}`).expect(404);
  });

  it('exports the same figures as CSV', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 2, unitPriceC: 10000 }],
    });

    const res = await get(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      'attachment; filename="overview-2026-03-01-2026-03-07.csv"',
    );
    expect(res.text).toContain('Gross sales,200.00');
  });

  it('audits the read, and the export separately', async () => {
    const c = await ctx();
    await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);
    await get(c.token, `${RANGE}&businessId=${c.business.id}&format=csv`).expect(200);

    const rows = await raw.auditLog.findMany({
      where: { businessId: c.business.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('audit.report_read');
    expect(actions).toContain('audit.report_export');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose up -d db
npm run test:e2e -- portal-analytics-overview
```

Expected: every case 404s — the route does not exist yet.

- [ ] **Step 3: Write the shared SQL builders**

Create `src/portal/analytics/reports/sales-aggregate.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * The shared money expressions. EVERY revenue query in both analytics plans
 * builds on these — do not hand-roll `qty * unit_price` anywhere.
 *
 * `sale_items.unit_price` is the BASE price locked at add-to-cart
 * (`sales.service.ts:507`). The totals engine's line gross is
 * `lineUnitWithModsC()` = `unitPriceC + Σ modifiers[].priceDeltaC`
 * (`cart.ts:49`), and the chosen modifiers live in the `modifiers` jsonb array.
 * So `qty * unit_price` understates every line that carries a priced modifier,
 * and Σ over a sale would not equal `sales.subtotal`.
 *
 * `round()` on numeric rounds half away from zero in Postgres, matching the
 * engine's `halfUp` for the non-negative values involved. `cost_snapshot` is a
 * UNIT cost (`sales.service.ts:664`), so line cost multiplies by qty too.
 *
 * The CASE inside the lateral is not paranoia: `jsonb_array_elements` raises on
 * a non-array, and it is evaluated in FROM before any WHERE could filter it.
 */
export const LINE_MODS_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM((m->>'priceDeltaC')::int), 0) AS mods_c
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(si.modifiers) = 'array'
           THEN si.modifiers ELSE '[]'::jsonb END
    ) AS m
  ) mods ON true
`;

/** Line gross, modifiers included. */
export const LINE_GROSS_C = Prisma.sql`round(si.qty * (si.unit_price + COALESCE(mods.mods_c, 0)))`;

/** Line gross minus the discount applied to that line. */
export const LINE_NET_C = Prisma.sql`(round(si.qty * (si.unit_price + COALESCE(mods.mods_c, 0))) - si.discount)`;

/** Line cost — `cost_snapshot` is per unit. */
export const LINE_COST_C = Prisma.sql`round(si.qty * si.cost_snapshot)`;

export interface SaleAggregateRow {
  gross_sales_c: bigint;
  discounts_c: bigint;
  service_charge_c: bigint;
  transactions: bigint;
  void_count: bigint;
  refund_count: bigint;
}

/**
 * Sale-level totals for one window.
 *
 * Voided and refunded sales are excluded from every money figure and from
 * `transactions`; both are counted separately (spec §1).
 */
export function saleAggregateSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(s.subtotal) FILTER (WHERE s.status = 'completed'), 0)::bigint AS gross_sales_c,
      COALESCE(SUM(s.discount + s.sc_pwd_discount) FILTER (WHERE s.status = 'completed'), 0)::bigint AS discounts_c,
      COALESCE(SUM(s.service_charge) FILTER (WHERE s.status = 'completed'), 0)::bigint AS service_charge_c,
      COUNT(*) FILTER (WHERE s.status = 'completed')::bigint AS transactions,
      COUNT(*) FILTER (WHERE s.status = 'voided')::bigint   AS void_count,
      COUNT(*) FILTER (WHERE s.status = 'refunded')::bigint AS refund_count
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
  `;
}

export interface LineAggregateRow {
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
  uncosted_revenue_c: bigint;
  costed_items: bigint;
}

/**
 * Line-level revenue and cost for one window, split by whether a cost was
 * recorded. `costed_items` is what lets the caller answer "is profit unknown?"
 * — a zero profit and an unknown profit are different answers.
 */
export function lineAggregateSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint AS costed_cost_c,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NULL), 0)::bigint     AS uncosted_revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint                        AS costed_items
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MODS_JOIN}
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND si.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
  `;
}
```

- [ ] **Step 4: Write the overview service**

Create `src/portal/analytics/overview/overview.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import {
  AnalyticsScopeService,
  type ScopedBusiness,
} from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  lineAggregateSql,
  saleAggregateSql,
  type LineAggregateRow,
  type SaleAggregateRow,
} from '../reports/sales-aggregate.sql';

/** A KPI and its change against the previous equal period. */
export interface Kpi {
  value: number | null;
  previous: number | null;
  /** null when there is no meaningful comparison — never Infinity. */
  changePct: number | null;
}

export interface OverviewReport {
  from: string;
  to: string;
  grossSalesC: Kpi;
  discountsC: Kpi;
  netSalesC: Kpi;
  grossProfitC: Kpi;
  marginPct: Kpi;
  transactions: Kpi;
  averageBasketC: Kpi;
  voidCount: Kpi;
  refundCount: Kpi;
  serviceChargeC: Kpi;
  /** How much of the period's revenue the profit figure actually covers. */
  costedRevenueC: number;
  uncostedRevenueC: number;
}

interface WindowTotals {
  grossSalesC: number;
  discountsC: number;
  serviceChargeC: number;
  transactions: number;
  voidCount: number;
  refundCount: number;
  costedRevenueC: number;
  costedCostC: number;
  uncostedRevenueC: number;
  costedItems: number;
}

interface Derived {
  grossSalesC: number;
  discountsC: number;
  netSalesC: number;
  grossProfitC: number | null;
  marginPct: number | null;
  transactions: number;
  averageBasketC: number | null;
  voidCount: number;
  refundCount: number;
  serviceChargeC: number;
  costedRevenueC: number;
  uncostedRevenueC: number;
}

const ZERO: WindowTotals = {
  grossSalesC: 0,
  discountsC: 0,
  serviceChargeC: 0,
  transactions: 0,
  voidCount: 0,
  refundCount: 0,
  costedRevenueC: 0,
  costedCostC: 0,
  uncostedRevenueC: 0,
  costedItems: 0,
};

function add(a: WindowTotals, b: WindowTotals): WindowTotals {
  return {
    grossSalesC: a.grossSalesC + b.grossSalesC,
    discountsC: a.discountsC + b.discountsC,
    serviceChargeC: a.serviceChargeC + b.serviceChargeC,
    transactions: a.transactions + b.transactions,
    voidCount: a.voidCount + b.voidCount,
    refundCount: a.refundCount + b.refundCount,
    costedRevenueC: a.costedRevenueC + b.costedRevenueC,
    costedCostC: a.costedCostC + b.costedCostC,
    uncostedRevenueC: a.uncostedRevenueC + b.uncostedRevenueC,
    costedItems: a.costedItems + b.costedItems,
  };
}

/**
 * Derived figures, and the two places a null is the only honest answer:
 * profit when nothing in the window carried a cost, and average basket when
 * there were no transactions to divide by.
 */
function derive(totals: WindowTotals): Derived {
  const netSalesC = totals.grossSalesC - totals.discountsC;
  const grossProfitC =
    totals.costedItems === 0 ? null : totals.costedRevenueC - totals.costedCostC;
  const marginPct =
    grossProfitC === null || totals.costedRevenueC === 0
      ? null
      : (grossProfitC / totals.costedRevenueC) * 100;

  return {
    grossSalesC: totals.grossSalesC,
    discountsC: totals.discountsC,
    netSalesC,
    grossProfitC,
    marginPct,
    transactions: totals.transactions,
    averageBasketC:
      totals.transactions === 0
        ? null
        : Math.round(netSalesC / totals.transactions),
    voidCount: totals.voidCount,
    refundCount: totals.refundCount,
    serviceChargeC: totals.serviceChargeC,
    costedRevenueC: totals.costedRevenueC,
    uncostedRevenueC: totals.uncostedRevenueC,
  };
}

function kpi(value: number | null, previous: number | null): Kpi {
  const changePct =
    value === null || previous === null || previous === 0
      ? null
      : ((value - previous) / previous) * 100;
  return { value, previous, changePct };
}

/**
 * §1 Overview.
 *
 * Runs per business — each has its own `dayStartTime` and therefore its own UTC
 * window — and sums the results. There is no cross-business query.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<OverviewReport> {
    const scope = await this.scope.resolve(query);

    let current = ZERO;
    let previous = ZERO;
    for (const business of scope.businesses) {
      current = add(
        current,
        await this.window(business, business.fromUtc, business.toUtc),
      );
      previous = add(
        previous,
        await this.window(
          business,
          business.previousFromUtc,
          business.previousToUtc,
        ),
      );
    }

    const now = derive(current);
    const before = derive(previous);

    await this.reportAudit.log(scope, 'overview', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      grossSalesC: kpi(now.grossSalesC, before.grossSalesC),
      discountsC: kpi(now.discountsC, before.discountsC),
      netSalesC: kpi(now.netSalesC, before.netSalesC),
      grossProfitC: kpi(now.grossProfitC, before.grossProfitC),
      marginPct: kpi(now.marginPct, before.marginPct),
      transactions: kpi(now.transactions, before.transactions),
      averageBasketC: kpi(now.averageBasketC, before.averageBasketC),
      voidCount: kpi(now.voidCount, before.voidCount),
      refundCount: kpi(now.refundCount, before.refundCount),
      serviceChargeC: kpi(now.serviceChargeC, before.serviceChargeC),
      costedRevenueC: now.costedRevenueC,
      uncostedRevenueC: now.uncostedRevenueC,
    };
  }

  private async window(
    business: ScopedBusiness,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<WindowTotals> {
    const [sales] = await runScoped<SaleAggregateRow>(this.raw, business, (b) =>
      saleAggregateSql(b, fromUtc, toUtc),
    );
    const [lines] = await runScoped<LineAggregateRow>(this.raw, business, (b) =>
      lineAggregateSql(b, fromUtc, toUtc),
    );

    return {
      grossSalesC: Number(sales.gross_sales_c),
      discountsC: Number(sales.discounts_c),
      serviceChargeC: Number(sales.service_charge_c),
      transactions: Number(sales.transactions),
      voidCount: Number(sales.void_count),
      refundCount: Number(sales.refund_count),
      costedRevenueC: Number(lines.costed_revenue_c),
      costedCostC: Number(lines.costed_cost_c),
      uncostedRevenueC: Number(lines.uncosted_revenue_c),
      costedItems: Number(lines.costed_items),
    };
  }
}
```

- [ ] **Step 5: Write the CSV builder**

Create `src/portal/analytics/overview/overview.csv.ts`:

```ts
import { centavosToPesos, formatPct, type CsvSection } from '../csv';
import type { Kpi, OverviewReport } from './overview.service';

const money = (k: Kpi) => [
  centavosToPesos(k.value),
  centavosToPesos(k.previous),
  formatPct(k.changePct),
];

const count = (k: Kpi) => [
  k.value === null ? '' : String(k.value),
  k.previous === null ? '' : String(k.previous),
  formatPct(k.changePct),
];

const percent = (k: Kpi) => [
  formatPct(k.value),
  formatPct(k.previous),
  formatPct(k.changePct),
];

export function overviewCsv(report: OverviewReport): CsvSection[] {
  return [
    {
      columns: ['Metric', 'Value', 'Previous period', 'Change %'],
      rows: [
        ['Gross sales', ...money(report.grossSalesC)],
        ['Discounts given', ...money(report.discountsC)],
        ['Net sales', ...money(report.netSalesC)],
        ['Gross profit', ...money(report.grossProfitC)],
        ['Margin %', ...percent(report.marginPct)],
        ['Transactions', ...count(report.transactions)],
        ['Average basket', ...money(report.averageBasketC)],
        ['Voids', ...count(report.voidCount)],
        ['Refunds', ...count(report.refundCount)],
        ['Service charge', ...money(report.serviceChargeC)],
      ],
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

- [ ] **Step 6: Write the controller**

Create `src/portal/analytics/overview/overview.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { overviewCsv } from './overview.csv';
import { OverviewService, type OverviewReport } from './overview.service';

/** §1 Overview — `GET /v1/portal/analytics/overview`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('analytics/overview')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OverviewReport | string> {
    const report = await this.overview.run(query);
    return renderReport(res, 'overview', query, report, overviewCsv);
  }
}
```

- [ ] **Step 7: Register it in the module**

In `src/portal/analytics/analytics.module.ts`, add the imports and entries:

```ts
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
```

```ts
  controllers: [OverviewController],
  providers: [AnalyticsScopeService, ReportAuditService, OverviewService],
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-overview
```

Expected: PASS, all cases. If `grossSalesC` reads 24000 where 28000 was expected, a revenue expression is using `qty * unit_price` instead of `LINE_NET_C`.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-overview.e2e-spec.ts
git commit -m "feat(analytics): overview KPIs with previous-period comparison and CSV export"
```

---

## Task 8: Sales reports (§2)

Four views over the same sales: the calendar heatmap, the trend line, hour/day patterns, and the three breakdowns.

**Files:**
- Create: `src/portal/analytics/reports/sales-buckets.sql.ts`
- Create: `src/portal/analytics/sales/sales-report.service.ts`
- Create: `src/portal/analytics/sales/sales-report.controller.ts`
- Create: `src/portal/analytics/sales/sales-report.csv.ts`
- Create: `src/portal/analytics/dto/sales-trend-query.dto.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-sales.e2e-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5, plus `LINE_MODS_JOIN`/`LINE_NET_C`/`LINE_COST_C` (Task 7).
- Produces:
  - `businessDayExpr(business): Prisma.Sql`, `SALE_NET_C`
  - `dailySalesSql`, `bucketedSalesSql`, `bucketedProfitSql`, `hourOfDaySql`, `dayOfWeekSql`, `paymentBreakdownSql`, `orderTypeBreakdownSql`, `branchBreakdownSql`
  - `class SalesTrendQueryDto extends AnalyticsQueryDto { granularity?: 'day' | 'week' | 'month' }`
  - `SalesReportService.heatmap/trend/patterns/breakdowns(query)`
  - `GET /v1/portal/analytics/sales/{heatmap,trend,patterns,breakdowns}`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-sales.e2e-spec.ts`. Copy the `beforeAll`/`afterAll`/`beforeEach`/`ctx()` bootstrap verbatim from `test/portal-analytics-overview.e2e-spec.ts` (same imports, same describe skeleton, renamed to `'Analytics sales (e2e)'`), then use these cases:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const get = (token: string, path: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/sales/${path}?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('zero-fills every day of the range so the calendar grid has no holes', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, 'heatmap', `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.days).toHaveLength(7);
    expect(res.body.days[0]).toEqual({
      date: '2026-03-01',
      salesC: 0,
      transactions: 0,
    });
    expect(res.body.days[2]).toEqual({
      date: '2026-03-03',
      salesC: 10000,
      transactions: 1,
    });
  });

  it('buckets a 3 AM sale on the previous day when the business day starts at 04:00', async () => {
    const c = await ctx({ dayStartTime: '04:00' });
    // 2026-03-03 03:00 Manila == 2026-03-02T19:00Z
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-02T19:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, 'heatmap', `${RANGE}&businessId=${c.business.id}`).expect(200);

    const byDate = Object.fromEntries(
      res.body.days.map((d: any) => [d.date, d.salesC]),
    );
    expect(byDate['2026-03-02']).toBe(10000);
    expect(byDate['2026-03-03']).toBe(0);
  });

  it('reports the trend by day with profit where costs are known', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
    });

    const res = await get(
      c.token,
      'trend',
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-03');
    expect(day.salesC).toBe(10000);
    expect(day.grossProfitC).toBe(4000);
    expect(day.transactions).toBe(1);
  });

  it('reports profit as null in a bucket where nothing was costed', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const res = await get(
      c.token,
      'trend',
      `${RANGE}&businessId=${c.business.id}&granularity=day`,
    ).expect(200);

    const day = res.body.buckets.find((b: any) => b.bucket === '2026-03-03');
    expect(day.salesC).toBe(10000);
    expect(day.grossProfitC).toBeNull();
  });

  it('groups the trend by week and by month', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const week = await get(
      c.token,
      'trend',
      `${RANGE}&businessId=${c.business.id}&granularity=week`,
    ).expect(200);
    // 2026-03-03 is a Tuesday; the ISO week starts Monday 2026-03-02.
    expect(week.body.buckets[0].bucket).toBe('2026-03-02');

    const month = await get(
      c.token,
      'trend',
      `${RANGE}&businessId=${c.business.id}&granularity=month`,
    ).expect(200);
    expect(month.body.buckets[0].bucket).toBe('2026-03-01');
  });

  it('rejects an unknown granularity with 422', async () => {
    const c = await ctx();
    await get(
      c.token,
      'trend',
      `${RANGE}&businessId=${c.business.id}&granularity=fortnight`,
    ).expect(422);
  });

  it('reports hour-of-day on the wall clock, not the business day', async () => {
    // A 3 AM sale in an 04:00 business belongs to the previous BUSINESS DAY but
    // is still 3 AM on the clock. Peaks must read as the hour they happened.
    const c = await ctx({ dayStartTime: '04:00' });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-02T19:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, 'patterns', `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.hourOfDay).toHaveLength(24);
    expect(res.body.hourOfDay[3]).toEqual({
      hour: 3,
      salesC: 10000,
      transactions: 1,
    });
    expect(res.body.hourOfDay[4].salesC).toBe(0);
  });

  it('reports day-of-week with Sunday at index 0 and every day present', async () => {
    const c = await ctx();
    // 2026-03-03 is a Tuesday.
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, 'patterns', `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(res.body.dayOfWeek).toHaveLength(7);
    expect(res.body.dayOfWeek[0].dayOfWeek).toBe(0);
    expect(res.body.dayOfWeek[2]).toEqual({
      dayOfWeek: 2,
      salesC: 10000,
      transactions: 1,
    });
  });

  it('breaks down by payment method, order type and branch', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      orderType: 'dine_in',
      paymentMethod: 'gcash',
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-04T04:00:00.000Z'),
      orderType: 'takeout',
      paymentMethod: 'cash',
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const res = await get(c.token, 'breakdowns', `${RANGE}&businessId=${c.business.id}`).expect(200);

    const byMethod = Object.fromEntries(
      res.body.byPaymentMethod.map((r: any) => [r.method, r.salesC]),
    );
    expect(byMethod.gcash).toBe(10000);
    expect(byMethod.cash).toBe(5000);

    const byType = Object.fromEntries(
      res.body.byOrderType.map((r: any) => [r.orderType, r.salesC]),
    );
    expect(byType.dine_in).toBe(10000);
    expect(byType.takeout).toBe(5000);

    expect(res.body.byBranch).toHaveLength(1);
    expect(res.body.byBranch[0]).toMatchObject({
      branchId: c.branch.id,
      name: 'Main',
      salesC: 15000,
      transactions: 2,
    });
  });

  it('exports the heatmap as CSV', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date('2026-03-03T04:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(
      c.token,
      'heatmap',
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('2026-03-03,100.00,1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-sales
```

Expected: 404 on every case — the routes do not exist.

- [ ] **Step 3: Write the bucketed SQL builders**

Create `src/portal/analytics/reports/sales-buckets.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import { MANILA_OFFSET_MINUTES } from '../scope/business-day';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import { LINE_COST_C, LINE_MODS_JOIN, LINE_NET_C } from './sales-aggregate.sql';

export type Granularity = 'day' | 'week' | 'month';

/**
 * The business day a sale belongs to, as SQL.
 *
 * Shift the UTC timestamp into Manila (+480) and back off the day start, then
 * take the date. Identical arithmetic to `businessDayOf()` in
 * `scope/business-day.ts` — the two MUST agree, and the e2e business-day case
 * is what proves they do.
 *
 * The shift is passed as an interval literal rather than `make_interval(...)`
 * so the parameter type is unambiguous to the driver.
 */
export function businessDayExpr(business: ScopedBusiness): Prisma.Sql {
  const shiftMinutes = MANILA_OFFSET_MINUTES - business.dayStartMinutes;
  return Prisma.sql`((s.created_at + ${`${shiftMinutes} minutes`}::interval)::date)`;
}

function bucketExpr(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  const day = businessDayExpr(business);
  if (granularity === 'day') return day;
  const unit = granularity === 'week' ? 'week' : 'month';
  return Prisma.sql`(date_trunc(${unit}, ${day})::date)`;
}

/**
 * Sale-level net sales: after discounts, EXCLUDING service charge — the same
 * definition as the overview's `netSalesC`, so the two reports agree.
 */
export const SALE_NET_C = Prisma.sql`(s.subtotal - s.discount - s.sc_pwd_discount)`;

/** Only completed sales count as sales; voids and refunds never do. */
const COMPLETED_IN_WINDOW = (business: ScopedBusiness) => Prisma.sql`
  WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND s.status = 'completed'
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
`;

export interface BucketSalesRow {
  bucket: Date;
  sales_c: bigint;
  transactions: bigint;
}

export function bucketedSalesSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${bucketExpr(business, granularity)} AS bucket,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS sales_c,
      COUNT(*)::bigint AS transactions
    FROM sales s
    ${COMPLETED_IN_WINDOW(business)}
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface BucketProfitRow {
  bucket: Date;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
  costed_items: bigint;
}

export function bucketedProfitSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${bucketExpr(business, granularity)} AS bucket,
      COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint AS costed_revenue_c,
      COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint AS costed_cost_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_items
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MODS_JOIN}
    ${COMPLETED_IN_WINDOW(business)}
      AND si.deleted_at IS NULL
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface HourRow {
  hour: number;
  sales_c: bigint;
  transactions: bigint;
}

/**
 * Hour of day on the MANILA WALL CLOCK, deliberately not shifted by the day
 * start: a 3 AM peak must read as 3 AM whatever time the business day begins.
 */
export function hourOfDaySql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      EXTRACT(HOUR FROM (s.created_at + ${`${MANILA_OFFSET_MINUTES} minutes`}::interval))::int AS hour,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS sales_c,
      COUNT(*)::bigint AS transactions
    FROM sales s
    ${COMPLETED_IN_WINDOW(business)}
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface DayOfWeekRow {
  day_of_week: number;
  sales_c: bigint;
  transactions: bigint;
}

/** Day of week of the BUSINESS day. Postgres DOW is 0 = Sunday, like JS. */
export function dayOfWeekSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      EXTRACT(DOW FROM ${businessDayExpr(business)})::int AS day_of_week,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS sales_c,
      COUNT(*)::bigint AS transactions
    FROM sales s
    ${COMPLETED_IN_WINDOW(business)}
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface PaymentBreakdownRow {
  method: string;
  sales_c: bigint;
  transactions: bigint;
}

/**
 * Payment split sums `sale_payments.amount`. A sale carries one method in the
 * MVP, but the payments table is the honest source and stays correct when
 * split tender arrives.
 */
export function paymentBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      sp.method::text AS method,
      COALESCE(SUM(sp.amount), 0)::bigint AS sales_c,
      COUNT(DISTINCT s.id)::bigint AS transactions
    FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id
    ${COMPLETED_IN_WINDOW(business)}
      AND sp.deleted_at IS NULL
    GROUP BY 1
    ORDER BY 2 DESC
  `;
}

export interface OrderTypeBreakdownRow {
  order_type: string;
  sales_c: bigint;
  transactions: bigint;
}

export function orderTypeBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      s.order_type::text AS order_type,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS sales_c,
      COUNT(*)::bigint AS transactions
    FROM sales s
    ${COMPLETED_IN_WINDOW(business)}
    GROUP BY 1
    ORDER BY 2 DESC
  `;
}

export interface BranchBreakdownRow {
  branch_id: string;
  name: string;
  sales_c: bigint;
  transactions: bigint;
}

export function branchBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      b.id::text AS branch_id,
      b.name     AS name,
      COALESCE(SUM(${SALE_NET_C}), 0)::bigint AS sales_c,
      COUNT(s.id)::bigint AS transactions
    FROM branches b
    LEFT JOIN sales s
      ON s.branch_id = b.id
     AND s.deleted_at IS NULL
     AND s.status = 'completed'
     AND s.created_at >= ${business.fromUtc}
     AND s.created_at <  ${business.toUtc}
    WHERE b.id = ANY(${business.branchIds}::uuid[])
      AND b.deleted_at IS NULL
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `;
}
```

- [ ] **Step 4: Write the trend query DTO**

Create `src/portal/analytics/dto/sales-trend-query.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class SalesTrendQueryDto extends AnalyticsQueryDto {
  /** Defaults to `day`. */
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month';
}
```

- [ ] **Step 5: Write the sales report service**

Create `src/portal/analytics/sales/sales-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import {
  AnalyticsScopeService,
  type ResolvedScope,
} from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  bucketedProfitSql,
  bucketedSalesSql,
  branchBreakdownSql,
  dayOfWeekSql,
  hourOfDaySql,
  orderTypeBreakdownSql,
  paymentBreakdownSql,
  type BranchBreakdownRow,
  type BucketProfitRow,
  type BucketSalesRow,
  type DayOfWeekRow,
  type Granularity,
  type HourRow,
  type OrderTypeBreakdownRow,
  type PaymentBreakdownRow,
} from '../reports/sales-buckets.sql';

export interface HeatmapDay {
  date: string;
  salesC: number;
  transactions: number;
}

export interface HeatmapReport {
  from: string;
  to: string;
  days: HeatmapDay[];
}

export interface TrendBucket {
  bucket: string;
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface TrendReport {
  from: string;
  to: string;
  granularity: Granularity;
  buckets: TrendBucket[];
}

export interface PatternsReport {
  from: string;
  to: string;
  hourOfDay: { hour: number; salesC: number; transactions: number }[];
  dayOfWeek: { dayOfWeek: number; salesC: number; transactions: number }[];
}

export interface BreakdownsReport {
  from: string;
  to: string;
  byPaymentMethod: { method: string; salesC: number; transactions: number }[];
  byOrderType: { orderType: string; salesC: number; transactions: number }[];
  byBranch: {
    branchId: string;
    name: string;
    salesC: number;
    transactions: number;
  }[];
}

/** A `::date` column arrives as a Date at UTC midnight. */
const dateKey = (value: Date): string => value.toISOString().slice(0, 10);

interface Tally {
  salesC: number;
  transactions: number;
}

function bump(map: Map<string, Tally>, key: string, add: Tally): void {
  const current = map.get(key) ?? { salesC: 0, transactions: 0 };
  map.set(key, {
    salesC: current.salesC + add.salesC,
    transactions: current.transactions + add.transactions,
  });
}

/**
 * §2 Sales.
 *
 * Every query runs per business against that business's own window, then the
 * per-bucket tallies are summed across businesses in TypeScript. Two businesses
 * with different day starts genuinely disagree about which day a 3 AM sale
 * belongs to, and merging their buckets by KEY (rather than by SQL) is what
 * keeps each one's answer its own.
 */
@Injectable()
export class SalesReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async heatmap(query: AnalyticsQueryDto): Promise<HeatmapReport> {
    const scope = await this.scope.resolve(query);
    const tallies = new Map<string, Tally>();

    for (const business of scope.businesses) {
      const rows = await runScoped<BucketSalesRow>(this.raw, business, (b) =>
        bucketedSalesSql(b, 'day'),
      );
      for (const row of rows) {
        bump(tallies, dateKey(row.bucket), {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
    }

    await this.reportAudit.log(scope, 'sales-heatmap', query.format ?? 'json');

    // Zero-fill: the calendar grid must have no holes.
    return {
      from: scope.from,
      to: scope.to,
      days: businessDaySeries(scope.from, scope.to).map((date) => ({
        date,
        salesC: tallies.get(date)?.salesC ?? 0,
        transactions: tallies.get(date)?.transactions ?? 0,
      })),
    };
  }

  async trend(query: SalesTrendQueryDto): Promise<TrendReport> {
    const granularity = query.granularity ?? 'day';
    const scope = await this.scope.resolve(query);

    const sales = new Map<string, Tally>();
    const profit = new Map<
      string,
      { costedRevenueC: number; costedCostC: number; costedItems: number }
    >();

    for (const business of scope.businesses) {
      const salesRows = await runScoped<BucketSalesRow>(
        this.raw,
        business,
        (b) => bucketedSalesSql(b, granularity),
      );
      for (const row of salesRows) {
        bump(sales, dateKey(row.bucket), {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }

      const profitRows = await runScoped<BucketProfitRow>(
        this.raw,
        business,
        (b) => bucketedProfitSql(b, granularity),
      );
      for (const row of profitRows) {
        const key = dateKey(row.bucket);
        const current = profit.get(key) ?? {
          costedRevenueC: 0,
          costedCostC: 0,
          costedItems: 0,
        };
        profit.set(key, {
          costedRevenueC: current.costedRevenueC + Number(row.costed_revenue_c),
          costedCostC: current.costedCostC + Number(row.costed_cost_c),
          costedItems: current.costedItems + Number(row.costed_items),
        });
      }
    }

    // Day granularity zero-fills from the requested range so a flat line shows
    // its zeros. Week and month buckets come from the data — a partial week at
    // either end would otherwise be indistinguishable from a quiet one.
    const keys =
      granularity === 'day'
        ? businessDaySeries(scope.from, scope.to)
        : [...new Set([...sales.keys(), ...profit.keys()])].sort();

    await this.reportAudit.log(scope, 'sales-trend', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      granularity,
      buckets: keys.map((bucket) => {
        const p = profit.get(bucket);
        return {
          bucket,
          salesC: sales.get(bucket)?.salesC ?? 0,
          transactions: sales.get(bucket)?.transactions ?? 0,
          grossProfitC:
            p === undefined || p.costedItems === 0
              ? null
              : p.costedRevenueC - p.costedCostC,
        };
      }),
    };
  }

  async patterns(query: AnalyticsQueryDto): Promise<PatternsReport> {
    const scope = await this.scope.resolve(query);
    const hours = new Map<string, Tally>();
    const days = new Map<string, Tally>();

    for (const business of scope.businesses) {
      for (const row of await runScoped<HourRow>(this.raw, business, hourOfDaySql)) {
        bump(hours, String(row.hour), {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
      for (const row of await runScoped<DayOfWeekRow>(
        this.raw,
        business,
        dayOfWeekSql,
      )) {
        bump(days, String(row.day_of_week), {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
    }

    await this.reportAudit.log(scope, 'sales-patterns', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      hourOfDay: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        salesC: hours.get(String(hour))?.salesC ?? 0,
        transactions: hours.get(String(hour))?.transactions ?? 0,
      })),
      dayOfWeek: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        salesC: days.get(String(dayOfWeek))?.salesC ?? 0,
        transactions: days.get(String(dayOfWeek))?.transactions ?? 0,
      })),
    };
  }

  async breakdowns(query: AnalyticsQueryDto): Promise<BreakdownsReport> {
    const scope = await this.scope.resolve(query);
    const methods = new Map<string, Tally>();
    const orderTypes = new Map<string, Tally>();
    const branches: BreakdownsReport['byBranch'] = [];

    for (const business of scope.businesses) {
      for (const row of await runScoped<PaymentBreakdownRow>(
        this.raw,
        business,
        paymentBreakdownSql,
      )) {
        bump(methods, row.method, {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
      for (const row of await runScoped<OrderTypeBreakdownRow>(
        this.raw,
        business,
        orderTypeBreakdownSql,
      )) {
        bump(orderTypes, row.order_type, {
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
      for (const row of await runScoped<BranchBreakdownRow>(
        this.raw,
        business,
        branchBreakdownSql,
      )) {
        branches.push({
          branchId: row.branch_id,
          name: row.name,
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
    }

    await this.reportAudit.log(scope, 'sales-breakdowns', query.format ?? 'json');

    const toRows = (map: Map<string, Tally>) =>
      [...map.entries()].sort((a, b) => b[1].salesC - a[1].salesC);

    return {
      from: scope.from,
      to: scope.to,
      byPaymentMethod: toRows(methods).map(([method, t]) => ({
        method,
        ...t,
      })),
      byOrderType: toRows(orderTypes).map(([orderType, t]) => ({
        orderType,
        ...t,
      })),
      byBranch: branches.sort((a, b) => b.salesC - a.salesC),
    };
  }
}
```

- [ ] **Step 6: Write the CSV builders**

Create `src/portal/analytics/sales/sales-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type {
  BreakdownsReport,
  HeatmapReport,
  PatternsReport,
  TrendReport,
} from './sales-report.service';

export function heatmapCsv(report: HeatmapReport): CsvSection[] {
  return [
    {
      columns: ['Date', 'Sales', 'Transactions'],
      rows: report.days.map((d) => [
        d.date,
        centavosToPesos(d.salesC),
        d.transactions,
      ]),
    },
  ];
}

export function trendCsv(report: TrendReport): CsvSection[] {
  return [
    {
      columns: ['Bucket', 'Sales', 'Gross profit', 'Transactions'],
      rows: report.buckets.map((b) => [
        b.bucket,
        centavosToPesos(b.salesC),
        centavosToPesos(b.grossProfitC),
        b.transactions,
      ]),
    },
  ];
}

export function patternsCsv(report: PatternsReport): CsvSection[] {
  return [
    {
      title: 'Hour of day',
      columns: ['Hour', 'Sales', 'Transactions'],
      rows: report.hourOfDay.map((h) => [
        h.hour,
        centavosToPesos(h.salesC),
        h.transactions,
      ]),
    },
    {
      title: 'Day of week',
      columns: ['Day of week', 'Sales', 'Transactions'],
      rows: report.dayOfWeek.map((d) => [
        d.dayOfWeek,
        centavosToPesos(d.salesC),
        d.transactions,
      ]),
    },
  ];
}

export function breakdownsCsv(report: BreakdownsReport): CsvSection[] {
  return [
    {
      title: 'By payment method',
      columns: ['Method', 'Sales', 'Transactions'],
      rows: report.byPaymentMethod.map((r) => [
        r.method,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By order type',
      columns: ['Order type', 'Sales', 'Transactions'],
      rows: report.byOrderType.map((r) => [
        r.orderType,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By branch',
      columns: ['Branch', 'Sales', 'Transactions'],
      rows: report.byBranch.map((r) => [
        r.name,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
  ];
}
```

- [ ] **Step 7: Write the controller**

Create `src/portal/analytics/sales/sales-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import {
  breakdownsCsv,
  heatmapCsv,
  patternsCsv,
  trendCsv,
} from './sales-report.csv';
import {
  SalesReportService,
  type BreakdownsReport,
  type HeatmapReport,
  type PatternsReport,
  type TrendReport,
} from './sales-report.service';

/** §2 Sales — `GET /v1/portal/analytics/sales/{heatmap,trend,patterns,breakdowns}`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class SalesReportController {
  constructor(private readonly sales: SalesReportService) {}

  @Get('analytics/sales/heatmap')
  async heatmap(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeatmapReport | string> {
    const report = await this.sales.heatmap(query);
    return renderReport(res, 'sales-heatmap', query, report, heatmapCsv);
  }

  @Get('analytics/sales/trend')
  async trend(
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrendReport | string> {
    const report = await this.sales.trend(query);
    return renderReport(res, 'sales-trend', query, report, trendCsv);
  }

  @Get('analytics/sales/patterns')
  async patterns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatternsReport | string> {
    const report = await this.sales.patterns(query);
    return renderReport(res, 'sales-patterns', query, report, patternsCsv);
  }

  @Get('analytics/sales/breakdowns')
  async breakdowns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreakdownsReport | string> {
    const report = await this.sales.breakdowns(query);
    return renderReport(res, 'sales-breakdowns', query, report, breakdownsCsv);
  }
}
```

- [ ] **Step 8: Register it in the module**

In `src/portal/analytics/analytics.module.ts`, add `SalesReportController` to `controllers` and `SalesReportService` to `providers`, with the matching imports.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-sales
```

Expected: PASS, all cases.

- [ ] **Step 10: Commit**

```bash
git add src/portal/analytics test/portal-analytics-sales.e2e-spec.ts
git commit -m "feat(analytics): sales heatmap, trend, hour/day patterns and breakdowns"
```

---

## Task 9: Tax summary (§6)

The accountant's view — one period, one CSV, ready for filing.

**Files:**
- Create: `src/portal/analytics/tax/tax-report.service.ts`
- Create: `src/portal/analytics/tax/tax-report.controller.ts`
- Create: `src/portal/analytics/tax/tax-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-tax.e2e-spec.ts`

**Interfaces:**
- Consumes: Tasks 3–5 plus `SALE_NET_C` conventions.
- Produces:
  - `interface TaxReport { from; to; businesses: TaxRow[]; totals: TaxTotals }`
  - `TaxReportService.run(query): Promise<TaxReport>`
  - `taxCsv(report): CsvSection[]`
  - `GET /v1/portal/analytics/tax`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-tax.e2e-spec.ts` with the same bootstrap as Task 7 (renamed `'Analytics tax (e2e)'`), then:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const inRange = new Date('2026-03-03T04:00:00.000Z');
  const get = (token: string, query: string) =>
    request(server())
      .get(`/v1/portal/analytics/tax?${query}`)
      .set('Authorization', `Bearer ${token}`);

  it('reports VATable sales, VAT and the service charge to the centavo', async () => {
    const c = await ctx();
    const { totals } = await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      orderType: 'dine_in',
      serviceChargeRate: 0.1,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    // The report must agree with the engine exactly — a receipt and a filing
    // that disagree by a centavo is a filing nobody can defend.
    expect(res.body.totals.vatC).toBe(totals.vatC);
    expect(res.body.totals.vatableSalesC).toBe(totals.vatableSalesC);
    expect(res.body.totals.serviceChargeC).toBe(totals.serviceChargeC);
  });

  it('reports SC/PWD discounts and VAT-exempt sales', async () => {
    const c = await ctx();
    const { totals } = await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [{ qty: 1, unitPriceC: 10000, scPwdMarked: true }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);

    expect(totals.scPwdDiscountC).toBeGreaterThan(0);
    expect(res.body.totals.scPwdDiscountC).toBe(totals.scPwdDiscountC);
    expect(res.body.totals.vatExemptSalesC).toBe(totals.vatExemptSalesC);
  });

  it('echoes each business tax rate on its own row and never blends them', async () => {
    const c = await ctx();
    const second = await raw.business.create({
      data: { ownerId: c.owner.id, name: 'Second', type: 'retail', taxRate: '0.00' },
    });
    const secondBranch = await raw.branch.create({
      data: { businessId: second.id, name: 'S', code: 'SC', address: 'x' },
    });
    await seedBranchInfra(raw, secondBranch.id);

    const res = await get(c.token, RANGE).expect(200);

    const rates = res.body.businesses.map((b: any) => b.taxRate).sort();
    expect(rates).toEqual([0, 0.12]);
    expect(res.body.totals.taxRate).toBeUndefined();
  });

  it('excludes voided sales', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      status: 'voided',
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token, `${RANGE}&businessId=${c.business.id}`).expect(200);
    expect(res.body.totals.vatC).toBe(0);
  });

  it('exports as CSV with a row per business and a totals row', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(
      c.token,
      `${RANGE}&businessId=${c.business.id}&format=csv`,
    ).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Total');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-tax
```

Expected: 404 on every case.

- [ ] **Step 3: Write the service**

Create `src/portal/analytics/tax/tax-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import {
  AnalyticsScopeService,
  type ScopedBusiness,
} from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';

export interface TaxTotals {
  vatableSalesC: number;
  vatC: number;
  vatExemptSalesC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
}

export interface TaxRow extends TaxTotals {
  businessId: string;
  name: string;
  taxRate: number;
}

export interface TaxReport {
  from: string;
  to: string;
  businesses: TaxRow[];
  totals: TaxTotals;
}

interface TaxSqlRow {
  vatable_sales_c: bigint;
  vat_c: bigint;
  vat_exempt_sales_c: bigint;
  sc_pwd_discount_c: bigint;
  service_charge_c: bigint;
}

/**
 * Mirrors the engine's own decomposition (`totals.ts`):
 *   vatC          = vatIncluded(total − vatExemptSales)
 *   vatableSalesC = total − vatExemptSales − vat
 * so a receipt and this report agree to the centavo.
 */
function taxSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(s.total - s.vat_exempt_sales - s.tax), 0)::bigint AS vatable_sales_c,
      COALESCE(SUM(s.tax), 0)::bigint                                AS vat_c,
      COALESCE(SUM(s.vat_exempt_sales), 0)::bigint                   AS vat_exempt_sales_c,
      COALESCE(SUM(s.sc_pwd_discount), 0)::bigint                    AS sc_pwd_discount_c,
      COALESCE(SUM(s.service_charge), 0)::bigint                     AS service_charge_c
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${business.fromUtc}
      AND s.created_at <  ${business.toUtc}
  `;
}

/**
 * §6 Tax summary.
 *
 * Reported per business, never blended: two businesses on different tax rates
 * have no shared rate, and averaging them would produce a number that is true
 * of neither. The `totals` block sums the amounts only — it carries no rate.
 */
@Injectable()
export class TaxReportService {
  constructor(
    private readonly raw: PrismaService,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<TaxReport> {
    const scope = await this.scope.resolve(query);
    const businesses: TaxRow[] = [];

    for (const business of scope.businesses) {
      const [row] = await runScoped<TaxSqlRow>(this.raw, business, taxSql);
      businesses.push({
        businessId: business.id,
        name: business.name,
        taxRate: business.taxRate,
        vatableSalesC: Number(row.vatable_sales_c),
        vatC: Number(row.vat_c),
        vatExemptSalesC: Number(row.vat_exempt_sales_c),
        scPwdDiscountC: Number(row.sc_pwd_discount_c),
        serviceChargeC: Number(row.service_charge_c),
      });
    }

    await this.reportAudit.log(scope, 'tax', query.format ?? 'json');

    return {
      from: scope.from,
      to: scope.to,
      businesses,
      totals: businesses.reduce<TaxTotals>(
        (sum, b) => ({
          vatableSalesC: sum.vatableSalesC + b.vatableSalesC,
          vatC: sum.vatC + b.vatC,
          vatExemptSalesC: sum.vatExemptSalesC + b.vatExemptSalesC,
          scPwdDiscountC: sum.scPwdDiscountC + b.scPwdDiscountC,
          serviceChargeC: sum.serviceChargeC + b.serviceChargeC,
        }),
        {
          vatableSalesC: 0,
          vatC: 0,
          vatExemptSalesC: 0,
          scPwdDiscountC: 0,
          serviceChargeC: 0,
        },
      ),
    };
  }
}
```

- [ ] **Step 4: Write the CSV builder**

Create `src/portal/analytics/tax/tax-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { TaxReport } from './tax-report.service';

export function taxCsv(report: TaxReport): CsvSection[] {
  const columns = [
    'Business',
    'Tax rate',
    'VATable sales',
    'VAT',
    'VAT-exempt sales',
    'SC/PWD discounts',
    'Service charge',
  ];

  return [
    {
      columns,
      rows: [
        ...report.businesses.map((b) => [
          b.name,
          b.taxRate,
          centavosToPesos(b.vatableSalesC),
          centavosToPesos(b.vatC),
          centavosToPesos(b.vatExemptSalesC),
          centavosToPesos(b.scPwdDiscountC),
          centavosToPesos(b.serviceChargeC),
        ]),
        [
          'Total',
          // No blended rate: the total row sums amounts only.
          '',
          centavosToPesos(report.totals.vatableSalesC),
          centavosToPesos(report.totals.vatC),
          centavosToPesos(report.totals.vatExemptSalesC),
          centavosToPesos(report.totals.scPwdDiscountC),
          centavosToPesos(report.totals.serviceChargeC),
        ],
      ],
    },
  ];
}
```

- [ ] **Step 5: Write the controller and register it**

Create `src/portal/analytics/tax/tax-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { taxCsv } from './tax-report.csv';
import { TaxReportService, type TaxReport } from './tax-report.service';

/** §6 Tax summary — `GET /v1/portal/analytics/tax`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class TaxReportController {
  constructor(private readonly tax: TaxReportService) {}

  @Get('analytics/tax')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxReport | string> {
    const report = await this.tax.run(query);
    return renderReport(res, 'tax', query, report, taxCsv);
  }
}
```

Add `TaxReportController` to `controllers` and `TaxReportService` to `providers` in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-tax
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-tax.e2e-spec.ts
git commit -m "feat(analytics): tax summary reported per business with no blended rate"
```

---

## Task 10: Dashboard (§0)

The portal landing — "is everything okay?" in zero clicks. It spans every non-demo business and deliberately ignores the business switcher.

**Files:**
- Create: `src/portal/analytics/reports/dashboard.sql.ts`
- Create: `src/portal/analytics/dashboard/dashboard.service.ts`
- Create: `src/portal/analytics/dashboard/dashboard.controller.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-dashboard.e2e-spec.ts`

**Interfaces:**
- Consumes: `AnalyticsScopeService.resolveBusinesses`, `withWindow`, `businessDayOf`, `addDays`, `runScoped`, `saleAggregateSql`, `lineAggregateSql`, `branchBreakdownSql`, `bucketedSalesSql`, `ReportAuditService`, `SCOPED_PRISMA`.
- Produces:
  - `lowStockCountSql(business): Prisma.Sql`, `LowStockRow`
  - `interface DashboardReport`
  - `DashboardService.run(): Promise<DashboardReport>`
  - `GET /v1/portal/dashboard`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-dashboard.e2e-spec.ts` with the same bootstrap as Task 7 (renamed `'Analytics dashboard (e2e)'`), then:

```ts
  const get = (token: string) =>
    request(server())
      .get('/v1/portal/dashboard')
      .set('Authorization', `Bearer ${token}`);

  it("reports today's sales, profit and transactions per business", async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date(),
      lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
    });

    const res = await get(c.token).expect(200);

    const row = res.body.businesses.find((b: any) => b.businessId === c.business.id);
    expect(row.today.salesC).toBe(10000);
    expect(row.today.grossProfitC).toBe(4000);
    expect(row.today.transactions).toBe(1);
  });

  it('compares against the same day last week', async () => {
    const c = await ctx();
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: lastWeek,
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const res = await get(c.token).expect(200);

    const row = res.body.businesses.find((b: any) => b.businessId === c.business.id);
    expect(row.sameDayLastWeek.salesC).toBe(5000);
    expect(row.today.salesC).toBe(0);
  });

  it('returns a 7-point sparkline ending today', async () => {
    const c = await ctx();
    const res = await get(c.token).expect(200);
    const row = res.body.businesses.find((b: any) => b.businessId === c.business.id);
    expect(row.sparkline).toHaveLength(7);
    expect(row.sparkline.every((p: any) => typeof p.salesC === 'number')).toBe(true);
  });

  it('lists per-branch rows under each business', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: new Date(),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await get(c.token).expect(200);
    const row = res.body.businesses.find((b: any) => b.businessId === c.business.id);
    expect(row.branches).toEqual([
      expect.objectContaining({ branchId: c.branch.id, name: 'Main', salesC: 10000 }),
    ]);
  });

  it('shows open shifts in the live strip', async () => {
    const c = await ctx();
    await raw.shift.create({
      data: {
        branchId: c.branch.id,
        terminalId: c.terminalId,
        openedAt: new Date(),
        openingCash: 100000,
      },
    });

    const res = await get(c.token).expect(200);

    expect(res.body.live.openShifts).toHaveLength(1);
    expect(res.body.live.openShifts[0]).toMatchObject({
      businessId: c.business.id,
      branchId: c.branch.id,
      branchName: 'Main',
    });
  });

  it('flags a shift left open longer than 24 hours', async () => {
    const c = await ctx();
    await raw.shift.create({
      data: {
        branchId: c.branch.id,
        terminalId: c.terminalId,
        openedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        openingCash: 100000,
      },
    });

    const res = await get(c.token).expect(200);

    const flag = res.body.attention.unclosedShifts.find(
      (u: any) => u.businessId === c.business.id,
    );
    expect(flag.count).toBe(1);
  });

  it('counts low stock from branch_stock against each products threshold', async () => {
    const c = await ctx();
    const category = await raw.category.create({
      data: { businessId: c.business.id, name: 'Grocery' },
    });
    const low = await raw.product.create({
      data: {
        businessId: c.business.id,
        categoryId: category.id,
        name: 'Rice',
        price: 5000,
        lowStockThreshold: '10',
      },
    });
    const fine = await raw.product.create({
      data: {
        businessId: c.business.id,
        categoryId: category.id,
        name: 'Beans',
        price: 5000,
        lowStockThreshold: '10',
      },
    });
    const untracked = await raw.product.create({
      data: {
        businessId: c.business.id,
        categoryId: category.id,
        name: 'Salt',
        price: 5000,
      },
    });
    await raw.branchStock.createMany({
      data: [
        { branchId: c.branch.id, productId: low.id, qty: '3' },
        { branchId: c.branch.id, productId: fine.id, qty: '50' },
        { branchId: c.branch.id, productId: untracked.id, qty: '0' },
      ],
    });

    const res = await get(c.token).expect(200);

    // Only the product below its threshold counts. A product with no threshold
    // set is not "low" — it is unmonitored, which is a different thing.
    const flag = res.body.attention.lowStock.find(
      (l: any) => l.businessId === c.business.id,
    );
    expect(flag.count).toBe(1);
  });

  it('reports zero unread notifications until the notification feature exists', async () => {
    const c = await ctx();
    const res = await get(c.token).expect(200);
    expect(res.body.live.unreadNotifications).toBe(0);
  });

  it('lists terminals with their last-seen and paired state', async () => {
    const c = await ctx();
    const res = await get(c.token).expect(200);
    expect(res.body.live.terminals).toEqual([
      expect.objectContaining({
        terminalId: c.terminalId,
        branchId: c.branch.id,
        paired: false,
      }),
    ]);
  });

  it('excludes demo businesses entirely', async () => {
    const c = await ctx();
    const demo = await raw.business.create({
      data: {
        ownerId: c.owner.id,
        name: 'Demo',
        type: 'retail',
        taxRate: '0.12',
        isDemo: true,
      },
    });
    await raw.branch.create({
      data: { businessId: demo.id, name: 'D', code: 'DM', address: 'x' },
    });

    const res = await get(c.token).expect(200);

    expect(
      res.body.businesses.some((b: any) => b.businessId === demo.id),
    ).toBe(false);
  });

  it('never shows another owners business', async () => {
    const c = await ctx();
    const other = await ctx();
    await seedSale(raw, {
      branchId: other.branch.id,
      terminalId: other.terminalId,
      createdAt: new Date(),
      lines: [{ qty: 1, unitPriceC: 99900 }],
    });

    const res = await get(c.token).expect(200);

    expect(
      res.body.businesses.some((b: any) => b.businessId === other.business.id),
    ).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-analytics-dashboard
```

Expected: 404 on every case.

- [ ] **Step 3: Write the low-stock SQL**

Create `src/portal/analytics/reports/dashboard.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

export interface LowStockRow {
  low_count: bigint;
}

/**
 * Low stock counted straight from `branch_stock`, not from `notifications` —
 * nothing writes that table until sub-project B, and the dashboard has to work
 * today.
 *
 * A product with NO `low_stock_threshold` is never counted: it is unmonitored,
 * which is a different state from "low", and treating it as low would fill the
 * attention list with noise on day one.
 *
 * Prisma cannot express this: comparing a column on `branch_stock` to a column
 * on `products` is a cross-table predicate, not a filter.
 */
export function lowStockCountSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS low_count
    FROM branch_stock bs
    JOIN products p ON p.id = bs.product_id
    WHERE bs.branch_id = ANY(${business.branchIds}::uuid[])
      AND bs.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND p.active = true
      AND p.track_stock = true
      AND p.low_stock_threshold IS NOT NULL
      AND bs.qty <= p.low_stock_threshold
  `;
}
```

- [ ] **Step 4: Write the dashboard service**

Create `src/portal/analytics/dashboard/dashboard.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import {
  AnalyticsScopeService,
  withWindow,
  type BusinessBranches,
  type ScopedBusiness,
} from '../scope/analytics-scope.service';
import { addDays, businessDayOf } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  lineAggregateSql,
  saleAggregateSql,
  type LineAggregateRow,
  type SaleAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  branchBreakdownSql,
  bucketedSalesSql,
  type BranchBreakdownRow,
  type BucketSalesRow,
} from '../reports/sales-buckets.sql';
import { lowStockCountSql, type LowStockRow } from '../reports/dashboard.sql';

const SPARKLINE_DAYS = 7;
const UNCLOSED_SHIFT_HOURS = 24;

export interface DayFigures {
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface DashboardBusiness {
  businessId: string;
  name: string;
  today: DayFigures;
  sameDayLastWeek: DayFigures;
  branches: { branchId: string; name: string; salesC: number; transactions: number }[];
  sparkline: { date: string; salesC: number }[];
}

export interface DashboardReport {
  businesses: DashboardBusiness[];
  live: {
    openShifts: {
      shiftId: string;
      businessId: string;
      branchId: string;
      branchName: string;
      terminalName: string;
      openedAt: Date;
    }[];
    terminals: {
      terminalId: string;
      businessId: string;
      branchId: string;
      name: string;
      code: string;
      lastSeenAt: Date | null;
      paired: boolean;
    }[];
    unreadNotifications: number;
  };
  attention: {
    lowStock: { businessId: string; count: number }[];
    unclosedShifts: { businessId: string; count: number }[];
  };
}

/**
 * §0 Dashboard — the portal landing.
 *
 * Spans every non-demo business and IGNORES the business switcher by design:
 * it is the one view that answers "is everything okay?" across the whole
 * account.
 *
 * "Today" is computed per business, because a 00:00 business and an 04:00 café
 * genuinely disagree about which day it is at 3 AM. That is why this service
 * builds its own windows from `resolveBusinesses()` + `withWindow()` rather
 * than taking a shared range.
 *
 * The live strip and attention items read through the SCOPED client wherever
 * Prisma can express the query; only the low-stock count needs raw SQL, because
 * it compares `branch_stock.qty` against a column on `products`.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly raw: PrismaService,
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly scope: AnalyticsScopeService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(): Promise<DashboardReport> {
    const businesses = await this.scope.resolveBusinesses({});
    const now = new Date();

    const rows: DashboardBusiness[] = [];
    const lowStock: { businessId: string; count: number }[] = [];

    for (const business of businesses) {
      const today = businessDayOf(now, business.dayStartMinutes);
      const lastWeek = addDays(today, -7);
      const sparkFrom = addDays(today, -(SPARKLINE_DAYS - 1));

      const todayScope = withWindow(business, today, today);
      const lastWeekScope = withWindow(business, lastWeek, lastWeek);
      const sparkScope = withWindow(business, sparkFrom, today);

      const [figuresToday, figuresLastWeek, branches, sparkline, low] =
        await Promise.all([
          this.figures(todayScope),
          this.figures(lastWeekScope),
          this.branches(todayScope),
          this.sparkline(sparkScope, sparkFrom, today),
          this.lowStockCount(todayScope),
        ]);

      rows.push({
        businessId: business.id,
        name: business.name,
        today: figuresToday,
        sameDayLastWeek: figuresLastWeek,
        branches,
        sparkline,
      });
      lowStock.push({ businessId: business.id, count: low });
    }

    const live = await this.live(businesses);
    const unclosedShifts = await this.unclosedShifts(businesses, now);

    await this.reportAudit.log(
      {
        businesses: businesses.map((b) => withWindow(b, '2026-01-01', '2026-01-01')),
        branchIds: businesses.flatMap((b) => b.branchIds),
        from: businessDayOf(now, 0),
        to: businessDayOf(now, 0),
        dayCount: 1,
      },
      'dashboard',
      'json',
    );

    return { businesses: rows, live, attention: { lowStock, unclosedShifts } };
  }

  private async figures(business: ScopedBusiness): Promise<DayFigures> {
    const [sales] = await runScoped<SaleAggregateRow>(this.raw, business, (b) =>
      saleAggregateSql(b, b.fromUtc, b.toUtc),
    );
    const [lines] = await runScoped<LineAggregateRow>(this.raw, business, (b) =>
      lineAggregateSql(b, b.fromUtc, b.toUtc),
    );

    const costedItems = Number(lines.costed_items);
    return {
      salesC: Number(sales.gross_sales_c) - Number(sales.discounts_c),
      grossProfitC:
        costedItems === 0
          ? null
          : Number(lines.costed_revenue_c) - Number(lines.costed_cost_c),
      transactions: Number(sales.transactions),
    };
  }

  private async branches(
    business: ScopedBusiness,
  ): Promise<DashboardBusiness['branches']> {
    const rows = await runScoped<BranchBreakdownRow>(
      this.raw,
      business,
      branchBreakdownSql,
    );
    return rows.map((row) => ({
      branchId: row.branch_id,
      name: row.name,
      salesC: Number(row.sales_c),
      transactions: Number(row.transactions),
    }));
  }

  private async sparkline(
    business: ScopedBusiness,
    from: string,
    to: string,
  ): Promise<{ date: string; salesC: number }[]> {
    const rows = await runScoped<BucketSalesRow>(this.raw, business, (b) =>
      bucketedSalesSql(b, 'day'),
    );
    const byDate = new Map(
      rows.map((row) => [
        row.bucket.toISOString().slice(0, 10),
        Number(row.sales_c),
      ]),
    );

    const points: { date: string; salesC: number }[] = [];
    for (let date = from; ; date = addDays(date, 1)) {
      points.push({ date, salesC: byDate.get(date) ?? 0 });
      if (date === to) break;
    }
    return points;
  }

  private async lowStockCount(business: ScopedBusiness): Promise<number> {
    const [row] = await runScoped<LowStockRow>(
      this.raw,
      business,
      lowStockCountSql,
    );
    return Number(row.low_count);
  }

  /**
   * Read through the scoped client and joined in TypeScript rather than with
   * nested `include`s: branches and terminals are small, and three flat scoped
   * reads are easier to reason about than one include tree passing through the
   * choke point's arg walker.
   */
  private async live(
    businesses: BusinessBranches[],
  ): Promise<DashboardReport['live']> {
    const branchToBusiness = new Map<string, string>();
    for (const business of businesses) {
      for (const branchId of business.branchIds) {
        branchToBusiness.set(branchId, business.id);
      }
    }
    const branchIds = [...branchToBusiness.keys()];

    const [branches, terminals, shifts, unreadNotifications] = await Promise.all([
      this.scoped.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true },
      }),
      this.scoped.terminal.findMany({
        where: { branchId: { in: branchIds } },
        select: {
          id: true,
          branchId: true,
          name: true,
          code: true,
          lastSeenAt: true,
          deviceTokenHash: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.scoped.shift.findMany({
        where: { branchId: { in: branchIds }, closedAt: null },
        select: { id: true, branchId: true, terminalId: true, openedAt: true },
        orderBy: { openedAt: 'asc' },
      }),
      this.scoped.notification.count({ where: { readAt: null } }),
    ]);

    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const terminalName = new Map(terminals.map((t) => [t.id, t.name]));

    return {
      openShifts: shifts.map((shift) => ({
        shiftId: shift.id,
        businessId: branchToBusiness.get(shift.branchId) ?? '',
        branchId: shift.branchId,
        branchName: branchName.get(shift.branchId) ?? '',
        terminalName: terminalName.get(shift.terminalId) ?? '',
        openedAt: shift.openedAt,
      })),
      terminals: terminals.map((terminal) => ({
        terminalId: terminal.id,
        businessId: branchToBusiness.get(terminal.branchId) ?? '',
        branchId: terminal.branchId,
        name: terminal.name,
        code: terminal.code,
        lastSeenAt: terminal.lastSeenAt,
        paired: terminal.deviceTokenHash !== null,
      })),
      unreadNotifications,
    };
  }

  private async unclosedShifts(
    businesses: BusinessBranches[],
    now: Date,
  ): Promise<{ businessId: string; count: number }[]> {
    const cutoff = new Date(
      now.getTime() - UNCLOSED_SHIFT_HOURS * 60 * 60 * 1000,
    );

    const counts: { businessId: string; count: number }[] = [];
    for (const business of businesses) {
      counts.push({
        businessId: business.id,
        count: await this.scoped.shift.count({
          where: {
            branchId: { in: business.branchIds },
            closedAt: null,
            openedAt: { lt: cutoff },
          },
        }),
      });
    }
    return counts;
  }
}
```

- [ ] **Step 5: Write the controller and register it**

Create `src/portal/analytics/dashboard/dashboard.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { DashboardService, type DashboardReport } from './dashboard.service';

/**
 * §0 Dashboard — `GET /v1/portal/dashboard`.
 *
 * No query parameters: it deliberately spans every non-demo business and
 * ignores the business switcher.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(): Promise<DashboardReport> {
    return this.dashboard.run();
  }
}
```

Add `DashboardController` to `controllers` and `DashboardService` to `providers` in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-dashboard
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics test/portal-analytics-dashboard.e2e-spec.ts
git commit -m "feat(analytics): portal dashboard spanning every non-demo business"
```

---

## Task 11: The invariants that keep the design honest

Three cross-cutting properties, each cheap to assert here and expensive to discover in production. The modifier-revenue case already lives in this file from Task 6.

**Files:**
- Modify: `test/portal-analytics-invariants.e2e-spec.ts`

**Interfaces:**
- Consumes: every endpoint built in Tasks 7–10, plus `seedSale`/`seedBranchInfra`.
- Produces: nothing — this task adds no source files.

- [ ] **Step 1: Add the Nest bootstrap to the invariants spec**

`test/portal-analytics-invariants.e2e-spec.ts` currently uses only a raw client. Add the same `beforeAll`/`afterAll` app bootstrap and the `ctx()` helper used in `test/portal-analytics-overview.e2e-spec.ts`, so the file can call the endpoints.

- [ ] **Step 2: Write the failing tenancy cases**

Append to the same describe block:

```ts
  const RANGE = 'from=2026-03-01&to=2026-03-07';
  const inRange = new Date('2026-03-03T04:00:00.000Z');

  // Every analytics endpoint. Any route added later belongs in this list —
  // that is the point of listing them rather than testing one.
  const REPORTS = [
    'analytics/overview',
    'analytics/sales/heatmap',
    'analytics/sales/trend',
    'analytics/sales/patterns',
    'analytics/sales/breakdowns',
    'analytics/tax',
  ];

  describe.each(REPORTS)('%s', (path) => {
    it('404s when asked about a business the caller does not own', async () => {
      const mine = await ctx();
      const theirs = await ctx();
      await request(server())
        .get(`/v1/portal/${path}?${RANGE}&businessId=${theirs.business.id}`)
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    });

    it('404s when asked about a branch the caller does not own', async () => {
      const mine = await ctx();
      const theirs = await ctx();
      await request(server())
        .get(
          `/v1/portal/${path}?${RANGE}&businessId=${mine.business.id}&branchId=${theirs.branch.id}`,
        )
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    });

    it('never includes another tenants sales in an all-businesses rollup', async () => {
      const mine = await ctx();
      const theirs = await ctx();
      await seedSale(raw, {
        branchId: theirs.branch.id,
        terminalId: theirs.terminalId,
        createdAt: inRange,
        lines: [{ qty: 1, unitPriceC: 99900 }],
      });

      const res = await request(server())
        .get(`/v1/portal/${path}?${RANGE}`)
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(200);

      // 99900 is unmistakable: if raw SQL ever loses its branch predicate, it
      // shows up here as somebody else's money.
      expect(JSON.stringify(res.body)).not.toContain('99900');
    });

    it('requires authentication', async () => {
      await request(server()).get(`/v1/portal/${path}?${RANGE}`).expect(401);
    });
  });
```

- [ ] **Step 3: Write the failing null-cost case**

```ts
  it('never reports an uncosted product as zero-margin anywhere', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const overview = await request(server())
      .get(`/v1/portal/analytics/overview?${RANGE}&businessId=${c.business.id}`)
      .set('Authorization', `Bearer ${c.token}`)
      .expect(200);

    // A zero here would claim 100% margin on a product whose cost nobody knows.
    expect(overview.body.grossProfitC.value).toBeNull();
    expect(overview.body.marginPct.value).toBeNull();

    const trend = await request(server())
      .get(
        `/v1/portal/analytics/sales/trend?${RANGE}&businessId=${c.business.id}&granularity=day`,
      )
      .set('Authorization', `Bearer ${c.token}`)
      .expect(200);

    const day = trend.body.buckets.find((b: any) => b.bucket === '2026-03-03');
    expect(day.salesC).toBe(10000);
    expect(day.grossProfitC).toBeNull();
  });

  it('writes an empty CSV field for an unknown margin, not a zero', async () => {
    const c = await ctx();
    await seedSale(raw, {
      branchId: c.branch.id,
      terminalId: c.terminalId,
      createdAt: inRange,
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const res = await request(server())
      .get(
        `/v1/portal/analytics/overview?${RANGE}&businessId=${c.business.id}&format=csv`,
      )
      .set('Authorization', `Bearer ${c.token}`)
      .expect(200);

    expect(res.text).toContain('Gross profit,,,');
  });
```

- [ ] **Step 4: Write the failing business-day case**

```ts
  it('agrees with the SQL bucketing about which business day a 3 AM sale belongs to', async () => {
    const cafe = await ctx({ dayStartTime: '04:00' });
    // 2026-03-03 03:00 Manila == 2026-03-02T19:00Z — the previous business day.
    await seedSale(raw, {
      branchId: cafe.branch.id,
      terminalId: cafe.terminalId,
      createdAt: new Date('2026-03-02T19:00:00.000Z'),
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await request(server())
      .get(
        `/v1/portal/analytics/sales/heatmap?${RANGE}&businessId=${cafe.business.id}`,
      )
      .set('Authorization', `Bearer ${cafe.token}`)
      .expect(200);

    const byDate = Object.fromEntries(
      res.body.days.map((d: any) => [d.date, d.salesC]),
    );
    expect(byDate['2026-03-02']).toBe(10000);
    expect(byDate['2026-03-03']).toBe(0);
  });

  it('keeps two businesses with different day starts in their own buckets', async () => {
    const midnight = await ctx({ dayStartTime: '00:00' });
    const cafe = await raw.business.create({
      data: {
        ownerId: midnight.owner.id,
        name: 'Cafe',
        type: 'fnb',
        taxRate: '0.12',
        dayStartTime: '04:00',
      },
    });
    const cafeBranch = await raw.branch.create({
      data: { businessId: cafe.id, name: 'C', code: 'CF', address: 'x' },
    });
    const { terminalId } = await seedBranchInfra(raw, cafeBranch.id);

    const at3am = new Date('2026-03-02T19:00:00.000Z');
    await seedSale(raw, {
      branchId: midnight.branch.id,
      terminalId: midnight.terminalId,
      createdAt: at3am,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: cafeBranch.id,
      terminalId,
      createdAt: at3am,
      lines: [{ qty: 1, unitPriceC: 20000 }],
    });

    const res = await request(server())
      .get(`/v1/portal/analytics/sales/heatmap?${RANGE}`)
      .set('Authorization', `Bearer ${midnight.token}`)
      .expect(200);

    const byDate = Object.fromEntries(
      res.body.days.map((d: any) => [d.date, d.salesC]),
    );
    // The SAME instant lands on different business days for the two businesses,
    // and the rollup sums the buckets rather than picking one calendar.
    expect(byDate['2026-03-02']).toBe(20000);
    expect(byDate['2026-03-03']).toBe(10000);
  });
```

- [ ] **Step 5: Run the tests to verify they fail, then pass**

```bash
npm run test:e2e -- portal-analytics-invariants
```

Expected: every case passes against the code from Tasks 7–10. Any failure here is a real defect in that code, not in the test — fix the source, not the assertion. In particular:
- a `99900` appearing in a rollup means a report query lost its branch predicate;
- a `0` where `null` was expected means a costed/uncosted split is missing its `costed_items` guard;
- a heatmap date one day out means `businessDayExpr` and `businessDayOf` have drifted apart.

- [ ] **Step 6: Run the whole suite and the linter**

```bash
npm test && npm run test:e2e && npm run lint && npm run build
```

Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add test/portal-analytics-invariants.e2e-spec.ts
git commit -m "test(analytics): tenancy, null-cost and business-day invariants across every report"
```

---

## Self-review notes

Checked against the spec after writing:

**Spec coverage.** §0 dashboard → Task 10. §1 overview → Task 7. §2 sales (heatmap, trend, patterns, breakdowns) → Task 8. §6 tax → Task 9. CSV on every report → Task 3 + each report's `*.csv.ts`. Scope resolver → Task 4. `runScoped` → Task 5. Business-day bucketing → Tasks 2 and 8. Null-cost rule → Tasks 7 and 11. Sensitive reads → Task 5, asserted in Task 7. Catalog modifier-group read → Task 1. §3, §4 and §5 are plan 2, as the spec states.

**Deliberate deviation from the spec, recorded here.** The spec's §2 lists heatmap, trend and patterns as one "Sales" group; this plan exposes `patterns` as its own endpoint rather than folding it into `trend`, because the two have different shapes (24+7 fixed buckets versus a variable date series) and one endpoint returning both would force every caller to fetch what it does not need.

**Interface consistency.** `ScopedBusiness` is produced in Task 4 and consumed by name in Tasks 5, 7, 8, 9, 10. `LINE_MODS_JOIN`/`LINE_NET_C`/`LINE_COST_C` are produced in Task 7 and reused in Task 8. `bucketedSalesSql` and `branchBreakdownSql` are produced in Task 8 and reused in Task 10 — **Task 10 therefore depends on Task 8 and must not be reordered before it.** `saleAggregateSql`/`lineAggregateSql` are produced in Task 7 and reused in Task 10. `centavosToPesos`/`formatPct`/`CsvSection` are produced in Task 3 and used by every `*.csv.ts`. `seedSale` is produced in Task 6 and used by Tasks 7–11.

**Task order is a dependency order.** 1 is independent. 2 and 3 are independent of each other. 4 needs 2. 5 needs 3 and 4. 6 is independent of 2–5 but needed by 7. 7 needs 5 and 6. 8 needs 7. 9 needs 5 and 6. 10 needs 7 and 8. 11 needs 7–10.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-06-analytics-money-reports.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

