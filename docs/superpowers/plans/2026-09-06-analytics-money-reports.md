# Analytics Money Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the portal's dashboard, overview, sales and tax reports — with CSV export and every shared mechanism they need — plus the product read that returns its linked modifier groups.

**Architecture:** A new `src/portal/analytics/` module. One scope resolver turns a shared query DTO into per-business windows (each business has its own `dayStartTime`, so each has its own UTC interval); every report query is hand-written SQL run through a `runScoped()` helper that forces a `branch_id` predicate bound from ids the tenancy choke point produced. Reports return JSON or, with `?format=csv`, the same object rendered by one shared CSV writer.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest (unit: `npm test`, rootDir `src`, `*.spec.ts`) and Jest e2e (`npm run test:e2e`, rootDir `test`, `*.e2e-spec.ts`) with supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-portal-analytics-and-dashboard-design.md`. This plan is 1 of 2; plan 2 covers §3 products, §4 profit & leaks, §5 inventory and introduces no new infrastructure.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Integer centavos everywhere.** SQL aggregates cast to `::bigint`; convert with `Number()` at the edge. Money fields in responses are suffixed `C` and are integers.
- **A null cost is `null`, never `0`.** A zero reports 100% margin on every uncosted product. Where cost is unset, margin and profit are `null`.
- **Every analytics query runs per business**, and results merge in TypeScript. There is no query spanning businesses — `dayStartTime` differs per business, so a shared bucket would be wrong.
- **Every analytics query goes through `runScoped()`** and must contain a `branch_id` predicate bound from `business.branchIds`. Raw SQL bypasses the tenancy choke point (`scoped-prisma.ts:737` hooks `$allModels` only).
- **Line gross is `round(qty * (unit_price + Σ modifier priceDeltaC))`, never `qty * unit_price`.** `sale_items.unit_price` is the base price without modifiers (`sales.service.ts:507`); the engine's gross includes them (`cart.ts:49`). `cost_snapshot` is the **unit** cost (`sales.service.ts:664`), so line cost is `round(qty * cost_snapshot)`.
- **Voided sales are excluded from every money figure and from transaction counts. Refunded sales are excluded from money figures but their count is reported.**
- **Validation failures are 422 `validation`** (the global pipe uses `errorHttpStatusCode: UNPROCESSABLE_ENTITY`, `main.ts:16`). A named id the caller does not own is 404 `not_found`. An owned business with no branches is a 200 with zeros, never a 404.
- **Asia/Manila is UTC+8 year-round** (no DST since 1978), so fixed-offset arithmetic is correct. Write that reason down wherever the offset appears.
- **Routes** live under the `v1` global prefix, in `@Controller('portal')` classes gated by `@UseGuards(PortalAuthGuard)`.
- **Sensitive reads** append `audit.report_read`; CSV exports append `audit.report_export`.
- **Git:** commit on `main`. Never add a `Co-Authored-By: Claude` trailer or any AI attribution. Never run `git push` — stop and tell the user instead.

## File Structure

**New module — `src/portal/analytics/`:**

| File | Responsibility |
|---|---|
| `analytics.module.ts` | Wires controllers and providers; imported by `PortalModule` |
| `dto/analytics-query.dto.ts` | The shared query DTO every report accepts |
| `scope/business-day.ts` | Pure business-day ↔ UTC arithmetic. No Nest, no Prisma |
| `scope/analytics-scope.service.ts` | `AnalyticsQueryDto` → `ResolvedScope` via the scoped client |
| `scoped-sql.ts` | `runScoped()` — the only way analytics touches raw SQL |
| `csv.ts` | Pure CSV writer + centavos→pesos rendering |
| `report-response.ts` | JSON-or-CSV rendering and the `Content-Disposition` header |
| `report-audit.service.ts` | `audit.report_read` / `audit.report_export` rows |
| `reports/*.sql.ts` | Pure `Prisma.Sql` builders, one file per report family |
| `overview/`, `sales/`, `tax/`, `dashboard/` | One controller + service + CSV shaper per spec tab |

**Modified:** `src/portal/portal.module.ts` (import `AnalyticsModule`), `src/portal/catalog/products.service.ts` (Task 1), `src/common/validation-constants.ts` (Task 4).

**New test helper:** `test/helpers/sales.ts` — seeds sales through the real totals engine so report SQL is checked against the same arithmetic the POS uses.

---

### Task 1: Product read returns its linked modifier groups

The portal's modifier-links editor currently warns on screen that it cannot show the current selection, because there is no way to read it. `GET /v1/portal/products/:id` includes variants only.

**Files:**
- Modify: `src/portal/catalog/products.service.ts` (the `ProductWithVariants` type, `VARIANTS_INCLUDE`, `ProductResponse`, `serializeProduct`)
- Test: `test/portal-modifiers-discounts.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProductResponse.modifierGroupIds: string[]` — the ids currently linked, oldest link first. Present on every product read (`list`, `get`, `create`, `update`, `remove`).

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('Portal modifiers + discounts (e2e)')` block in `test/portal-modifiers-discounts.e2e-spec.ts`. The file already provides `ctx()` (returns `{ token, businessId, categoryId, productId }`), `createGroup(token, businessId, body)`, `milkGroup()` and `server()`.

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

  it('reports an empty link set as [] once the links are cleared', async () => {
    const { token, businessId, productId } = await ctx();
    const group = await createGroup(token, businessId, milkGroup());

    const link = (groupIds: string[]) =>
      request(server())
        .put(`/v1/portal/products/${productId}/modifier-groups`)
        .set('Authorization', `Bearer ${token}`)
        .send({ groupIds })
        .expect(200);

    await link([group.id]);
    await link([]);

    const res = await request(server())
      .get(`/v1/portal/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.modifierGroupIds).toEqual([]);
  });

  it('lists products with their link sets, so the list cannot claim "no groups" wrongly', async () => {
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

    const listed = res.body.find((p: any) => p.id === productId);
    expect(listed.modifierGroupIds).toEqual([group.id]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:e2e -- portal-modifiers-discounts
```

Expected: three failures, each `expect(received).toEqual(expected)` with `received: undefined` — `modifierGroupIds` is not on the response.

- [ ] **Step 3: Find every place the product include is used**

```bash
grep -n "VARIANTS_INCLUDE\|ProductWithVariants" src/portal/catalog/products.service.ts
```

Expected: the `type ProductWithVariants` declaration (~line 16), the `const VARIANTS_INCLUDE` declaration (~line 25), and four `include: VARIANTS_INCLUDE` call sites plus the `loadOwned` return type. Every one changes in the next step; the compiler will catch any you miss.

- [ ] **Step 4: Widen the include and the response**

In `src/portal/catalog/products.service.ts`, replace the type and the include constant:

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
 * `deletedAt: null`, so only live variants and live links come back.
 *
 * `productModifierGroups` is a CHILD_ONLY model — no top-level access — but a
 * relation include through its scoped parent is exactly how it is meant to be
 * read. Every read path uses THIS constant so `modifierGroupIds` is never a
 * guess: a response that said `[]` because the caller forgot the include would
 * be indistinguishable from a product with no groups.
 */
const PRODUCT_INCLUDE = {
  variants: { orderBy: { createdAt: 'asc' as const } },
  productModifierGroups: {
    select: { groupId: true },
    orderBy: { createdAt: 'asc' as const },
  },
};
```

Rename every `VARIANTS_INCLUDE` usage to `PRODUCT_INCLUDE` and every `ProductWithVariants` to `ProductWithRelations`.

Add the field to the response interface, after `variants`:

```ts
export interface ProductResponse {
  // ...existing fields, unchanged...
  variants: VariantResponse[];
  modifierGroupIds: string[];
}
```

And in `serializeProduct`, **require** the relation rather than defaulting it — the compiler then guarantees every call site loaded it:

```ts
function serializeProduct(
  p: Product & {
    variants?: ProductVariant[];
    productModifierGroups: { groupId: string }[];
  },
): ProductResponse {
  return {
    // ...existing fields, unchanged...
    variants: (p.variants ?? []).map(serializeVariant),
    modifierGroupIds: p.productModifierGroups.map((link) => link.groupId),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-modifiers-discounts
npm run lint && npm run build
```

Expected: the whole file passes, including the pre-existing cases. Lint and build clean.

- [ ] **Step 6: Commit**

```bash
git add src/portal/catalog/products.service.ts test/portal-modifiers-discounts.e2e-spec.ts
git commit -m "feat(api): return a product's linked modifier group ids on every product read"
```

---

### Task 2: Business-day arithmetic

`Business.dayStartTime` has existed since the first migration and nothing reads it. Analytics is its first consumer. This task is pure functions and unit tests — no Nest, no Prisma, no database.

**Files:**
- Create: `src/portal/analytics/scope/business-day.ts`
- Test: `src/portal/analytics/scope/business-day.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MANILA_OFFSET_MINUTES: number`
  - `parseDayStart(dayStartTime: string): number`
  - `businessDayStartUtc(date: string, dayStartMinutes: number): Date`
  - `businessDayOf(instant: Date, dayStartMinutes: number): string`
  - `businessDaySeries(from: string, to: string): string[]`
  - `businessDayRangeUtc(from: string, to: string, dayStartMinutes: number): { fromUtc: Date; toUtc: Date }`
  - `previousPeriod(fromUtc: Date, toUtc: Date): { fromUtc: Date; toUtc: Date }`

- [ ] **Step 1: Write the failing tests**

Create `src/portal/analytics/scope/business-day.spec.ts`:

```ts
import {
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

  it('rejects anything that is not HH:mm', () => {
    expect(() => parseDayStart('4:00')).toThrow();
    expect(() => parseDayStart('24:00')).toThrow();
    expect(() => parseDayStart('')).toThrow();
  });
});

describe('businessDayStartUtc', () => {
  it('starts a midnight business day at 16:00 UTC the day before', () => {
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
  // 03:00 Manila on 2 March is 19:00 UTC on 1 March.
  const threeAm = new Date('2026-03-01T19:00:00.000Z');

  it('puts a 3 AM sale on the same date for a midnight business', () => {
    expect(businessDayOf(threeAm, 0)).toBe('2026-03-02');
  });

  it('puts a 3 AM sale on the PREVIOUS date for an 04:00 cafe', () => {
    expect(businessDayOf(threeAm, 240)).toBe('2026-03-01');
  });

  it('puts a 5 AM sale on the same date for an 04:00 cafe', () => {
    const fiveAm = new Date('2026-03-01T21:00:00.000Z');
    expect(businessDayOf(fiveAm, 240)).toBe('2026-03-02');
  });
});

describe('businessDaySeries', () => {
  it('lists every date inclusive of both ends', () => {
    expect(businessDaySeries('2026-03-01', '2026-03-04')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('returns a single day when from equals to', () => {
    expect(businessDaySeries('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
  });

  it('crosses a month boundary', () => {
    expect(businessDaySeries('2026-02-27', '2026-03-01')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('throws when `to` precedes `from`', () => {
    expect(() => businessDaySeries('2026-03-04', '2026-03-01')).toThrow();
  });
});

describe('businessDayRangeUtc', () => {
  it('spans from the first day start to the day start AFTER the last date', () => {
    const range = businessDayRangeUtc('2026-03-01', '2026-03-02', 0);
    expect(range.fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(range.toUtc.toISOString()).toBe('2026-03-02T16:00:00.000Z');
  });

  it('covers exactly 24 hours for a single day', () => {
    const range = businessDayRangeUtc('2026-03-01', '2026-03-01', 240);
    expect(range.toUtc.getTime() - range.fromUtc.getTime()).toBe(86_400_000);
  });
});

describe('previousPeriod', () => {
  it('is the equal-length window ending where this one starts', () => {
    const fromUtc = new Date('2026-03-08T16:00:00.000Z');
    const toUtc = new Date('2026-03-15T16:00:00.000Z');
    const prev = previousPeriod(fromUtc, toUtc);
    expect(prev.toUtc).toEqual(fromUtc);
    expect(prev.fromUtc.toISOString()).toBe('2026-03-01T16:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- business-day
```

Expected: FAIL — `Cannot find module './business-day'`.

- [ ] **Step 3: Implement the module**

Create `src/portal/analytics/scope/business-day.ts`:

```ts
/**
 * Business-day arithmetic (project-spec §7 "Business day").
 *
 * A business day runs `[date + dayStartTime, nextDate + dayStartTime)` in
 * Asia/Manila. A 2 AM cafe setting `04:00` puts a 3 AM sale on the previous
 * calendar date, which is the entire point of the field.
 *
 * The Philippines has observed no DST since 1978, so Asia/Manila is UTC+8 all
 * year and fixed-offset arithmetic is exact here. Anywhere with DST would need
 * a real timezone library; this deliberately does not.
 */

export const MANILA_OFFSET_MINUTES = 8 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** `HH:mm` to minutes past midnight. Throws on anything else. */
export function parseDayStart(dayStartTime: string): number {
  const match = HHMM.exec(dayStartTime);
  if (!match) {
    throw new Error(`Invalid dayStartTime: ${JSON.stringify(dayStartTime)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Invalid date: ${JSON.stringify(date)}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** The UTC instant at which the given business day begins. */
export function businessDayStartUtc(date: string, dayStartMinutes: number): Date {
  const { y, m, d } = parseDate(date);
  // Manila wall clock to UTC: subtract the offset from the local minute count.
  return new Date(Date.UTC(y, m - 1, d, 0, dayStartMinutes - MANILA_OFFSET_MINUTES));
}

/** The business day (YYYY-MM-DD) an instant falls on. */
export function businessDayOf(instant: Date, dayStartMinutes: number): string {
  const shifted = new Date(
    instant.getTime() + (MANILA_OFFSET_MINUTES - dayStartMinutes) * 60_000,
  );
  return shifted.toISOString().slice(0, 10);
}

/** Every business day from `from` to `to`, both inclusive. */
export function businessDaySeries(from: string, to: string): string[] {
  const start = businessDayStartUtc(from, 0).getTime();
  const end = businessDayStartUtc(to, 0).getTime();
  if (end < start) {
    throw new Error(`Range ends before it starts: ${from}..${to}`);
  }
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(businessDayOf(new Date(t), 0));
  }
  return days;
}

/** `[fromUtc, toUtc)` covering both endpoint days in full. */
export function businessDayRangeUtc(
  from: string,
  to: string,
  dayStartMinutes: number,
): { fromUtc: Date; toUtc: Date } {
  const fromUtc = businessDayStartUtc(from, dayStartMinutes);
  const lastStart = businessDayStartUtc(to, dayStartMinutes);
  if (lastStart.getTime() < fromUtc.getTime()) {
    throw new Error(`Range ends before it starts: ${from}..${to}`);
  }
  return { fromUtc, toUtc: new Date(lastStart.getTime() + DAY_MS) };
}

/** The equal-length window immediately preceding `[fromUtc, toUtc)`. */
export function previousPeriod(
  fromUtc: Date,
  toUtc: Date,
): { fromUtc: Date; toUtc: Date } {
  const length = toUtc.getTime() - fromUtc.getTime();
  return { fromUtc: new Date(fromUtc.getTime() - length), toUtc: new Date(fromUtc) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- business-day
npm run lint
```

Expected: all pass. Note `businessDaySeries` steps by fixed 24h days and formats through `businessDayOf(..., 0)`, which is safe precisely because there is no DST.

- [ ] **Step 5: Commit**

```bash
git add src/portal/analytics/scope/business-day.ts src/portal/analytics/scope/business-day.spec.ts
git commit -m "feat(api): business-day arithmetic against each business's day start time"
```

---

### Task 3: CSV writer

Every report exports through this one function, over the same object the JSON response returns, so an export can never drift from what is on screen.

**Files:**
- Create: `src/portal/analytics/csv.ts`
- Test: `src/portal/analytics/csv.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CsvSection { title?: string; columns: string[]; rows: (string | number | null)[][] }`
  - `toCsv(sections: CsvSection[]): string`
  - `centavosToPesos(c: number | null): string`

- [ ] **Step 1: Write the failing tests**

Create `src/portal/analytics/csv.spec.ts`:

```ts
import { centavosToPesos, toCsv } from './csv';

describe('centavosToPesos', () => {
  it('renders centavos as two-decimal pesos without a currency symbol', () => {
    expect(centavosToPesos(125000)).toBe('1250.00');
    expect(centavosToPesos(5)).toBe('0.05');
    expect(centavosToPesos(0)).toBe('0.00');
  });

  it('renders a negative amount with a leading minus', () => {
    expect(centavosToPesos(-2550)).toBe('-25.50');
  });

  it('renders null as an empty field, never as zero', () => {
    expect(centavosToPesos(null)).toBe('');
  });
});

describe('toCsv', () => {
  it('starts with a BOM and separates rows with CRLF', () => {
    const csv = toCsv([{ columns: ['a', 'b'], rows: [[1, 2]] }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('quotes fields containing a comma, a quote or a newline', () => {
    const csv = toCsv([
      {
        columns: ['name'],
        rows: [['Ay, caramba'], ['She said "hi"'], ['line\nbreak']],
      },
    ]);
    expect(csv).toContain('"Ay, caramba"');
    expect(csv).toContain('"She said ""hi"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it('writes null as an empty field', () => {
    const csv = toCsv([{ columns: ['a', 'b'], rows: [[null, 1]] }]);
    expect(csv).toContain(',1');
    expect(csv).toBe('﻿a,b\r\n,1\r\n');
  });

  it('separates multiple sections with a blank line and a title row', () => {
    const csv = toCsv([
      { title: 'By branch', columns: ['branch'], rows: [['Main']] },
      { title: 'By method', columns: ['method'], rows: [['cash']] },
    ]);
    expect(csv).toBe(
      '﻿By branch\r\nbranch\r\nMain\r\n\r\nBy method\r\nmethod\r\ncash\r\n',
    );
  });

  it('emits only headers for a section with no rows', () => {
    expect(toCsv([{ columns: ['a'], rows: [] }])).toBe('﻿a\r\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- csv
```

Expected: FAIL — `Cannot find module './csv'`.

- [ ] **Step 3: Implement the writer**

Create `src/portal/analytics/csv.ts`:

```ts
/**
 * The one CSV writer every report export goes through, applied to the SAME
 * object the JSON response returns — so an export can never drift from what the
 * portal shows.
 *
 * RFC 4180: CRLF line endings, fields containing a comma, a double quote, CR or
 * LF are quoted, and embedded quotes are doubled. A leading BOM makes Excel open
 * the file as UTF-8 instead of guessing a local codepage.
 */

export interface CsvSection {
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
}

const BOM = '﻿';
const EOL = '\r\n';

/**
 * Money leaves the API as integer centavos, but a CSV goes to an accountant,
 * not a parser — so exports render pesos. `null` becomes an empty field: an
 * unknown cost is not a zero cost.
 */
export function centavosToPesos(c: number | null): string {
  if (c === null) return '';
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function escapeField(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/portal/analytics/csv.ts src/portal/analytics/csv.spec.ts
git commit -m "feat(api): rfc 4180 csv writer with peso rendering for report exports"
```

---

### Task 4: Query DTO and the scope resolver

Turns the shared query into per-business windows. Every report depends on this and on nothing else for scoping.

**Files:**
- Create: `src/portal/analytics/dto/analytics-query.dto.ts`
- Create: `src/portal/analytics/scope/analytics-scope.service.ts`
- Modify: `src/common/validation-constants.ts` (add `ISO_DATE_REGEX`)
- Test: `src/portal/analytics/scope/analytics-scope.service.spec.ts`

**Interfaces:**
- Consumes: `parseDayStart`, `businessDayRangeUtc`, `businessDaySeries`, `previousPeriod` from `../scope/business-day`; `SCOPED_PRISMA`/`ScopedPrisma` from `../../../prisma/scoped-prisma.provider`; `NotFoundError`, `ValidationFailedError` from `../../../common/errors/api-errors`.
- Produces:
  - `class AnalyticsQueryDto { businessId?: string; branchId?: string; from: string; to: string; format?: 'json' | 'csv' }`
  - `interface ScopedBusiness { id, name, dayStartTime, dayStartMinutes, taxRate, branchIds, fromUtc, toUtc, previousFromUtc, previousToUtc }`
  - `interface ResolvedScope { businesses: ScopedBusiness[]; branchIds: string[]; from: string; to: string; dayCount: number }`
  - `class AnalyticsScopeService { resolve(query: AnalyticsQueryDto): Promise<ResolvedScope> }`

- [ ] **Step 1: Write the failing tests**

The service's only dependency is the scoped client's `business.findMany` and `branch.findMany`, so this is a unit test with a hand-rolled stub — no database, and it exercises the real validation and windowing logic.

Create `src/portal/analytics/scope/analytics-scope.service.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { AnalyticsScopeService } from './analytics-scope.service';
import type { ScopedPrisma } from '../../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../../common/errors/api-errors';
import type { AnalyticsQueryDto } from '../dto/analytics-query.dto';

type BusinessRow = {
  id: string;
  name: string;
  dayStartTime: string;
  taxRate: Prisma.Decimal;
};
type BranchRow = { id: string; businessId: string };

function makeService(businesses: BusinessRow[], branches: BranchRow[]) {
  const businessFindMany = jest.fn().mockResolvedValue(businesses);
  const branchFindMany = jest.fn().mockResolvedValue(branches);
  const scoped = {
    business: { findMany: businessFindMany },
    branch: { findMany: branchFindMany },
  } as unknown as ScopedPrisma;
  return {
    service: new AnalyticsScopeService(scoped),
    businessFindMany,
    branchFindMany,
  };
}

const midnight: BusinessRow = {
  id: 'b-1',
  name: 'Retail',
  dayStartTime: '00:00',
  taxRate: new Prisma.Decimal('0.12'),
};
const cafe: BusinessRow = {
  id: 'b-2',
  name: 'Cafe',
  dayStartTime: '04:00',
  taxRate: new Prisma.Decimal('0.12'),
};

const query = (over: Partial<AnalyticsQueryDto> = {}): AnalyticsQueryDto =>
  ({ from: '2026-03-01', to: '2026-03-07', ...over }) as AnalyticsQueryDto;

describe('AnalyticsScopeService.resolve', () => {
  it('rejects a branchId without a businessId', async () => {
    const { service } = makeService([midnight], []);
    await expect(service.resolve(query({ branchId: 'br-1' }))).rejects.toThrow(
      ValidationFailedError,
    );
  });

  it('rejects a range that ends before it starts', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ from: '2026-03-07', to: '2026-03-01' })),
    ).rejects.toThrow(ValidationFailedError);
  });

  it('rejects a range longer than 366 days', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ from: '2025-01-01', to: '2026-03-01' })),
    ).rejects.toThrow(ValidationFailedError);
  });

  it('excludes demo businesses when no business is named', async () => {
    const { service, businessFindMany } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    await service.resolve(query());
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDemo: false } }),
    );
  });

  it('asks for exactly the named business, demo or not', async () => {
    const { service, businessFindMany } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    await service.resolve(query({ businessId: 'b-1' }));
    expect(businessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b-1' } }),
    );
  });

  it('404s when the named business does not belong to the caller', async () => {
    const { service } = makeService([], []);
    await expect(service.resolve(query({ businessId: 'b-9' }))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('404s when the named branch does not belong to the caller', async () => {
    const { service } = makeService([midnight], []);
    await expect(
      service.resolve(query({ businessId: 'b-1', branchId: 'br-9' })),
    ).rejects.toThrow(NotFoundError);
  });

  it('returns an empty business list — not a 404 — for an owned business with no branches', async () => {
    const { service } = makeService([midnight], []);
    const scope = await service.resolve(query({ businessId: 'b-1' }));
    expect(scope.businesses).toEqual([]);
    expect(scope.branchIds).toEqual([]);
    expect(scope.dayCount).toBe(7);
  });

  it('groups branches under their own business', async () => {
    const { service } = makeService(
      [midnight, cafe],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-2', businessId: 'b-1' },
        { id: 'br-3', businessId: 'b-2' },
      ],
    );
    const scope = await service.resolve(query());
    expect(scope.businesses.map((b) => b.branchIds)).toEqual([
      ['br-1', 'br-2'],
      ['br-3'],
    ]);
    expect(scope.branchIds).toEqual(['br-1', 'br-2', 'br-3']);
  });

  it('gives each business its own window, because day starts differ', async () => {
    const { service } = makeService(
      [midnight, cafe],
      [
        { id: 'br-1', businessId: 'b-1' },
        { id: 'br-3', businessId: 'b-2' },
      ],
    );
    const scope = await service.resolve(query());
    const [retail, coffee] = scope.businesses;

    expect(retail.dayStartMinutes).toBe(0);
    expect(retail.fromUtc.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(coffee.dayStartMinutes).toBe(240);
    expect(coffee.fromUtc.toISOString()).toBe('2026-02-28T20:00:00.000Z');
  });

  it('sets the previous window to the equal period immediately before', async () => {
    const { service } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const scope = await service.resolve(query());
    const [b] = scope.businesses;
    expect(b.previousToUtc).toEqual(b.fromUtc);
    expect(b.toUtc.getTime() - b.fromUtc.getTime()).toBe(
      b.previousToUtc.getTime() - b.previousFromUtc.getTime(),
    );
  });

  it('drops a business whose branches are all filtered out by branchId', async () => {
    const { service } = makeService(
      [midnight],
      [{ id: 'br-1', businessId: 'b-1' }],
    );
    const scope = await service.resolve(
      query({ businessId: 'b-1', branchId: 'br-1' }),
    );
    expect(scope.businesses).toHaveLength(1);
    expect(scope.businesses[0].branchIds).toEqual(['br-1']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- analytics-scope
```

Expected: FAIL — `Cannot find module './analytics-scope.service'`.

- [ ] **Step 3: Add the shared date regex**

Append to `src/common/validation-constants.ts`:

```ts
/** `YYYY-MM-DD` calendar date (e.g. an analytics range endpoint). */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
```

- [ ] **Step 4: Write the query DTO**

Create `src/portal/analytics/dto/analytics-query.dto.ts`:

```ts
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { ISO_DATE_REGEX } from '../../../common/validation-constants';

/**
 * The query every report endpoint accepts.
 *
 * Range presets (today / 7 days / this month …) resolve in the PORTAL, not
 * here: "today" is a question about a business day, and answering it in one
 * place — against the business's own `dayStartTime` — keeps the API explicit
 * and testable. The API takes literal dates only.
 */
export class AnalyticsQueryDto {
  /** Omit to span every non-demo business the caller owns. */
  @IsOptional()
  @IsUUID()
  businessId?: string;

  /** Requires `businessId`; the resolver rejects it on its own. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Inclusive business-day lower bound. */
  @Matches(ISO_DATE_REGEX, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  /** Inclusive business-day upper bound. */
  @Matches(ISO_DATE_REGEX, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
```

- [ ] **Step 5: Write the scope resolver**

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

export interface ScopedBusiness {
  id: string;
  name: string;
  dayStartTime: string;
  dayStartMinutes: number;
  taxRate: number;
  branchIds: string[];
  fromUtc: Date;
  toUtc: Date;
  previousFromUtc: Date;
  previousToUtc: Date;
}

export interface ResolvedScope {
  businesses: ScopedBusiness[];
  branchIds: string[];
  from: string;
  to: string;
  dayCount: number;
}

/**
 * Turns a report query into the branches and UTC windows the SQL will use.
 *
 * Ids are resolved through the SCOPED client, so the tenancy choke point — not
 * this service — decides what the caller may see. That matters more than usual
 * here: the report queries themselves are raw SQL, which bypasses the choke
 * point entirely, so this is where their scope comes from.
 *
 * The window lives on each BUSINESS rather than on the scope, because
 * `dayStartTime` differs per business: a midnight retailer and an 04:00 cafe
 * asked about the same dates are asking about different UTC intervals. Every
 * report therefore queries per business and merges in TypeScript.
 *
 * 404 is reserved for a named id that is not the caller's. An owned business
 * that simply has no branches yet yields an empty list and a zeroed report — a
 * new business is a legitimate thing to ask about.
 */
@Injectable()
export class AnalyticsScopeService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async resolve(query: AnalyticsQueryDto): Promise<ResolvedScope> {
    if (query.branchId && !query.businessId) {
      throw new ValidationFailedError(
        'branchId requires businessId — a branch is only meaningful within its business.',
      );
    }

    let days: string[];
    try {
      days = businessDaySeries(query.from, query.to);
    } catch {
      throw new ValidationFailedError('to must be on or after from.');
    }
    if (days.length > MAX_RANGE_DAYS) {
      throw new ValidationFailedError(
        `The date range must not exceed ${MAX_RANGE_DAYS} days.`,
      );
    }

    const businesses = await this.scoped.business.findMany({
      // Demo businesses are excluded from rollups (project-spec §8) but remain
      // reportable when asked for by id, so training data can still be checked.
      where: query.businessId ? { id: query.businessId } : { isDemo: false },
      select: { id: true, name: true, dayStartTime: true, taxRate: true },
      orderBy: { createdAt: 'asc' },
    });
    if (businesses.length === 0) {
      throw new NotFoundError('Business not found.');
    }

    const branches = await this.scoped.branch.findMany({
      where: {
        businessId: { in: businesses.map((b) => b.id) },
        ...(query.branchId ? { id: query.branchId } : {}),
      },
      select: { id: true, businessId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (query.branchId && branches.length === 0) {
      throw new NotFoundError('Branch not found.');
    }

    const byBusiness = new Map<string, string[]>();
    for (const branch of branches) {
      const list = byBusiness.get(branch.businessId);
      if (list) list.push(branch.id);
      else byBusiness.set(branch.businessId, [branch.id]);
    }

    const scopedBusinesses: ScopedBusiness[] = [];
    for (const business of businesses) {
      const branchIds = byBusiness.get(business.id);
      if (!branchIds || branchIds.length === 0) continue;

      const dayStartMinutes = parseDayStart(business.dayStartTime);
      const { fromUtc, toUtc } = businessDayRangeUtc(
        query.from,
        query.to,
        dayStartMinutes,
      );
      const previous = previousPeriod(fromUtc, toUtc);

      scopedBusinesses.push({
        id: business.id,
        name: business.name,
        dayStartTime: business.dayStartTime,
        dayStartMinutes,
        taxRate: Number(business.taxRate),
        branchIds,
        fromUtc,
        toUtc,
        previousFromUtc: previous.fromUtc,
        previousToUtc: previous.toUtc,
      });
    }

    return {
      businesses: scopedBusinesses,
      branchIds: scopedBusinesses.flatMap((b) => b.branchIds),
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
npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/portal/analytics/dto/analytics-query.dto.ts \
        src/portal/analytics/scope/analytics-scope.service.ts \
        src/portal/analytics/scope/analytics-scope.service.spec.ts \
        src/common/validation-constants.ts
git commit -m "feat(api): analytics scope resolver with per-business day windows"
```

---

### Task 5: Scoped raw SQL, report rendering, report audit, and the module

The three shared mechanisms every report uses, plus the Nest module that will hold the controllers.

**Files:**
- Create: `src/portal/analytics/scoped-sql.ts`
- Create: `src/portal/analytics/report-response.ts`
- Create: `src/portal/analytics/report-audit.service.ts`
- Create: `src/portal/analytics/analytics.module.ts`
- Modify: `src/portal/portal.module.ts`
- Test: `src/portal/analytics/scoped-sql.spec.ts`, `src/portal/analytics/report-response.spec.ts`

**Interfaces:**
- Consumes: `ScopedBusiness`, `ResolvedScope` (Task 4); `CsvSection`, `toCsv` (Task 3); `PrismaService`; `AuditService` from `../../auth/audit.service`.
- Produces:
  - `runScoped<T>(raw: PrismaService, business: ScopedBusiness, build: (b: ScopedBusiness) => Prisma.Sql): Promise<T[]>`
  - `runScopedOne<T>(raw, business, build): Promise<T>` — the single-row variant every aggregate uses.
  - `renderReport<T>(res, reportName, query, data, toSections): T | string`
  - `class ReportAuditService { log(scope: ResolvedScope, report: string, format: 'json' | 'csv'): Promise<void> }`
  - `class AnalyticsModule`

- [ ] **Step 1: Write the failing tests**

Create `src/portal/analytics/scoped-sql.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { runScoped } from './scoped-sql';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';

const business = (branchIds: string[]): ScopedBusiness => ({
  id: 'b-1',
  name: 'Biz',
  dayStartTime: '00:00',
  dayStartMinutes: 0,
  taxRate: 0.12,
  branchIds,
  fromUtc: new Date('2026-03-01T00:00:00.000Z'),
  toUtc: new Date('2026-03-08T00:00:00.000Z'),
  previousFromUtc: new Date('2026-02-22T00:00:00.000Z'),
  previousToUtc: new Date('2026-03-01T00:00:00.000Z'),
});

function fakeRaw(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  return { raw: { $queryRaw: queryRaw } as unknown as PrismaService, queryRaw };
}

describe('runScoped', () => {
  it('refuses to run when the business has no branches in scope', async () => {
    const { raw } = fakeRaw();
    await expect(
      runScoped(raw, business([]), () => Prisma.sql`SELECT 1 FROM sales WHERE branch_id = ANY('{}')`),
    ).rejects.toThrow(/no branches/i);
  });

  it('refuses SQL that carries no branch_id predicate', async () => {
    const { raw } = fakeRaw();
    await expect(
      runScoped(raw, business(['br-1']), () => Prisma.sql`SELECT 1 FROM sales`),
    ).rejects.toThrow(/branch_id/);
  });

  it('runs SQL that is scoped, and returns its rows', async () => {
    const { raw, queryRaw } = fakeRaw([{ n: 1 }]);
    const rows = await runScoped(raw, business(['br-1']), (b) =>
      Prisma.sql`SELECT 1 AS n FROM sales WHERE branch_id = ANY(${b.branchIds}::uuid[])`,
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
```

Create `src/portal/analytics/report-response.spec.ts`:

```ts
import type { Response } from 'express';
import { renderReport } from './report-response';

function fakeRes() {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

const query = { from: '2026-03-01', to: '2026-03-07' };
const data = { totalC: 12345 };
const sections = (d: typeof data) => [
  { columns: ['total'], rows: [[d.totalC]] },
];

describe('renderReport', () => {
  it('returns the data untouched for JSON, setting no headers', () => {
    const { res, setHeader } = fakeRes();
    expect(renderReport(res, 'overview', query, data, sections)).toBe(data);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('renders CSV and names the file after the report and its range', () => {
    const { res, setHeader } = fakeRes();
    const out = renderReport(
      res,
      'overview',
      { ...query, format: 'csv' as const },
      data,
      sections,
    );
    expect(typeof out).toBe('string');
    expect(out).toContain('12345');
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

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- scoped-sql report-response
```

Expected: FAIL — both modules missing.

- [ ] **Step 3: Implement the scoped SQL helper**

Create `src/portal/analytics/scoped-sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ScopedBusiness } from './scope/analytics-scope.service';

/**
 * The ONLY way analytics touches raw SQL.
 *
 * The tenancy extension hooks `$allModels` (`scoped-prisma.ts:737`), and a raw
 * query is not a model operation — so `$queryRaw` bypasses the choke point
 * completely. Reports need raw SQL anyway (`sale_items` has no top-level access,
 * and `groupBy` cannot bucket dates or join), so the scope has to come from
 * somewhere trustworthy: `business.branchIds`, which the scope resolver read
 * through the scoped client.
 *
 * Two guards, both cheap:
 *   1. Never run for a business with no branches — an unbounded `IN ()` is a bug.
 *   2. Never run SQL whose text lacks `branch_id`. Crude on purpose: it is a
 *      tripwire for a builder that forgot its predicate, and it fires in tests.
 */
function assertScoped(business: ScopedBusiness, sql: Prisma.Sql): void {
  if (business.branchIds.length === 0) {
    throw new Error(
      `runScoped: business ${business.id} has no branches in scope — the caller must skip it.`,
    );
  }
  if (!sql.text.includes('branch_id')) {
    throw new Error(
      'runScoped: analytics SQL must constrain branch_id — refusing to run an unscoped query.',
    );
  }
}

export async function runScoped<T>(
  raw: PrismaService,
  business: ScopedBusiness,
  build: (business: ScopedBusiness) => Prisma.Sql,
): Promise<T[]> {
  const sql = build(business);
  assertScoped(business, sql);
  return raw.$queryRaw<T[]>(sql);
}

/** Single-row variant for aggregates, which always return exactly one row. */
export async function runScopedOne<T>(
  raw: PrismaService,
  business: ScopedBusiness,
  build: (business: ScopedBusiness) => Prisma.Sql,
): Promise<T> {
  const rows = await runScoped<T>(raw, business, build);
  if (rows.length !== 1) {
    throw new Error(
      `runScopedOne: expected exactly one row, got ${rows.length}.`,
    );
  }
  return rows[0];
}
```

- [ ] **Step 4: Implement report rendering**

Create `src/portal/analytics/report-response.ts`:

```ts
import type { Response } from 'express';
import { CsvSection, toCsv } from './csv';

/** The part of `AnalyticsQueryDto` this needs — kept narrow so tests are trivial. */
export interface ReportRange {
  from: string;
  to: string;
  format?: 'json' | 'csv';
}

/**
 * JSON by default; CSV when asked, built from the SAME object the JSON
 * response would have returned. One code path, so an export cannot drift from
 * what the portal shows.
 *
 * Used with `@Res({ passthrough: true })` so Nest still serialises the returned
 * value and applies the global exception filter.
 */
export function renderReport<T>(
  res: Response,
  reportName: string,
  query: ReportRange,
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

- [ ] **Step 5: Implement the report audit service**

Create `src/portal/analytics/report-audit.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../auth/audit.service';
import type { ResolvedScope } from './scope/analytics-scope.service';

/**
 * Report views and exports are sensitive READS (project-spec §11), which the
 * tenancy choke point does not capture — it audits mutations. This writes them
 * explicitly, one row per business in scope, so each business's own activity log
 * shows who looked at its numbers and when.
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

- [ ] **Step 6: Create the module and wire it into the portal**

Create `src/portal/analytics/analytics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AnalyticsScopeService } from './scope/analytics-scope.service';
import { ReportAuditService } from './report-audit.service';

/**
 * Analytics (tenant scope) — `analytics-spec.md`. Controllers arrive one report
 * family at a time; the shared providers below are what they all stand on.
 *
 * Imports `AuthModule` for `PortalAuthGuard`. `PrismaService` (raw, for the
 * report SQL) and `SCOPED_PRISMA` (for scope resolution) come from the global
 * `PrismaModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [],
  providers: [AnalyticsScopeService, ReportAuditService],
})
export class AnalyticsModule {}
```

In `src/portal/portal.module.ts`, add the import beside `CatalogModule` and `StockModule`:

```ts
import { AnalyticsModule } from './analytics/analytics.module';
```

and add `AnalyticsModule` to the `imports` array.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test -- scoped-sql report-response
npm run lint && npm run build
npm run test:e2e -- health
```

Expected: unit tests pass; the app still boots (the health e2e proves the module graph is valid).

- [ ] **Step 8: Commit**

```bash
git add src/portal/analytics src/portal/portal.module.ts
git commit -m "feat(api): scoped raw-sql helper, report rendering and sensitive-read audit"
```

---

### Task 6: Sale-seeding test helper

Report e2e tests need sales. Driving the real POS flow (pair a terminal, open a shift, complete a sale) for every report assertion is slow and buries the thing under test. This helper writes sale rows **through the real totals engine**, so the numbers a report reads are the numbers the engine produced — which is exactly the invariant the reports must respect.

**Files:**
- Create: `test/helpers/sales.ts`
- Test: `test/helpers-sales.e2e-spec.ts`

**Interfaces:**
- Consumes: `computeTotals` and `Cart`/`CartLine` from `src/common/totals`.
- Produces:
  - `interface SeedLine { name?: string; qty: number; unitPriceC: number; costC?: number | null; productId?: string | null; variantId?: string | null; modifiers?: { groupId: string; modifierId: string; name: string; priceDeltaC: number }[]; discount?: DiscountSpec | null; scPwdMarked?: boolean }`
  - `seedSale(raw, opts): Promise<{ id: string; subtotal: number; total: number }>` where `opts` is `{ branchId, terminalId, shiftId?, createdAt, status?, statusReason?, orderType?, taxRate?, serviceChargeRate?, scPwd?, orderDiscount?, paymentMethod?, lines }`

- [ ] **Step 1: Write the failing test**

Create `test/helpers-sales.e2e-spec.ts`:

```ts
/*
 * Proves the sale-seeding helper writes what the POS would write. Every
 * analytics e2e leans on it, so if this drifts from `sales.service.persist`
 * the reports would be validated against fiction.
 */
import { PrismaClient } from '@prisma/client';
import { resetDb, closeDb } from './helpers/db';
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

describe('seedSale helper (e2e)', () => {
  let branchId: string;
  let terminalId: string;

  beforeAll(async () => {
    await raw.$connect();
  });

  afterAll(async () => {
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
    const owner = await raw.owner.create({
      data: { name: 'O', email: `o-${Date.now()}@t.com`, status: 'active' },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'B', type: 'fnb', taxRate: '0.12' },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'T1', code: 'T1' },
    });
    branchId = branch.id;
    terminalId = terminal.id;
  });

  it('stores a subtotal that includes modifier prices', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      lines: [
        {
          qty: 2,
          unitPriceC: 10000,
          modifiers: [
            { groupId: 'g', modifierId: 'm', name: 'Oat milk', priceDeltaC: 2000 },
          ],
        },
      ],
    });

    // 2 x (100.00 + 20.00) = 240.00
    expect(sale.subtotal).toBe(24000);

    const stored = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stored.subtotal).toBe(24000);

    // The stored unit_price is the BASE price — the modifier lives in the json.
    const [item] = await raw.saleItem.findMany({ where: { saleId: sale.id } });
    expect(item.unitPrice).toBe(10000);
    expect(item.modifiers).toEqual([
      { groupId: 'g', modifierId: 'm', name: 'Oat milk', priceDeltaC: 2000 },
    ]);
  });

  it('records a per-unit cost snapshot, and null when the cost is unset', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      lines: [
        { qty: 3, unitPriceC: 5000, costC: 2000 },
        { qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const items = await raw.saleItem.findMany({
      where: { saleId: sale.id },
      orderBy: { qty: 'desc' },
    });
    expect(items[0].costSnapshot).toBe(2000);
    expect(items[1].costSnapshot).toBeNull();
  });

  it('writes a payment covering the total', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      paymentMethod: 'gcash',
      lines: [{ qty: 1, unitPriceC: 15000 }],
    });

    const [payment] = await raw.salePayment.findMany({
      where: { saleId: sale.id },
    });
    expect(payment.method).toBe('gcash');
    expect(payment.amount).toBe(sale.total);
  });

  it('can write a voided sale for the void/refund counts', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      status: 'voided',
      statusReason: 'Wrong order',
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const stored = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stored.status).toBe('voided');
    expect(stored.statusReason).toBe('Wrong order');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:e2e -- helpers-sales
```

Expected: FAIL — `Cannot find module './helpers/sales'`.

- [ ] **Step 3: Implement the helper**

Create `test/helpers/sales.ts`:

```ts
import { randomUUID } from 'crypto';
import { PaymentMethod, PrismaClient, SaleStatus } from '@prisma/client';
import { computeTotals } from '../../src/common/totals/totals';
import type { Cart, CartLine, CartModifier, DiscountSpec } from '../../src/common/totals/cart';

/**
 * Seeds a sale the way `sales.service.persist` does, with totals from the REAL
 * engine (`computeTotals`). Analytics reports are validated against these rows,
 * so they must carry the engine's arithmetic — in particular that
 * `sale_items.unit_price` is the BASE price while the line's gross includes each
 * modifier's `priceDeltaC`.
 *
 * Writes on the raw client deliberately: these are fixtures, not tenant traffic,
 * and going through the choke point would demand a request context.
 */
export interface SeedLine {
  name?: string;
  qty: number;
  unitPriceC: number;
  costC?: number | null;
  productId?: string | null;
  variantId?: string | null;
  modifiers?: CartModifier[];
  discount?: DiscountSpec | null;
  scPwdMarked?: boolean;
}

export interface SeedSaleOptions {
  branchId: string;
  terminalId: string;
  shiftId?: string | null;
  createdAt: Date;
  status?: SaleStatus;
  statusReason?: string | null;
  orderType?: Cart['orderType'];
  taxRate?: number;
  serviceChargeRate?: number;
  scPwd?: { idNo: string; name: string } | null;
  orderDiscount?: DiscountSpec | null;
  discountId?: string | null;
  paymentMethod?: PaymentMethod;
  receiptNo?: string;
  lines: SeedLine[];
}

let receiptCounter = 0;

export async function seedSale(
  raw: PrismaClient,
  options: SeedSaleOptions,
): Promise<{ id: string; subtotal: number; total: number }> {
  const {
    branchId,
    terminalId,
    shiftId = null,
    createdAt,
    status = 'completed',
    statusReason = null,
    orderType = 'takeout',
    taxRate = 0.12,
    serviceChargeRate = 0,
    scPwd = null,
    orderDiscount = null,
    discountId = null,
    paymentMethod = 'cash',
    lines,
  } = options;

  receiptCounter += 1;
  const receiptNo = options.receiptNo ?? `R-${Date.now()}-${receiptCounter}`;

  const cartLines: CartLine[] = lines.map((line, index) => ({
    id: `line-${index}`,
    productId: line.productId ?? null,
    variantId: line.variantId ?? null,
    name: line.name ?? `Item ${index + 1}`,
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
    lines: cartLines,
    orderDiscount,
    scPwd,
  };
  const totals = computeTotals(cart, { taxRate, serviceChargeRate });

  const saleId = randomUUID();
  await raw.sale.create({
    data: {
      id: saleId,
      createdAt,
      branchId,
      terminalId,
      shiftId,
      receiptNo,
      orderType,
      status,
      statusReason,
      subtotal: totals.subtotalC,
      discount: totals.promoDiscountC,
      discountId,
      serviceCharge: totals.serviceChargeC,
      scPwd: scPwd ?? undefined,
      scPwdDiscount: totals.scPwdDiscountC,
      vatExemptSales: totals.vatExemptSalesC,
      tax: totals.vatC,
      total: totals.totalC,
      createdAtDevice: createdAt,
      draft: {},
      items: {
        create: cartLines.map((line, index) => {
          const lineTotals = totals.lines[index];
          return {
            createdAt,
            productId: line.productId,
            variantId: line.variantId,
            nameSnapshot: line.name,
            qty: line.qty,
            // The BASE price, exactly as the POS stores it: modifier deltas
            // live in `modifiers` and are added back by the report SQL.
            unitPrice: line.unitPriceC,
            costSnapshot: lines[index].costC ?? null,
            discount: lineTotals.grossC - lineTotals.netC,
            modifiers: line.modifiers,
          };
        }),
      },
      payments: {
        create: [
          {
            createdAt,
            method: paymentMethod,
            amount: totals.totalC,
            tendered: totals.totalC,
            change: 0,
          },
        ],
      },
    },
  });

  return { id: saleId, subtotal: totals.subtotalC, total: totals.totalC };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:e2e -- helpers-sales
```

Expected: all five cases pass.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/sales.ts test/helpers-sales.e2e-spec.ts
git commit -m "test: sale-seeding helper that writes through the real totals engine"
```

---

### Task 7: Overview report (§1)

The first real report. It establishes the two SQL builders every money report reuses, the KPI arithmetic, and the controller shape.

**Files:**
- Create: `src/portal/analytics/reports/sales-aggregate.sql.ts`
- Create: `src/portal/analytics/overview/overview.math.ts`
- Create: `src/portal/analytics/overview/overview.service.ts`
- Create: `src/portal/analytics/overview/overview.controller.ts`
- Create: `src/portal/analytics/overview/overview.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `src/portal/analytics/overview/overview.math.spec.ts`, `test/portal-analytics-overview.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScopedOne` (Task 5), `AnalyticsScopeService`/`ScopedBusiness`/`ResolvedScope` (Task 4), `ReportAuditService` (Task 5), `renderReport` (Task 5), `centavosToPesos`/`CsvSection` (Task 3), `seedSale` (Task 6).
- Produces:
  - `interface SalesAggregateRow { gross_sales_c, discounts_c, service_charge_c, transactions, void_count, refund_count: bigint }`
  - `interface LineAggregateRow { costed_lines, costed_revenue_c, costed_cost_c, uncosted_revenue_c: bigint }`
  - `salesAggregateSql(business, fromUtc, toUtc): Prisma.Sql`
  - `lineAggregateSql(business, fromUtc, toUtc): Prisma.Sql`
  - `interface Kpi { value: number; previous: number; changePct: number | null }`
  - `interface NullableKpi { value: number | null; previous: number | null; changePct: number | null }`
  - `interface MarginKpi { value: number | null; previous: number | null; changePoints: number | null }`
  - `interface OverviewReport` (below)
  - `GET /v1/portal/analytics/overview`

- [ ] **Step 1: Write the failing unit tests for the KPI arithmetic**

Create `src/portal/analytics/overview/overview.math.spec.ts`:

```ts
import {
  addRows,
  averageBasketC,
  emptyTotals,
  grossProfitC,
  marginPct,
  netSalesC,
  toKpi,
  toMarginKpi,
  toNullableKpi,
} from './overview.math';

const sales = (over: Partial<Record<string, bigint>> = {}) => ({
  gross_sales_c: 0n,
  discounts_c: 0n,
  service_charge_c: 0n,
  transactions: 0n,
  void_count: 0n,
  refund_count: 0n,
  ...over,
}) as any;

const lines = (over: Partial<Record<string, bigint>> = {}) => ({
  costed_lines: 0n,
  costed_revenue_c: 0n,
  costed_cost_c: 0n,
  uncosted_revenue_c: 0n,
  ...over,
}) as any;

describe('addRows', () => {
  it('sums across businesses, converting bigint to number', () => {
    const totals = emptyTotals();
    addRows(totals, sales({ gross_sales_c: 10000n, transactions: 2n }), lines());
    addRows(totals, sales({ gross_sales_c: 5000n, transactions: 1n }), lines());
    expect(totals.grossSalesC).toBe(15000);
    expect(totals.transactions).toBe(3);
  });
});

describe('netSalesC', () => {
  it('is gross sales less every discount, and excludes service charge', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({ gross_sales_c: 100000n, discounts_c: 15000n, service_charge_c: 8000n }),
      lines(),
    );
    expect(netSalesC(totals)).toBe(85000);
  });
});

describe('grossProfitC and marginPct — the null-cost rule', () => {
  it('is null, NOT zero, when nothing in the range carries a cost', () => {
    const totals = emptyTotals();
    addRows(totals, sales({ gross_sales_c: 50000n }), lines({ uncosted_revenue_c: 50000n }));
    expect(grossProfitC(totals)).toBeNull();
    expect(marginPct(totals)).toBeNull();
  });

  it('counts only costed lines, and reports the uncosted revenue alongside', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({ gross_sales_c: 50000n }),
      lines({
        costed_lines: 3n,
        costed_revenue_c: 30000n,
        costed_cost_c: 18000n,
        uncosted_revenue_c: 20000n,
      }),
    );
    expect(grossProfitC(totals)).toBe(12000);
    expect(marginPct(totals)).toBeCloseTo(0.4, 10);
    expect(totals.uncostedRevenueC).toBe(20000);
  });

  it('reports a loss as a negative profit rather than clamping at zero', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales(),
      lines({ costed_lines: 1n, costed_revenue_c: 1000n, costed_cost_c: 1500n }),
    );
    expect(grossProfitC(totals)).toBe(-500);
  });
});

describe('averageBasketC', () => {
  it('is null when there were no transactions, never a divide by zero', () => {
    expect(averageBasketC(emptyTotals())).toBeNull();
  });

  it('rounds half-up to whole centavos', () => {
    const totals = emptyTotals();
    addRows(totals, sales({ gross_sales_c: 1001n, transactions: 2n }), lines());
    expect(averageBasketC(totals)).toBe(501);
  });
});

describe('toKpi', () => {
  it('reports change as a ratio of the previous period', () => {
    expect(toKpi(150, 100)).toEqual({ value: 150, previous: 100, changePct: 0.5 });
  });

  it('leaves change null from a standing start, rather than claiming infinity', () => {
    expect(toKpi(150, 0)).toEqual({ value: 150, previous: 0, changePct: null });
  });
});

describe('toNullableKpi', () => {
  it('leaves change null when either side is unknown', () => {
    expect(toNullableKpi(null, 100).changePct).toBeNull();
    expect(toNullableKpi(150, null).changePct).toBeNull();
  });
});

describe('toMarginKpi', () => {
  it('reports the difference in percentage POINTS, not a percentage change', () => {
    expect(toMarginKpi(0.42, 0.4)).toEqual({
      value: 0.42,
      previous: 0.4,
      changePoints: expect.closeTo(0.02, 10),
    });
  });

  it('leaves the difference null when either margin is unknown', () => {
    expect(toMarginKpi(null, 0.4).changePoints).toBeNull();
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

```bash
npm test -- overview.math
```

Expected: FAIL — `Cannot find module './overview.math'`.

- [ ] **Step 3: Write the SQL builders**

Create `src/portal/analytics/reports/sales-aggregate.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * The two aggregates every money report is built from.
 *
 * Both are scoped by `branch_id = ANY(...)` over ids the scope resolver read
 * through the tenancy choke point — raw SQL gets no scoping of its own
 * (`scoped-sql.ts` explains why).
 *
 * Status rules, applied identically everywhere: VOIDED sales contribute to no
 * money figure and to no transaction count; REFUNDED sales contribute to no
 * money figure but are counted. Conditional aggregates keep both counts in one
 * pass over the same rows.
 */

export interface SalesAggregateRow {
  gross_sales_c: bigint;
  discounts_c: bigint;
  service_charge_c: bigint;
  transactions: bigint;
  void_count: bigint;
  refund_count: bigint;
}

export function salesAggregateSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(s.subtotal) FILTER (WHERE s.status = 'completed'), 0)::bigint
        AS gross_sales_c,
      COALESCE(SUM(s.discount + s.sc_pwd_discount) FILTER (WHERE s.status = 'completed'), 0)::bigint
        AS discounts_c,
      COALESCE(SUM(s.service_charge) FILTER (WHERE s.status = 'completed'), 0)::bigint
        AS service_charge_c,
      COUNT(*) FILTER (WHERE s.status = 'completed')::bigint AS transactions,
      COUNT(*) FILTER (WHERE s.status = 'voided')::bigint    AS void_count,
      COUNT(*) FILTER (WHERE s.status = 'refunded')::bigint  AS refund_count
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
  `;
}

export interface LineAggregateRow {
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
  uncosted_revenue_c: bigint;
}

/**
 * Line-level revenue and cost.
 *
 * `sale_items.unit_price` is the BASE price — the POS stores the price locked at
 * add-to-cart and keeps the chosen modifiers in a jsonb array, each with its own
 * `priceDeltaC` (`sales.service.ts:507`, `cart.ts:49`). The engine's line gross
 * adds them back, so `qty * unit_price` alone would understate every line that
 * has a priced modifier. The lateral join below is that addition; without it, Σ
 * line gross would not equal `sales.subtotal`.
 *
 * `cost_snapshot` is the UNIT cost (`sales.service.ts:664`), hence
 * `qty * cost_snapshot`. Postgres `round(numeric)` rounds half away from zero,
 * matching the engine's `halfUp` for these non-negative values.
 *
 * Costed and uncosted revenue are separated rather than blended: a null cost
 * means unknown margin, never zero margin.
 */
export function lineAggregateSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NULL), 0)::bigint
        AS uncosted_revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
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
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND si.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
  `;
}
```

- [ ] **Step 4: Write the KPI arithmetic**

Create `src/portal/analytics/overview/overview.math.ts`:

```ts
import { halfUp } from '../../../common/totals/money';
import type {
  LineAggregateRow,
  SalesAggregateRow,
} from '../reports/sales-aggregate.sql';

export interface Totals {
  grossSalesC: number;
  discountsC: number;
  serviceChargeC: number;
  transactions: number;
  voidCount: number;
  refundCount: number;
  costedLines: number;
  costedRevenueC: number;
  costedCostC: number;
  uncostedRevenueC: number;
}

export interface Kpi {
  value: number;
  previous: number;
  /** Ratio of the previous period (0.5 = up by half). Null from a zero base. */
  changePct: number | null;
}

export interface NullableKpi {
  value: number | null;
  previous: number | null;
  changePct: number | null;
}

export interface MarginKpi {
  value: number | null;
  previous: number | null;
  /** Percentage POINTS, not a percentage change — margin is already a ratio. */
  changePoints: number | null;
}

export function emptyTotals(): Totals {
  return {
    grossSalesC: 0,
    discountsC: 0,
    serviceChargeC: 0,
    transactions: 0,
    voidCount: 0,
    refundCount: 0,
    costedLines: 0,
    costedRevenueC: 0,
    costedCostC: 0,
    uncostedRevenueC: 0,
  };
}

/** Aggregates arrive as bigint (project-spec §7) and land as numbers here. */
export function addRows(
  into: Totals,
  sales: SalesAggregateRow,
  lines: LineAggregateRow,
): void {
  into.grossSalesC += Number(sales.gross_sales_c);
  into.discountsC += Number(sales.discounts_c);
  into.serviceChargeC += Number(sales.service_charge_c);
  into.transactions += Number(sales.transactions);
  into.voidCount += Number(sales.void_count);
  into.refundCount += Number(sales.refund_count);
  into.costedLines += Number(lines.costed_lines);
  into.costedRevenueC += Number(lines.costed_revenue_c);
  into.costedCostC += Number(lines.costed_cost_c);
  into.uncostedRevenueC += Number(lines.uncosted_revenue_c);
}

/** Sales after every discount. Service charge is a separate KPI, not part of this. */
export function netSalesC(t: Totals): number {
  return t.grossSalesC - t.discountsC;
}

/**
 * Null when NO line in the range carried a cost. Reporting zero would claim a
 * 100% margin on an entire uncosted catalogue — the single most damaging silent
 * error available in these reports.
 */
export function grossProfitC(t: Totals): number | null {
  if (t.costedLines === 0) return null;
  return t.costedRevenueC - t.costedCostC;
}

export function marginPct(t: Totals): number | null {
  const profit = grossProfitC(t);
  if (profit === null || t.costedRevenueC === 0) return null;
  return profit / t.costedRevenueC;
}

export function averageBasketC(t: Totals): number | null {
  if (t.transactions === 0) return null;
  return halfUp(netSalesC(t) / t.transactions);
}

export function toKpi(value: number, previous: number): Kpi {
  return {
    value,
    previous,
    changePct: previous === 0 ? null : (value - previous) / previous,
  };
}

export function toNullableKpi(
  value: number | null,
  previous: number | null,
): NullableKpi {
  return {
    value,
    previous,
    changePct:
      value === null || previous === null || previous === 0
        ? null
        : (value - previous) / previous,
  };
}

export function toMarginKpi(
  value: number | null,
  previous: number | null,
): MarginKpi {
  return {
    value,
    previous,
    changePoints: value === null || previous === null ? null : value - previous,
  };
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

```bash
npm test -- overview.math
```

Expected: PASS.

- [ ] **Step 6: Write the failing e2e test**

Create `test/portal-analytics-overview.e2e-spec.ts`:

```ts
/*
 * Overview report (analytics-spec §1) e2e. Sales are seeded through the real
 * totals engine (`test/helpers/sales.ts`), so the KPIs are checked against the
 * same arithmetic the POS produces.
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
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

/** 2 March 2026, 10:00 Manila — comfortably inside a midnight business day. */
const DURING = new Date('2026-03-02T02:00:00.000Z');
/** 23 February 2026, 10:00 Manila — inside the previous 7-day window. */
const BEFORE = new Date('2026-02-23T02:00:00.000Z');

describe('Portal analytics — overview (e2e)', () => {
  let app: INestApplication;
  let auth: AuthService;

  const server = () => app.getHttpServer();

  async function seedTenant(over: Record<string, unknown> = {}) {
    const owner = await raw.owner.create({
      data: {
        name: 'O',
        email: `o-${Date.now()}-${Math.random()}@t.com`,
        status: 'active',
        maxBusinesses: 5,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `u-${Date.now()}-${Math.random()}@t.com`,
        role: 'owner',
        ownerId: owner.id,
        passwordHash: 'x',
      },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'B', type: 'retail', taxRate: '0.12', ...over },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'T1', code: 'T1' },
    });
    const { accessToken } = await auth.mintTokenPair(user.id, 'owner', owner.id);
    return {
      token: accessToken,
      businessId: business.id,
      branchId: branch.id,
      terminalId: terminal.id,
    };
  }

  const overview = (token: string, query: Record<string, string>) =>
    request(server())
      .get('/v1/portal/analytics/overview')
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

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

  it('reports gross, discounts and net sales for the range', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { qty: 2, unitPriceC: 10000 },
        { qty: 1, unitPriceC: 5000, discount: { source: 'free', kind: 'fixed', value: 1000 } },
      ],
    });

    const res = await overview(t.token, {}).expect(200);

    expect(res.body.grossSalesC.value).toBe(25000);
    expect(res.body.discountsC.value).toBe(1000);
    expect(res.body.netSalesC.value).toBe(24000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.averageBasketC.value).toBe(24000);
  });

  it('counts voids and refunds but keeps their money out of sales', async () => {
    const t = await seedTenant();
    const common = { branchId: t.branchId, terminalId: t.terminalId, createdAt: DURING };
    await seedSale(raw, { ...common, lines: [{ qty: 1, unitPriceC: 10000 }] });
    await seedSale(raw, { ...common, status: 'voided', lines: [{ qty: 1, unitPriceC: 90000 }] });
    await seedSale(raw, { ...common, status: 'refunded', lines: [{ qty: 1, unitPriceC: 70000 }] });

    const res = await overview(t.token, {}).expect(200);

    expect(res.body.grossSalesC.value).toBe(10000);
    expect(res.body.transactions.value).toBe(1);
    expect(res.body.voidCount.value).toBe(1);
    expect(res.body.refundCount.value).toBe(1);
  });

  it('compares against the equal period immediately before', async () => {
    const t = await seedTenant();
    const common = { branchId: t.branchId, terminalId: t.terminalId };
    await seedSale(raw, { ...common, createdAt: DURING, lines: [{ qty: 1, unitPriceC: 15000 }] });
    await seedSale(raw, { ...common, createdAt: BEFORE, lines: [{ qty: 1, unitPriceC: 10000 }] });

    const res = await overview(t.token, {}).expect(200);

    expect(res.body.grossSalesC.value).toBe(15000);
    expect(res.body.grossSalesC.previous).toBe(10000);
    expect(res.body.grossSalesC.changePct).toBeCloseTo(0.5, 10);
  });

  it('reports margin as null — never zero — when costs are unset', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
    });

    const res = await overview(t.token, {}).expect(200);

    expect(res.body.grossProfitC.value).toBeNull();
    expect(res.body.marginPct.value).toBeNull();
    expect(res.body.uncostedRevenueC).toBe(10000);
  });

  it('computes profit from costed lines and says how much revenue it covers', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        { qty: 2, unitPriceC: 10000, costC: 6000 },
        { qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const res = await overview(t.token, {}).expect(200);

    expect(res.body.grossProfitC.value).toBe(8000);
    expect(res.body.marginPct.value).toBeCloseTo(0.4, 10);
    expect(res.body.costedRevenueC).toBe(20000);
    expect(res.body.uncostedRevenueC).toBe(5000);
  });

  it('includes modifier prices in revenue', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          qty: 2,
          unitPriceC: 10000,
          costC: 4000,
          modifiers: [
            { groupId: 'g', modifierId: 'm', name: 'Oat milk', priceDeltaC: 2000 },
          ],
        },
      ],
    });

    const res = await overview(t.token, {}).expect(200);

    // 2 x (100.00 + 20.00) = 240.00 — not 2 x 100.00.
    expect(res.body.grossSalesC.value).toBe(24000);
    expect(res.body.grossSalesC.value).toBe(sale.subtotal);
    expect(res.body.costedRevenueC).toBe(24000);
  });

  it('returns zeros for an owned business that has no branches yet', async () => {
    const t = await seedTenant();
    const empty = await raw.business.create({
      data: {
        ownerId: (await raw.business.findUniqueOrThrow({ where: { id: t.businessId } })).ownerId,
        name: 'Fresh',
        type: 'retail',
        taxRate: '0.12',
      },
    });

    const res = await overview(t.token, { businessId: empty.id }).expect(200);

    expect(res.body.grossSalesC.value).toBe(0);
    expect(res.body.transactions.value).toBe(0);
    expect(res.body.grossProfitC.value).toBeNull();
  });

  it('rejects a branchId without a businessId, and a backwards range', async () => {
    const t = await seedTenant();
    await overview(t.token, { branchId: t.branchId }).expect(422);
    await overview(t.token, { from: '2026-03-07', to: '2026-03-01' }).expect(422);
  });

  it('exports the same numbers as CSV, in pesos, as an attachment', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 125000 }],
    });

    const res = await overview(t.token, { format: 'csv' }).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="overview-2026-03-01-2026-03-07.csv"',
    );
    expect(res.text).toContain('1250.00');
  });

  it('audits the read, and an export as an export', async () => {
    const t = await seedTenant();
    await overview(t.token, {}).expect(200);
    await overview(t.token, { format: 'csv' }).expect(200);

    const rows = await raw.auditLog.findMany({
      where: { businessId: t.businessId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('audit.report_read');
    expect(actions).toContain('audit.report_export');
  });
});
```

- [ ] **Step 7: Run the e2e test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-overview
```

Expected: every case fails with 404 — the route does not exist.

- [ ] **Step 8: Write the service**

Create `src/portal/analytics/overview/overview.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScopedOne } from '../scoped-sql';
import {
  lineAggregateSql,
  salesAggregateSql,
  type LineAggregateRow,
  type SalesAggregateRow,
} from '../reports/sales-aggregate.sql';
import {
  addRows,
  averageBasketC,
  emptyTotals,
  grossProfitC,
  marginPct,
  netSalesC,
  toKpi,
  toMarginKpi,
  toNullableKpi,
  type Kpi,
  type MarginKpi,
  type NullableKpi,
  type Totals,
} from './overview.math';

export interface OverviewReport {
  from: string;
  to: string;
  grossSalesC: Kpi;
  discountsC: Kpi;
  netSalesC: Kpi;
  serviceChargeC: Kpi;
  transactions: Kpi;
  voidCount: Kpi;
  refundCount: Kpi;
  averageBasketC: NullableKpi;
  grossProfitC: NullableKpi;
  marginPct: MarginKpi;
  /** How much of this period's revenue the profit figure actually covers. */
  costedRevenueC: number;
  uncostedRevenueC: number;
}

/**
 * Overview KPIs (analytics-spec §1) with a comparison against the equal period
 * immediately before.
 *
 * Queries run PER BUSINESS because each has its own `dayStartTime` and therefore
 * its own UTC window; the rows are summed here. A business with no branches in
 * scope is skipped entirely — `runScoped` refuses an unbounded query — and its
 * absence simply leaves the totals at zero.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<OverviewReport> {
    const scope = await this.scope.resolve(query);
    const current = emptyTotals();
    const previous = emptyTotals();

    for (const business of scope.businesses) {
      const [salesNow, salesThen, linesNow, linesThen] = await Promise.all([
        runScopedOne<SalesAggregateRow>(this.raw, business, (b) =>
          salesAggregateSql(b, b.fromUtc, b.toUtc),
        ),
        runScopedOne<SalesAggregateRow>(this.raw, business, (b) =>
          salesAggregateSql(b, b.previousFromUtc, b.previousToUtc),
        ),
        runScopedOne<LineAggregateRow>(this.raw, business, (b) =>
          lineAggregateSql(b, b.fromUtc, b.toUtc),
        ),
        runScopedOne<LineAggregateRow>(this.raw, business, (b) =>
          lineAggregateSql(b, b.previousFromUtc, b.previousToUtc),
        ),
      ]);
      addRows(current, salesNow, linesNow);
      addRows(previous, salesThen, linesThen);
    }

    await this.reportAudit.log(scope, 'overview', query.format ?? 'json');
    return build(scope.from, scope.to, current, previous);
  }
}

function build(
  from: string,
  to: string,
  current: Totals,
  previous: Totals,
): OverviewReport {
  return {
    from,
    to,
    grossSalesC: toKpi(current.grossSalesC, previous.grossSalesC),
    discountsC: toKpi(current.discountsC, previous.discountsC),
    netSalesC: toKpi(netSalesC(current), netSalesC(previous)),
    serviceChargeC: toKpi(current.serviceChargeC, previous.serviceChargeC),
    transactions: toKpi(current.transactions, previous.transactions),
    voidCount: toKpi(current.voidCount, previous.voidCount),
    refundCount: toKpi(current.refundCount, previous.refundCount),
    averageBasketC: toNullableKpi(
      averageBasketC(current),
      averageBasketC(previous),
    ),
    grossProfitC: toNullableKpi(grossProfitC(current), grossProfitC(previous)),
    marginPct: toMarginKpi(marginPct(current), marginPct(previous)),
    costedRevenueC: current.costedRevenueC,
    uncostedRevenueC: current.uncostedRevenueC,
  };
}
```

- [ ] **Step 9: Write the CSV shaper and the controller**

Create `src/portal/analytics/overview/overview.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { OverviewReport } from './overview.service';

/** One row per KPI, so the export reads like the cards on screen. */
export function overviewCsv(report: OverviewReport): CsvSection[] {
  const money = (label: string, kpi: { value: number | null; previous: number | null; changePct?: number | null }) => [
    label,
    centavosToPesos(kpi.value),
    centavosToPesos(kpi.previous),
    kpi.changePct ?? null,
  ];
  const count = (label: string, kpi: { value: number; previous: number; changePct: number | null }) => [
    label,
    kpi.value,
    kpi.previous,
    kpi.changePct,
  ];

  return [
    {
      title: `Overview ${report.from} to ${report.to}`,
      columns: ['metric', 'value', 'previous', 'change'],
      rows: [
        money('Gross sales', report.grossSalesC),
        money('Discounts', report.discountsC),
        money('Net sales', report.netSalesC),
        money('Service charge', report.serviceChargeC),
        count('Transactions', report.transactions),
        count('Voids', report.voidCount),
        count('Refunds', report.refundCount),
        money('Average basket', report.averageBasketC),
        money('Gross profit', report.grossProfitC),
        [
          'Margin',
          report.marginPct.value,
          report.marginPct.previous,
          report.marginPct.changePoints,
        ],
        money('Costed revenue', { value: report.costedRevenueC, previous: null }),
        money('Uncosted revenue', { value: report.uncostedRevenueC, previous: null }),
      ],
    },
  ];
}
```

Create `src/portal/analytics/overview/overview.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { OverviewService, type OverviewReport } from './overview.service';
import { overviewCsv } from './overview.csv';

/**
 * Overview KPIs (analytics-spec §1). `GET /v1/portal/analytics/overview`.
 *
 * `passthrough: true` keeps Nest's serialisation and the global exception
 * filter in play; `renderReport` only sets headers when CSV was asked for.
 */
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

- [ ] **Step 10: Register the controller**

In `src/portal/analytics/analytics.module.ts`, add the imports and entries:

```ts
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
```

`controllers: [OverviewController]`, and add `OverviewService` to `providers`.

- [ ] **Step 11: Run every test to verify they pass**

```bash
npm test -- overview.math
npm run test:e2e -- portal-analytics-overview
npm run lint && npm run build
```

Expected: all pass. If the CSV case fails on the peso rendering, check `centavosToPesos` is applied in `overview.csv.ts` rather than raw centavos leaking through.

- [ ] **Step 12: Commit**

```bash
git add src/portal/analytics test/portal-analytics-overview.e2e-spec.ts
git commit -m "feat(api): overview report with period comparison and null-safe margin"
```

---

### Task 8: Sales report (§2)

Four endpoints over one family of bucketed queries: the calendar heatmap, the trend line, the hour/weekday patterns, and the three breakdowns.

**Definition used throughout §2:** `salesC` is **net sales** — `subtotal − discount − sc_pwd_discount`, the same figure `netSalesC` reports in §1 — so a heatmap day and an overview card never disagree. Service charge is excluded, as it is in §1.

**Files:**
- Create: `src/portal/analytics/reports/sales-series.sql.ts`
- Create: `src/portal/analytics/sales/sales-report.service.ts`
- Create: `src/portal/analytics/sales/sales-report.controller.ts`
- Create: `src/portal/analytics/sales/sales-report.csv.ts`
- Create: `src/portal/analytics/dto/sales-trend-query.dto.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-sales.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScoped` (Task 5), `MANILA_OFFSET_MINUTES`/`businessDaySeries` (Task 2), `ScopedBusiness` (Task 4), `seedSale` (Task 6).
- Produces:
  - `dayBucketExpr(business): Prisma.Sql` — the business-day bucket, reused by every builder here
  - `heatmapSql`, `trendSalesSql`, `trendLinesSql`, `hourPatternSql`, `paymentBreakdownSql`, `orderTypeBreakdownSql`, `branchBreakdownSql`
  - `class SalesTrendQueryDto extends AnalyticsQueryDto { granularity?: 'day' | 'week' | 'month' }`
  - `GET /v1/portal/analytics/sales/heatmap`, `/trend`, `/patterns`, `/breakdowns`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-sales.e2e-spec.ts`. Reuse the `seedTenant` / bootstrap block from `test/portal-analytics-overview.e2e-spec.ts` verbatim — same imports, same `beforeAll`/`afterAll`/`beforeEach`, same `seedTenant` helper — then:

```ts
  /** 2 March 2026 is a Monday; 10:00 and 15:00 Manila. */
  const MON_10 = new Date('2026-03-02T02:00:00.000Z');
  const MON_15 = new Date('2026-03-02T07:00:00.000Z');
  /** 4 March 2026, Wednesday, 10:00 Manila. */
  const WED_10 = new Date('2026-03-04T02:00:00.000Z');

  const get = (token: string, path: string, query: Record<string, string> = {}) =>
    request(server())
      .get(`/v1/portal/analytics/sales/${path}`)
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

  describe('heatmap', () => {
    it('returns one row per day in the range, zero-filled', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'heatmap').expect(200);

      expect(res.body).toHaveLength(7);
      expect(res.body[0]).toEqual({ date: '2026-03-01', salesC: 0, transactions: 0 });
      expect(res.body[1]).toEqual({ date: '2026-03-02', salesC: 10000, transactions: 1 });
    });

    it('reports NET sales, so a discount shows up on the day', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [
          { qty: 1, unitPriceC: 10000, discount: { source: 'free', kind: 'fixed', value: 2500 } },
        ],
      });

      const res = await get(t.token, 'heatmap').expect(200);
      expect(res.body[1].salesC).toBe(7500);
    });

    it('puts an early-hours sale on the previous day for an 04:00 business', async () => {
      const t = await seedTenant({ dayStartTime: '04:00' });
      // 03:00 Manila on 3 March is 19:00 UTC on 2 March.
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: new Date('2026-03-02T19:00:00.000Z'),
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'heatmap').expect(200);
      const byDate = Object.fromEntries(res.body.map((r: any) => [r.date, r.salesC]));
      expect(byDate['2026-03-02']).toBe(10000);
      expect(byDate['2026-03-03']).toBe(0);
    });
  });

  describe('trend', () => {
    it('buckets by day and carries profit where costs are known', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
      });

      const res = await get(t.token, 'trend', { granularity: 'day' }).expect(200);

      const monday = res.body.find((r: any) => r.bucket === '2026-03-02');
      expect(monday).toEqual({
        bucket: '2026-03-02',
        salesC: 10000,
        grossProfitC: 4000,
        transactions: 1,
      });
    });

    it('leaves profit null on a bucket whose sales are all uncosted', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000, costC: null }],
      });

      const res = await get(t.token, 'trend', { granularity: 'day' }).expect(200);
      expect(res.body.find((r: any) => r.bucket === '2026-03-02').grossProfitC).toBeNull();
    });

    it('collapses the week into a single Monday-dated bucket', async () => {
      const t = await seedTenant();
      const common = { branchId: t.branchId, terminalId: t.terminalId };
      await seedSale(raw, { ...common, createdAt: MON_10, lines: [{ qty: 1, unitPriceC: 10000 }] });
      await seedSale(raw, { ...common, createdAt: WED_10, lines: [{ qty: 1, unitPriceC: 5000 }] });

      const res = await get(t.token, 'trend', { granularity: 'week' }).expect(200);

      expect(res.body).toEqual([
        { bucket: '2026-03-02', salesC: 15000, grossProfitC: null, transactions: 2 },
      ]);
    });

    it('rejects an unknown granularity', async () => {
      const t = await seedTenant();
      await get(t.token, 'trend', { granularity: 'fortnight' }).expect(422);
    });
  });

  describe('patterns', () => {
    it('reports all 24 hours and all 7 weekdays, zero-filled', async () => {
      const t = await seedTenant();
      const res = await get(t.token, 'patterns').expect(200);
      expect(res.body.hourOfDay).toHaveLength(24);
      expect(res.body.dayOfWeek).toHaveLength(7);
    });

    it('places a sale at its Manila wall-clock hour, not the business-day offset', async () => {
      const t = await seedTenant({ dayStartTime: '04:00' });
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_15,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'patterns').expect(200);

      // 15:00 Manila reads as 15:00 whatever the business day starts at.
      expect(res.body.hourOfDay[15]).toEqual({ hour: 15, salesC: 10000, transactions: 1 });
      expect(res.body.hourOfDay[11].salesC).toBe(0);
    });

    it('places a Monday sale on Monday (dayOfWeek 1, Sunday is 0)', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'patterns').expect(200);
      expect(res.body.dayOfWeek[1]).toEqual({ dayOfWeek: 1, salesC: 10000, transactions: 1 });
    });
  });

  describe('breakdowns', () => {
    it('splits by payment method, order type and branch', async () => {
      const t = await seedTenant();
      const common = { branchId: t.branchId, terminalId: t.terminalId, createdAt: MON_10 };
      await seedSale(raw, {
        ...common,
        paymentMethod: 'cash',
        orderType: 'takeout',
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });
      await seedSale(raw, {
        ...common,
        paymentMethod: 'gcash',
        orderType: 'dine_in',
        lines: [{ qty: 1, unitPriceC: 5000 }],
      });

      const res = await get(t.token, 'breakdowns').expect(200);

      const byMethod = Object.fromEntries(
        res.body.byPaymentMethod.map((r: any) => [r.method, r.salesC]),
      );
      expect(byMethod).toEqual({ cash: 10000, gcash: 5000 });

      const byType = Object.fromEntries(
        res.body.byOrderType.map((r: any) => [r.orderType, r.transactions]),
      );
      expect(byType).toEqual({ takeout: 1, dine_in: 1 });

      expect(res.body.byBranch).toEqual([
        { branchId: t.branchId, name: 'Main', salesC: 15000, transactions: 2 },
      ]);
    });

    it('exports every breakdown as one CSV with a section each', async () => {
      const t = await seedTenant();
      await seedSale(raw, {
        branchId: t.branchId,
        terminalId: t.terminalId,
        createdAt: MON_10,
        lines: [{ qty: 1, unitPriceC: 10000 }],
      });

      const res = await get(t.token, 'breakdowns', { format: 'csv' }).expect(200);

      expect(res.headers['content-disposition']).toContain(
        'filename="sales-breakdowns-2026-03-01-2026-03-07.csv"',
      );
      expect(res.text).toContain('By payment method');
      expect(res.text).toContain('By order type');
      expect(res.text).toContain('By branch');
      expect(res.text).toContain('100.00');
    });
  });
```

- [ ] **Step 2: Run the e2e test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-sales
```

Expected: every case 404s.

- [ ] **Step 3: Write the SQL builders**

Create `src/portal/analytics/reports/sales-series.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import { MANILA_OFFSET_MINUTES } from '../scope/business-day';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Bucketed sales queries (analytics-spec §2).
 *
 * `salesC` throughout is NET sales — `subtotal - discount - sc_pwd_discount` —
 * the same figure the overview reports, so a heatmap day and an overview card
 * can never disagree. Service charge is excluded here as it is there.
 *
 * The business-day bucket mirrors `businessDayOf()` exactly: shift the instant
 * by (Manila offset − the business's day start), then take the date. Doing it in
 * SQL and in TypeScript the same way is what lets the zero-fill line up.
 */

const NET_SALES = Prisma.sql`(s.subtotal - s.discount - s.sc_pwd_discount)`;

/** `(created_at + offset)::date` — the business day a sale belongs to. */
export function dayBucketExpr(business: ScopedBusiness): Prisma.Sql {
  const shift = MANILA_OFFSET_MINUTES - business.dayStartMinutes;
  return Prisma.sql`((s.created_at + make_interval(mins => ${shift}))::date)`;
}

/** Shared predicate: completed, live, in this business's window. */
function completedInWindow(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND s.status = 'completed'
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
  `;
}

export interface BucketRow {
  bucket: Date;
  sales_c: bigint;
  transactions: bigint;
}

export function heatmapSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT ${dayBucketExpr(business)} AS bucket,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    WHERE ${completedInWindow(business)}
    GROUP BY 1
  `;
}

export type Granularity = 'day' | 'week' | 'month';

/** `date_trunc` on the bucket date. Postgres weeks start Monday, as §2 asks. */
function truncated(business: ScopedBusiness, granularity: Granularity): Prisma.Sql {
  if (granularity === 'day') return dayBucketExpr(business);
  return Prisma.sql`(date_trunc(${granularity}, ${dayBucketExpr(business)}::timestamp)::date)`;
}

export function trendSalesSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${truncated(business, granularity)} AS bucket,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    WHERE ${completedInWindow(business)}
    GROUP BY 1
  `;
}

export interface TrendProfitRow {
  bucket: Date;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * Profit per bucket. The modifier lateral is not optional: `unit_price` is the
 * base price and the priced modifiers live in the jsonb array
 * (`sales.service.ts:507`), so omitting it understates every such line.
 */
export function trendLinesSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${truncated(business, granularity)} AS bucket,
           COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
           COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
             AS costed_revenue_c,
           COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
             AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
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
    WHERE ${completedInWindow(business)}
      AND si.deleted_at IS NULL
    GROUP BY 1
  `;
}

export interface HourRow {
  hour: number;
  sales_c: bigint;
  transactions: bigint;
}

/**
 * Hour of day uses the Manila WALL CLOCK, deliberately ignoring `dayStartTime`:
 * a 3 PM peak must read as 3 PM whatever hour the business day begins.
 */
export function hourPatternSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT EXTRACT(HOUR FROM s.created_at + make_interval(mins => ${MANILA_OFFSET_MINUTES}))::int AS hour,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    WHERE ${completedInWindow(business)}
    GROUP BY 1
  `;
}

export interface DowRow {
  day_of_week: number;
  sales_c: bigint;
  transactions: bigint;
}

/** Day of week of the BUSINESS day (0 = Sunday), so it agrees with the heatmap. */
export function dowPatternSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT EXTRACT(DOW FROM ${dayBucketExpr(business)})::int AS day_of_week,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    WHERE ${completedInWindow(business)}
    GROUP BY 1
  `;
}

export interface MethodRow {
  method: string;
  sales_c: bigint;
  transactions: bigint;
}

/**
 * Payment split sums `sale_payments.amount`. A sale carries one method in the
 * MVP, but the payments table is the honest source and stays right when split
 * payments arrive.
 */
export function paymentBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT p.method::text AS method,
           COALESCE(SUM(p.amount), 0)::bigint AS sales_c,
           COUNT(DISTINCT s.id)::bigint AS transactions
    FROM sale_payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE ${completedInWindow(business)}
      AND p.deleted_at IS NULL
    GROUP BY 1
  `;
}

export interface OrderTypeRow {
  order_type: string;
  sales_c: bigint;
  transactions: bigint;
}

export function orderTypeBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT s.order_type::text AS order_type,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    WHERE ${completedInWindow(business)}
    GROUP BY 1
  `;
}

export interface BranchRow {
  branch_id: string;
  name: string;
  sales_c: bigint;
  transactions: bigint;
}

export function branchBreakdownSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT s.branch_id::text AS branch_id,
           b.name AS name,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c,
           COUNT(*)::bigint AS transactions
    FROM sales s
    JOIN branches b ON b.id = s.branch_id
    WHERE ${completedInWindow(business)}
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `;
}
```

If `make_interval(mins => $n)` is rejected by the driver, substitute
`(s.created_at + (${shift} * INTERVAL '1 minute'))` — same result, and the
`branch_id` tripwire is unaffected.

- [ ] **Step 4: Write the granularity DTO**

Create `src/portal/analytics/dto/sales-trend-query.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class SalesTrendQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month';
}
```

- [ ] **Step 5: Write the service**

Create `src/portal/analytics/sales/sales-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { AnalyticsScopeService, type ResolvedScope } from '../scope/analytics-scope.service';
import { businessDaySeries } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped } from '../scoped-sql';
import {
  branchBreakdownSql,
  dowPatternSql,
  heatmapSql,
  hourPatternSql,
  orderTypeBreakdownSql,
  paymentBreakdownSql,
  trendLinesSql,
  trendSalesSql,
  type BranchRow,
  type BucketRow,
  type DowRow,
  type Granularity,
  type HourRow,
  type MethodRow,
  type OrderTypeRow,
  type TrendProfitRow,
} from '../reports/sales-series.sql';

export interface HeatmapDay {
  date: string;
  salesC: number;
  transactions: number;
}

export interface TrendBucket {
  bucket: string;
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface PatternsReport {
  hourOfDay: { hour: number; salesC: number; transactions: number }[];
  dayOfWeek: { dayOfWeek: number; salesC: number; transactions: number }[];
}

export interface BreakdownsReport {
  byPaymentMethod: { method: string; salesC: number; transactions: number }[];
  byOrderType: { orderType: string; salesC: number; transactions: number }[];
  byBranch: { branchId: string; name: string; salesC: number; transactions: number }[];
}

/** A Postgres `date` arrives as a Date at UTC midnight; take its date part. */
function bucketKey(bucket: Date): string {
  return bucket.toISOString().slice(0, 10);
}

/**
 * Bucketed sales reports (analytics-spec §2).
 *
 * Buckets are summed ACROSS businesses by their date key, which is only sound
 * because each business's bucket was computed against its own `dayStartTime`
 * before it got here — the SQL never spans businesses.
 */
@Injectable()
export class SalesReportService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async heatmap(query: AnalyticsQueryDto): Promise<HeatmapDay[]> {
    const scope = await this.scope.resolve(query);
    const sales = new Map<string, { salesC: number; transactions: number }>();

    for (const business of scope.businesses) {
      const rows = await runScoped<BucketRow>(this.raw, business, heatmapSql);
      for (const row of rows) {
        const key = bucketKey(row.bucket);
        const acc = sales.get(key) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        sales.set(key, acc);
      }
    }

    await this.reportAudit.log(scope, 'sales-heatmap', query.format ?? 'json');

    // Zero-fill so the calendar grid has no holes.
    return businessDaySeries(scope.from, scope.to).map((date) => ({
      date,
      salesC: sales.get(date)?.salesC ?? 0,
      transactions: sales.get(date)?.transactions ?? 0,
    }));
  }

  async trend(query: SalesTrendQueryDto): Promise<TrendBucket[]> {
    const scope = await this.scope.resolve(query);
    const granularity: Granularity = query.granularity ?? 'day';

    const sales = new Map<string, { salesC: number; transactions: number }>();
    const profit = new Map<
      string,
      { costedLines: number; revenueC: number; costC: number }
    >();

    for (const business of scope.businesses) {
      const [salesRows, lineRows] = await Promise.all([
        runScoped<BucketRow>(this.raw, business, (b) => trendSalesSql(b, granularity)),
        runScoped<TrendProfitRow>(this.raw, business, (b) => trendLinesSql(b, granularity)),
      ]);

      for (const row of salesRows) {
        const key = bucketKey(row.bucket);
        const acc = sales.get(key) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        sales.set(key, acc);
      }
      for (const row of lineRows) {
        const key = bucketKey(row.bucket);
        const acc = profit.get(key) ?? { costedLines: 0, revenueC: 0, costC: 0 };
        acc.costedLines += Number(row.costed_lines);
        acc.revenueC += Number(row.costed_revenue_c);
        acc.costC += Number(row.costed_cost_c);
        profit.set(key, acc);
      }
    }

    await this.reportAudit.log(scope, 'sales-trend', query.format ?? 'json');

    // Only buckets that saw sales are returned: a month or week grid is the
    // portal's business, and zero-filling months would need its own calendar.
    return [...sales.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, row]) => {
        const p = profit.get(bucket);
        return {
          bucket,
          salesC: row.salesC,
          transactions: row.transactions,
          grossProfitC:
            p && p.costedLines > 0 ? p.revenueC - p.costC : null,
        };
      });
  }

  async patterns(query: AnalyticsQueryDto): Promise<PatternsReport> {
    const scope = await this.scope.resolve(query);
    const hours = new Array(24).fill(null).map(() => ({ salesC: 0, transactions: 0 }));
    const days = new Array(7).fill(null).map(() => ({ salesC: 0, transactions: 0 }));

    for (const business of scope.businesses) {
      const [hourRows, dowRows] = await Promise.all([
        runScoped<HourRow>(this.raw, business, hourPatternSql),
        runScoped<DowRow>(this.raw, business, dowPatternSql),
      ]);
      for (const row of hourRows) {
        hours[row.hour].salesC += Number(row.sales_c);
        hours[row.hour].transactions += Number(row.transactions);
      }
      for (const row of dowRows) {
        days[row.day_of_week].salesC += Number(row.sales_c);
        days[row.day_of_week].transactions += Number(row.transactions);
      }
    }

    await this.reportAudit.log(scope, 'sales-patterns', query.format ?? 'json');

    return {
      hourOfDay: hours.map((h, hour) => ({ hour, ...h })),
      dayOfWeek: days.map((d, dayOfWeek) => ({ dayOfWeek, ...d })),
    };
  }

  async breakdowns(query: AnalyticsQueryDto): Promise<BreakdownsReport> {
    const scope = await this.scope.resolve(query);
    const methods = new Map<string, { salesC: number; transactions: number }>();
    const orderTypes = new Map<string, { salesC: number; transactions: number }>();
    const branches: BreakdownsReport['byBranch'] = [];

    for (const business of scope.businesses) {
      const [methodRows, typeRows, branchRows] = await Promise.all([
        runScoped<MethodRow>(this.raw, business, paymentBreakdownSql),
        runScoped<OrderTypeRow>(this.raw, business, orderTypeBreakdownSql),
        runScoped<BranchRow>(this.raw, business, branchBreakdownSql),
      ]);

      for (const row of methodRows) {
        const acc = methods.get(row.method) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        methods.set(row.method, acc);
      }
      for (const row of typeRows) {
        const acc = orderTypes.get(row.order_type) ?? { salesC: 0, transactions: 0 };
        acc.salesC += Number(row.sales_c);
        acc.transactions += Number(row.transactions);
        orderTypes.set(row.order_type, acc);
      }
      for (const row of branchRows) {
        branches.push({
          branchId: row.branch_id,
          name: row.name,
          salesC: Number(row.sales_c),
          transactions: Number(row.transactions),
        });
      }
    }

    await this.reportAudit.log(scope, 'sales-breakdowns', query.format ?? 'json');

    return {
      byPaymentMethod: [...methods.entries()].map(([method, v]) => ({ method, ...v })),
      byOrderType: [...orderTypes.entries()].map(([orderType, v]) => ({ orderType, ...v })),
      byBranch: branches.sort((a, b) => b.salesC - a.salesC),
    };
  }
}
```

- [ ] **Step 6: Write the CSV shapers and the controller**

Create `src/portal/analytics/sales/sales-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type {
  BreakdownsReport,
  HeatmapDay,
  PatternsReport,
  TrendBucket,
} from './sales-report.service';

export function heatmapCsv(days: HeatmapDay[]): CsvSection[] {
  return [
    {
      title: 'Sales by day',
      columns: ['date', 'sales', 'transactions'],
      rows: days.map((d) => [d.date, centavosToPesos(d.salesC), d.transactions]),
    },
  ];
}

export function trendCsv(buckets: TrendBucket[]): CsvSection[] {
  return [
    {
      title: 'Sales trend',
      columns: ['bucket', 'sales', 'gross profit', 'transactions'],
      rows: buckets.map((b) => [
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
      title: 'By hour of day',
      columns: ['hour', 'sales', 'transactions'],
      rows: report.hourOfDay.map((h) => [h.hour, centavosToPesos(h.salesC), h.transactions]),
    },
    {
      title: 'By day of week (0 = Sunday)',
      columns: ['day of week', 'sales', 'transactions'],
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
      columns: ['method', 'sales', 'transactions'],
      rows: report.byPaymentMethod.map((r) => [
        r.method,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By order type',
      columns: ['order type', 'sales', 'transactions'],
      rows: report.byOrderType.map((r) => [
        r.orderType,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By branch',
      columns: ['branch', 'sales', 'transactions'],
      rows: report.byBranch.map((r) => [r.name, centavosToPesos(r.salesC), r.transactions]),
    },
  ];
}
```

Create `src/portal/analytics/sales/sales-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { SalesTrendQueryDto } from '../dto/sales-trend-query.dto';
import { renderReport } from '../report-response';
import {
  SalesReportService,
  type BreakdownsReport,
  type HeatmapDay,
  type PatternsReport,
  type TrendBucket,
} from './sales-report.service';
import {
  breakdownsCsv,
  heatmapCsv,
  patternsCsv,
  trendCsv,
} from './sales-report.csv';

/** Sales reports (analytics-spec §2) under `/v1/portal/analytics/sales/*`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class SalesReportController {
  constructor(private readonly sales: SalesReportService) {}

  @Get('analytics/sales/heatmap')
  async heatmap(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeatmapDay[] | string> {
    return renderReport(res, 'sales-heatmap', query, await this.sales.heatmap(query), heatmapCsv);
  }

  @Get('analytics/sales/trend')
  async trend(
    @Query() query: SalesTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrendBucket[] | string> {
    return renderReport(res, 'sales-trend', query, await this.sales.trend(query), trendCsv);
  }

  @Get('analytics/sales/patterns')
  async patterns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatternsReport | string> {
    return renderReport(res, 'sales-patterns', query, await this.sales.patterns(query), patternsCsv);
  }

  @Get('analytics/sales/breakdowns')
  async breakdowns(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BreakdownsReport | string> {
    return renderReport(
      res,
      'sales-breakdowns',
      query,
      await this.sales.breakdowns(query),
      breakdownsCsv,
    );
  }
}
```

- [ ] **Step 7: Register the controller**

Add `SalesReportController` to `controllers` and `SalesReportService` to `providers` in `src/portal/analytics/analytics.module.ts`.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-sales
npm run lint && npm run build
```

Expected: all pass. If the 04:00 heatmap case fails by one day, the SQL bucket and `businessDayOf` have drifted apart — compare the sign of the shift in `dayBucketExpr` against `business-day.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-sales.e2e-spec.ts
git commit -m "feat(api): sales heatmap, trend, hour/weekday patterns and breakdowns"
```

---

### Task 9: Tax summary (§6)

The accountant's view. Small, and the numbers must reconcile with a printed receipt to the centavo.

**Files:**
- Create: `src/portal/analytics/reports/tax.sql.ts`
- Create: `src/portal/analytics/tax/tax-report.service.ts`
- Create: `src/portal/analytics/tax/tax-report.controller.ts`
- Create: `src/portal/analytics/tax/tax-report.csv.ts`
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-tax.e2e-spec.ts`

**Interfaces:**
- Consumes: `runScopedOne`, `AnalyticsScopeService`, `ReportAuditService`, `renderReport`, `seedSale`.
- Produces:
  - `interface TaxRow { vatable_sales_c, vat_c, vat_exempt_sales_c, sc_pwd_discount_c, service_charge_c: bigint }`
  - `taxSummarySql(business): Prisma.Sql`
  - `interface TaxReport { from, to, businesses: TaxBusinessRow[], totals: TaxTotals }`
  - `GET /v1/portal/analytics/tax`

- [ ] **Step 1: Write the failing e2e test**

Create `test/portal-analytics-tax.e2e-spec.ts`, reusing the bootstrap and `seedTenant` block from `test/portal-analytics-overview.e2e-spec.ts` verbatim, then:

```ts
  const DURING = new Date('2026-03-02T02:00:00.000Z');

  const tax = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/v1/portal/analytics/tax')
      .query({ from: '2026-03-01', to: '2026-03-07', ...query })
      .set('Authorization', `Bearer ${token}`);

  it('reconciles vatable sales, VAT and the total to the centavo', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      taxRate: 0.12,
      lines: [{ qty: 1, unitPriceC: 11200 }],
    });

    const res = await tax(t.token).expect(200);
    const row = res.body.businesses[0];

    // Prices are VAT-inclusive: 112.00 total carries 12.00 VAT over 100.00 net.
    expect(row.vatC).toBe(1200);
    expect(row.vatableSalesC).toBe(10000);
    expect(row.vatExemptSalesC).toBe(0);
    expect(row.vatableSalesC + row.vatC + row.vatExemptSalesC).toBe(sale.total);
  });

  it('reports SC/PWD sales as VAT-exempt with their discount', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      taxRate: 0.12,
      scPwd: { idNo: 'SC-1', name: 'Lola' },
      lines: [{ qty: 1, unitPriceC: 11200, scPwdMarked: true }],
    });

    const res = await tax(t.token).expect(200);
    const row = res.body.businesses[0];

    expect(row.vatExemptSalesC).toBeGreaterThan(0);
    expect(row.scPwdDiscountC).toBeGreaterThan(0);
    expect(row.vatC).toBe(0);
  });

  it('reports the service charge collected', async () => {
    const t = await seedTenant({ serviceChargeRate: '0.10' });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      orderType: 'dine_in',
      serviceChargeRate: 0.1,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });

    const res = await tax(t.token).expect(200);
    expect(res.body.businesses[0].serviceChargeC).toBe(1000);
  });

  it('keeps a row per business and never blends tax rates', async () => {
    const t = await seedTenant();
    const owner = (await raw.business.findUniqueOrThrow({ where: { id: t.businessId } })).ownerId;
    const second = await raw.business.create({
      data: { ownerId: owner, name: 'Second', type: 'fnb', taxRate: '0.00' },
    });
    await raw.branch.create({
      data: { businessId: second.id, name: 'B2', code: 'B2', address: 'x' },
    });

    const res = await tax(t.token).expect(200);

    expect(res.body.businesses).toHaveLength(2);
    expect(res.body.businesses.map((b: any) => b.taxRate).sort()).toEqual([0, 0.12]);
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.taxRate).toBeUndefined();
  });

  it('exports as CSV in pesos', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 11200 }],
    });

    const res = await tax(t.token, { format: 'csv' }).expect(200);
    expect(res.headers['content-disposition']).toContain('filename="tax-2026-03-01-2026-03-07.csv"');
    expect(res.text).toContain('12.00');
  });
```

- [ ] **Step 2: Run the e2e test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-tax
```

Expected: 404 on every case.

- [ ] **Step 3: Write the SQL builder**

Create `src/portal/analytics/reports/tax.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Tax summary (analytics-spec §6).
 *
 * The columns mirror the engine's `CartTotals` exactly — `vatableSalesC` is
 * `total - vatExemptSales - vat` there (`totals.ts`), so it is the same
 * subtraction here. Computing it any other way would let a receipt and this
 * report disagree, which is the one thing an accountant's view cannot do.
 */
export interface TaxRow {
  vatable_sales_c: bigint;
  vat_c: bigint;
  vat_exempt_sales_c: bigint;
  sc_pwd_discount_c: bigint;
  service_charge_c: bigint;
}

export function taxSummarySql(business: ScopedBusiness): Prisma.Sql {
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
```

- [ ] **Step 4: Write the service, CSV shaper and controller**

Create `src/portal/analytics/tax/tax-report.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { AnalyticsScopeService } from '../scope/analytics-scope.service';
import { ReportAuditService } from '../report-audit.service';
import { runScopedOne } from '../scoped-sql';
import { taxSummarySql, type TaxRow } from '../reports/tax.sql';

export interface TaxBusinessRow {
  businessId: string;
  name: string;
  taxRate: number;
  vatableSalesC: number;
  vatC: number;
  vatExemptSalesC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
}

export interface TaxTotals {
  vatableSalesC: number;
  vatC: number;
  vatExemptSalesC: number;
  scPwdDiscountC: number;
  serviceChargeC: number;
}

export interface TaxReport {
  from: string;
  to: string;
  businesses: TaxBusinessRow[];
  totals: TaxTotals;
}

/**
 * Tax summary (analytics-spec §6).
 *
 * A row per business, deliberately: the money columns add up across businesses,
 * but `taxRate` does not — a blended rate is a number that is true of nothing,
 * so `totals` carries no rate at all.
 */
@Injectable()
export class TaxReportService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(query: AnalyticsQueryDto): Promise<TaxReport> {
    const scope = await this.scope.resolve(query);
    const businesses: TaxBusinessRow[] = [];
    const totals: TaxTotals = {
      vatableSalesC: 0,
      vatC: 0,
      vatExemptSalesC: 0,
      scPwdDiscountC: 0,
      serviceChargeC: 0,
    };

    for (const business of scope.businesses) {
      const row = await runScopedOne<TaxRow>(this.raw, business, taxSummarySql);
      const mapped: TaxBusinessRow = {
        businessId: business.id,
        name: business.name,
        taxRate: business.taxRate,
        vatableSalesC: Number(row.vatable_sales_c),
        vatC: Number(row.vat_c),
        vatExemptSalesC: Number(row.vat_exempt_sales_c),
        scPwdDiscountC: Number(row.sc_pwd_discount_c),
        serviceChargeC: Number(row.service_charge_c),
      };
      businesses.push(mapped);
      totals.vatableSalesC += mapped.vatableSalesC;
      totals.vatC += mapped.vatC;
      totals.vatExemptSalesC += mapped.vatExemptSalesC;
      totals.scPwdDiscountC += mapped.scPwdDiscountC;
      totals.serviceChargeC += mapped.serviceChargeC;
    }

    await this.reportAudit.log(scope, 'tax', query.format ?? 'json');
    return { from: scope.from, to: scope.to, businesses, totals };
  }
}
```

Create `src/portal/analytics/tax/tax-report.csv.ts`:

```ts
import { centavosToPesos, type CsvSection } from '../csv';
import type { TaxReport } from './tax-report.service';

export function taxCsv(report: TaxReport): CsvSection[] {
  const columns = [
    'business',
    'tax rate',
    'vatable sales',
    'VAT',
    'VAT-exempt sales',
    'SC/PWD discount',
    'service charge',
  ];
  return [
    {
      title: `Tax summary ${report.from} to ${report.to}`,
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
          'All businesses',
          null,
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

Create `src/portal/analytics/tax/tax-report.controller.ts`:

```ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { AnalyticsQueryDto } from '../dto/analytics-query.dto';
import { renderReport } from '../report-response';
import { TaxReportService, type TaxReport } from './tax-report.service';
import { taxCsv } from './tax-report.csv';

/** Tax summary (analytics-spec §6). `GET /v1/portal/analytics/tax`. */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class TaxReportController {
  constructor(private readonly tax: TaxReportService) {}

  @Get('analytics/tax')
  async get(
    @Query() query: AnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxReport | string> {
    return renderReport(res, 'tax', query, await this.tax.run(query), taxCsv);
  }
}
```

- [ ] **Step 5: Register and run**

Add `TaxReportController` to `controllers` and `TaxReportService` to `providers` in `analytics.module.ts`, then:

```bash
npm run test:e2e -- portal-analytics-tax
npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/portal/analytics test/portal-analytics-tax.e2e-spec.ts
git commit -m "feat(api): tax summary reconciling vatable sales, vat and sc/pwd exemptions"
```

---

### Task 10: Dashboard (§0)

The portal landing: "is everything okay?" in zero clicks. It spans every non-demo business and deliberately ignores the business switcher, so it takes no scope parameters.

**Files:**
- Create: `src/portal/analytics/reports/dashboard.sql.ts`
- Create: `src/portal/analytics/dashboard/dashboard.service.ts`
- Create: `src/portal/analytics/dashboard/dashboard.controller.ts`
- Modify: `src/portal/analytics/scope/business-day.ts` (add `addDays`)
- Modify: `src/portal/analytics/scope/business-day.spec.ts`
- Modify: `src/portal/analytics/scope/analytics-scope.service.ts` (add `resolveToday`)
- Modify: `src/portal/analytics/analytics.module.ts`
- Test: `test/portal-analytics-dashboard.e2e-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces:
  - `addDays(date: string, days: number): string`
  - `AnalyticsScopeService.resolveToday(now: Date): Promise<ResolvedScope>`
  - `dashboardSalesSql(business, fromUtc, toUtc)`, `dashboardSparklineSql(business, fromUtc, toUtc)`, `lowStockCountSql(business)`
  - `GET /v1/portal/dashboard`

- [ ] **Step 1: Add `addDays` with its test**

Append to `src/portal/analytics/scope/business-day.spec.ts`:

```ts
describe('addDays', () => {
  it('moves forward and backward across a month boundary', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-08', -7)).toBe('2026-03-01');
  });
});
```

Add `addDays` to the import list at the top of that file, then append to `src/portal/analytics/scope/business-day.ts`:

```ts
/** Shift a `YYYY-MM-DD` date by whole days. Safe: no DST to fall into. */
export function addDays(date: string, days: number): string {
  const base = businessDayStartUtc(date, 0).getTime() + days * DAY_MS;
  return businessDayOf(new Date(base), 0);
}
```

Run `npm test -- business-day` — all pass.

- [ ] **Step 2: Add `resolveToday` to the scope resolver**

Append to `src/portal/analytics/scope/analytics-scope.service.ts` (inside the class), and add `addDays`, `businessDayOf`, `businessDayStartUtc` to its imports from `./business-day`:

```ts
  /**
   * The dashboard's scope: every non-demo business, each windowed on ITS OWN
   * today.
   *
   * "Today" is not one date across a tenant — at 3 AM a midnight retailer is
   * already on the new business day while an 04:00 cafe is still on yesterday's.
   * So each business gets `businessDayOf(now, its own day start)`.
   *
   * `previousFromUtc`/`previousToUtc` here mean the SAME BUSINESS DAY ONE WEEK
   * EARLIER, not the immediately preceding period — that is the comparison
   * analytics-spec §0 asks for, and weekday-to-weekday is the only fair one for
   * a single day.
   *
   * `scope.from`/`scope.to` carry the first business's today, and exist only so
   * the audit rows say which day was viewed.
   */
  async resolveToday(now: Date): Promise<ResolvedScope> {
    const businesses = await this.scoped.business.findMany({
      where: { isDemo: false },
      select: { id: true, name: true, dayStartTime: true, taxRate: true },
      orderBy: { createdAt: 'asc' },
    });
    const branches = await this.scoped.branch.findMany({
      where: { businessId: { in: businesses.map((b) => b.id) } },
      select: { id: true, businessId: true },
      orderBy: { createdAt: 'asc' },
    });

    const byBusiness = new Map<string, string[]>();
    for (const branch of branches) {
      const list = byBusiness.get(branch.businessId);
      if (list) list.push(branch.id);
      else byBusiness.set(branch.businessId, [branch.id]);
    }

    const scoped: ScopedBusiness[] = [];
    for (const business of businesses) {
      const branchIds = byBusiness.get(business.id);
      if (!branchIds || branchIds.length === 0) continue;

      const dayStartMinutes = parseDayStart(business.dayStartTime);
      const today = businessDayOf(now, dayStartMinutes);
      const lastWeek = addDays(today, -7);

      scoped.push({
        id: business.id,
        name: business.name,
        dayStartTime: business.dayStartTime,
        dayStartMinutes,
        taxRate: Number(business.taxRate),
        branchIds,
        fromUtc: businessDayStartUtc(today, dayStartMinutes),
        toUtc: businessDayStartUtc(addDays(today, 1), dayStartMinutes),
        previousFromUtc: businessDayStartUtc(lastWeek, dayStartMinutes),
        previousToUtc: businessDayStartUtc(addDays(lastWeek, 1), dayStartMinutes),
      });
    }

    const first = scoped[0];
    const stamp = first ? businessDayOf(now, first.dayStartMinutes) : businessDayOf(now, 0);

    return {
      businesses: scoped,
      branchIds: scoped.flatMap((b) => b.branchIds),
      from: stamp,
      to: stamp,
      dayCount: 1,
    };
  }
```

- [ ] **Step 3: Write the failing e2e test**

Create `test/portal-analytics-dashboard.e2e-spec.ts`, reusing the bootstrap and `seedTenant` block from `test/portal-analytics-overview.e2e-spec.ts`, then:

```ts
  const dashboard = (token: string) =>
    request(server())
      .get('/v1/portal/dashboard')
      .set('Authorization', `Bearer ${token}`);

  /** Now, and the same clock time seven days ago — both inside today's window. */
  const now = () => new Date();
  const lastWeek = () => new Date(Date.now() - 7 * 86_400_000);

  it('reports today per business, with a branch row and a 7-day sparkline', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: now(),
      lines: [{ qty: 1, unitPriceC: 10000, costC: 6000 }],
    });

    const res = await dashboard(t.token).expect(200);
    const business = res.body.businesses.find((b: any) => b.businessId === t.businessId);

    expect(business.today).toEqual({ salesC: 10000, grossProfitC: 4000, transactions: 1 });
    expect(business.branches).toEqual([
      { branchId: t.branchId, name: 'Main', salesC: 10000, grossProfitC: 4000, transactions: 1 },
    ]);
    expect(business.sparkline).toHaveLength(7);
    expect(business.sparkline[6].salesC).toBe(10000);
  });

  it('compares against the same day last week', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: lastWeek(),
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const res = await dashboard(t.token).expect(200);
    const business = res.body.businesses.find((b: any) => b.businessId === t.businessId);

    expect(business.today.salesC).toBe(0);
    expect(business.sameDayLastWeek.salesC).toBe(5000);
  });

  it('excludes demo businesses from the landing', async () => {
    const t = await seedTenant();
    const owner = (await raw.business.findUniqueOrThrow({ where: { id: t.businessId } })).ownerId;
    const demo = await raw.business.create({
      data: { ownerId: owner, name: 'Demo', type: 'retail', taxRate: '0.12', isDemo: true },
    });
    await raw.branch.create({
      data: { businessId: demo.id, name: 'D', code: 'DM', address: 'x' },
    });

    const res = await dashboard(t.token).expect(200);
    expect(res.body.businesses.map((b: any) => b.businessId)).not.toContain(demo.id);
  });

  it('lists open shifts and terminals in the live strip', async () => {
    const t = await seedTenant();
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date(),
        openingCash: 100000,
      },
    });

    const res = await dashboard(t.token).expect(200);

    expect(res.body.live.openShifts).toHaveLength(1);
    expect(res.body.live.openShifts[0]).toMatchObject({
      branchId: t.branchId,
      branchName: 'Main',
      terminalName: 'T1',
    });
    expect(res.body.live.terminals[0]).toMatchObject({ code: 'T1', paired: false });
  });

  it('counts unread notifications, which is zero until they are written', async () => {
    const t = await seedTenant();
    const res = await dashboard(t.token).expect(200);
    expect(res.body.live.unreadNotifications).toBe(0);
  });

  it('flags low stock and shifts left open past 24 hours', async () => {
    const t = await seedTenant();
    const category = await raw.category.create({
      data: { businessId: t.businessId, name: 'Grocery' },
    });
    const product = await raw.product.create({
      data: {
        businessId: t.businessId,
        categoryId: category.id,
        name: 'Rice',
        price: 5000,
        lowStockThreshold: '10',
      },
    });
    await raw.branchStock.create({
      data: { branchId: t.branchId, productId: product.id, qty: '4' },
    });
    await raw.shift.create({
      data: {
        branchId: t.branchId,
        terminalId: t.terminalId,
        openedAt: new Date(Date.now() - 30 * 3_600_000),
        openingCash: 0,
      },
    });

    const res = await dashboard(t.token).expect(200);

    expect(res.body.attention.lowStock).toEqual([{ businessId: t.businessId, count: 1 }]);
    expect(res.body.attention.unclosedShifts).toEqual([{ businessId: t.businessId, count: 1 }]);
  });

  it('audits the dashboard read against each business', async () => {
    const t = await seedTenant();
    await dashboard(t.token).expect(200);

    const rows = await raw.auditLog.findMany({
      where: { businessId: t.businessId, action: 'audit.report_read' },
    });
    expect(rows).toHaveLength(1);
  });
```

- [ ] **Step 4: Run the e2e test to verify it fails**

```bash
npm run test:e2e -- portal-analytics-dashboard
```

Expected: 404 on every case.

- [ ] **Step 5: Write the SQL builders**

Create `src/portal/analytics/reports/dashboard.sql.ts`:

```ts
import { Prisma } from '@prisma/client';
import { MANILA_OFFSET_MINUTES } from '../scope/business-day';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Dashboard queries (analytics-spec §0).
 *
 * Only the figures Prisma genuinely cannot express live here. Open shifts,
 * terminals and unread notifications are plain scoped-client reads in the
 * service — they need no aggregation, and going through the choke point is
 * strictly safer than raw SQL.
 *
 * Low stock is the exception: it compares two columns
 * (`branch_stock.qty <= products.low_stock_threshold`), which Prisma has no
 * syntax for, so it is raw — and still scoped by `branch_id`.
 */

const NET_SALES = Prisma.sql`(s.subtotal - s.discount - s.sc_pwd_discount)`;

export interface DashboardBranchRow {
  branch_id: string;
  name: string;
  sales_c: bigint;
  transactions: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * Per-branch sales and profit for one window. The profit half joins
 * `sale_items` through the same modifier lateral every revenue query uses —
 * `unit_price` alone would understate any line with a priced modifier.
 */
export function dashboardBranchSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  return Prisma.sql`
    WITH scoped_sales AS (
      SELECT s.id, s.branch_id, ${NET_SALES} AS net_c
      FROM sales s
      WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
        AND s.deleted_at IS NULL
        AND s.status = 'completed'
        AND s.created_at >= ${fromUtc}
        AND s.created_at <  ${toUtc}
    ),
    lines AS (
      SELECT ss.branch_id,
             COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL) AS costed_lines,
             COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0) AS costed_revenue_c,
             COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0) AS costed_cost_c
      FROM sale_items si
      JOIN scoped_sales ss ON ss.id = si.sale_id
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
      WHERE si.deleted_at IS NULL
      GROUP BY 1
    )
    SELECT b.id::text AS branch_id,
           b.name     AS name,
           COALESCE(SUM(ss.net_c), 0)::bigint AS sales_c,
           COUNT(ss.id)::bigint               AS transactions,
           COALESCE(MAX(l.costed_lines), 0)::bigint      AS costed_lines,
           COALESCE(MAX(l.costed_revenue_c), 0)::bigint  AS costed_revenue_c,
           COALESCE(MAX(l.costed_cost_c), 0)::bigint     AS costed_cost_c
    FROM branches b
    LEFT JOIN scoped_sales ss ON ss.branch_id = b.id
    LEFT JOIN lines l ON l.branch_id = b.id
    WHERE b.id = ANY(${business.branchIds}::uuid[])
      AND b.deleted_at IS NULL
    GROUP BY 1, 2
    ORDER BY 2
  `;
}

export interface SparklineRow {
  bucket: Date;
  sales_c: bigint;
}

export function dashboardSparklineSql(
  business: ScopedBusiness,
  fromUtc: Date,
  toUtc: Date,
): Prisma.Sql {
  const shift = MANILA_OFFSET_MINUTES - business.dayStartMinutes;
  return Prisma.sql`
    SELECT ((s.created_at + make_interval(mins => ${shift}))::date) AS bucket,
           COALESCE(SUM(${NET_SALES}), 0)::bigint AS sales_c
    FROM sales s
    WHERE s.branch_id = ANY(${business.branchIds}::uuid[])
      AND s.deleted_at IS NULL
      AND s.status = 'completed'
      AND s.created_at >= ${fromUtc}
      AND s.created_at <  ${toUtc}
    GROUP BY 1
  `;
}

export interface CountRow {
  count: bigint;
}

/** Products at or below their threshold. Products without one are not "low". */
export function lowStockCountSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM branch_stock bs
    JOIN products p ON p.id = bs.product_id
    WHERE bs.branch_id = ANY(${business.branchIds}::uuid[])
      AND bs.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND p.low_stock_threshold IS NOT NULL
      AND bs.qty <= p.low_stock_threshold
  `;
}
```

- [ ] **Step 6: Write the service**

Create `src/portal/analytics/dashboard/dashboard.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../../prisma/scoped-prisma.provider';
import { AnalyticsScopeService, type ScopedBusiness } from '../scope/analytics-scope.service';
import { addDays, businessDayOf, businessDayStartUtc } from '../scope/business-day';
import { ReportAuditService } from '../report-audit.service';
import { runScoped, runScopedOne } from '../scoped-sql';
import {
  dashboardBranchSql,
  dashboardSparklineSql,
  lowStockCountSql,
  type CountRow,
  type DashboardBranchRow,
  type SparklineRow,
} from '../reports/dashboard.sql';

const SPARKLINE_DAYS = 7;
const UNCLOSED_SHIFT_HOURS = 24;

export interface DayFigures {
  salesC: number;
  grossProfitC: number | null;
  transactions: number;
}

export interface DashboardReport {
  businesses: {
    businessId: string;
    name: string;
    today: DayFigures;
    sameDayLastWeek: DayFigures;
    branches: (DayFigures & { branchId: string; name: string })[];
    sparkline: { date: string; salesC: number }[];
  }[];
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

function figuresOf(rows: DashboardBranchRow[]): DayFigures {
  const costedLines = rows.reduce((n, r) => n + Number(r.costed_lines), 0);
  const revenue = rows.reduce((n, r) => n + Number(r.costed_revenue_c), 0);
  const cost = rows.reduce((n, r) => n + Number(r.costed_cost_c), 0);
  return {
    salesC: rows.reduce((n, r) => n + Number(r.sales_c), 0),
    transactions: rows.reduce((n, r) => n + Number(r.transactions), 0),
    grossProfitC: costedLines === 0 ? null : revenue - cost,
  };
}

/**
 * The portal landing (analytics-spec §0): "is everything okay?" in zero clicks.
 *
 * Spans every non-demo business and ignores the business switcher by design, so
 * it takes no scope parameters. Each business is windowed on its OWN today —
 * see `resolveToday`.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly scope: AnalyticsScopeService,
    private readonly raw: PrismaService,
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly reportAudit: ReportAuditService,
  ) {}

  async run(now: Date): Promise<DashboardReport> {
    const scope = await this.scope.resolveToday(now);
    const businesses: DashboardReport['businesses'] = [];
    const lowStock: DashboardReport['attention']['lowStock'] = [];

    for (const business of scope.businesses) {
      const [todayRows, lastWeekRows, sparkRows, low] = await Promise.all([
        runScoped<DashboardBranchRow>(this.raw, business, (b) =>
          dashboardBranchSql(b, b.fromUtc, b.toUtc),
        ),
        runScoped<DashboardBranchRow>(this.raw, business, (b) =>
          dashboardBranchSql(b, b.previousFromUtc, b.previousToUtc),
        ),
        this.sparkline(business, now),
        runScopedOne<CountRow>(this.raw, business, lowStockCountSql),
      ]);

      businesses.push({
        businessId: business.id,
        name: business.name,
        today: figuresOf(todayRows),
        sameDayLastWeek: figuresOf(lastWeekRows),
        branches: todayRows.map((row) => ({
          branchId: row.branch_id,
          name: row.name,
          ...figuresOf([row]),
        })),
        sparkline: sparkRows,
      });

      lowStock.push({ businessId: business.id, count: Number(low.count) });
    }

    const [openShifts, terminals, unreadNotifications, unclosedShifts] =
      await Promise.all([
        this.openShifts(scope.businesses),
        this.terminals(scope.businesses),
        this.scoped.notification.count({ where: { readAt: null } }),
        this.unclosedShifts(scope.businesses, now),
      ]);

    await this.reportAudit.log(scope, 'dashboard', 'json');

    return {
      businesses,
      live: { openShifts, terminals, unreadNotifications },
      attention: { lowStock, unclosedShifts },
    };
  }

  /** Seven business days ending today, zero-filled so the chart has no gaps. */
  private async sparkline(
    business: ScopedBusiness,
    now: Date,
  ): Promise<{ date: string; salesC: number }[]> {
    const today = businessDayOf(now, business.dayStartMinutes);
    const first = addDays(today, -(SPARKLINE_DAYS - 1));
    const fromUtc = businessDayStartUtc(first, business.dayStartMinutes);

    const rows = await runScoped<SparklineRow>(this.raw, business, (b) =>
      dashboardSparklineSql(b, fromUtc, b.toUtc),
    );
    const byDate = new Map(
      rows.map((r) => [r.bucket.toISOString().slice(0, 10), Number(r.sales_c)]),
    );

    return Array.from({ length: SPARKLINE_DAYS }, (_, i) => {
      const date = addDays(first, i);
      return { date, salesC: byDate.get(date) ?? 0 };
    });
  }

  private async openShifts(businesses: ScopedBusiness[]) {
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.shift.findMany({
      where: { branchId: { in: [...branchToBusiness.keys()] }, closedAt: null },
      select: {
        id: true,
        branchId: true,
        openedAt: true,
        branch: { select: { name: true } },
        terminal: { select: { name: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map((row) => ({
      shiftId: row.id,
      businessId: branchToBusiness.get(row.branchId) ?? '',
      branchId: row.branchId,
      branchName: row.branch.name,
      terminalName: row.terminal.name,
      openedAt: row.openedAt,
    }));
  }

  private async terminals(businesses: ScopedBusiness[]) {
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.terminal.findMany({
      where: { branchId: { in: [...branchToBusiness.keys()] } },
      select: {
        id: true,
        branchId: true,
        name: true,
        code: true,
        lastSeenAt: true,
        deviceTokenHash: true,
      },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      terminalId: row.id,
      businessId: branchToBusiness.get(row.branchId) ?? '',
      branchId: row.branchId,
      name: row.name,
      code: row.code,
      lastSeenAt: row.lastSeenAt,
      // The token hash never leaves the service — only whether one exists.
      paired: row.deviceTokenHash !== null,
    }));
  }

  /**
   * A shift open longer than 24 hours is an operator error worth surfacing: a
   * drawer belongs to one day of trading, so anything longer means someone went
   * home without closing.
   */
  private async unclosedShifts(businesses: ScopedBusiness[], now: Date) {
    const cutoff = new Date(now.getTime() - UNCLOSED_SHIFT_HOURS * 3_600_000);
    const branchToBusiness = branchIndex(businesses);
    const rows = await this.scoped.shift.findMany({
      where: {
        branchId: { in: [...branchToBusiness.keys()] },
        closedAt: null,
        openedAt: { lt: cutoff },
      },
      select: { branchId: true },
    });

    const counts = new Map<string, number>();
    for (const business of businesses) counts.set(business.id, 0);
    for (const row of rows) {
      const businessId = branchToBusiness.get(row.branchId);
      if (businessId) counts.set(businessId, (counts.get(businessId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([businessId, count]) => ({ businessId, count }));
  }
}

function branchIndex(businesses: ScopedBusiness[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const business of businesses) {
    for (const branchId of business.branchIds) index.set(branchId, business.id);
  }
  return index;
}
```

- [ ] **Step 7: Write the controller and register it**

Create `src/portal/analytics/dashboard/dashboard.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { PortalAuthGuard } from '../../../auth/guards/portal-auth.guard';
import { DashboardService, type DashboardReport } from './dashboard.service';

/**
 * The portal landing (analytics-spec §0). `GET /v1/portal/dashboard`.
 *
 * No query parameters: it spans every non-demo business and ignores the
 * business switcher. No CSV either — this is a glanceable summary, and every
 * card taps through to a report that does export.
 */
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(): Promise<DashboardReport> {
    return this.dashboard.run(new Date());
  }
}
```

Add `DashboardController` to `controllers` and `DashboardService` to `providers` in `analytics.module.ts`.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:e2e -- portal-analytics-dashboard
npm run lint && npm run build
```

Expected: all pass. If the sparkline's last entry is empty, check that `dashboardSparklineSql` is given the business's `toUtc` (end of today) rather than the sparkline's own start.

- [ ] **Step 9: Commit**

```bash
git add src/portal/analytics test/portal-analytics-dashboard.e2e-spec.ts
git commit -m "feat(api): portal dashboard spanning every business with live and attention strips"
```

---

### Task 11: Cross-cutting guarantees

Three properties hold across *every* endpoint rather than inside any one of them, so they get their own specs. The null-cost rule and business-day bucketing are already asserted where they bite (overview and sales); these add the sweeps that no single report spec can make.

**Files:**
- Create: `test/portal-analytics-tenancy.e2e-spec.ts`
- Create: `test/portal-analytics-invariants.e2e-spec.ts`
- Test: both of the above

**Interfaces:**
- Consumes: every endpoint from Tasks 7–10, `seedSale` (Task 6), `computeTotals` from `src/common/totals/totals`.
- Produces: no source changes. If either spec fails, the fix is in the code it exercises.

- [ ] **Step 1: Write the tenancy sweep**

Create `test/portal-analytics-tenancy.e2e-spec.ts`, reusing the bootstrap and `seedTenant` block from `test/portal-analytics-overview.e2e-spec.ts`, then:

```ts
  /*
   * Analytics is the only place in this API that runs raw SQL, and raw SQL
   * bypasses the tenancy choke point entirely (`scoped-sql.ts` explains why).
   * These are the tests that keep that honest: every endpoint, both directions.
   */

  const DURING = new Date('2026-03-02T02:00:00.000Z');
  const RANGE = { from: '2026-03-01', to: '2026-03-07' };

  /** Every report endpoint, so a new one cannot be added without a decision. */
  const ENDPOINTS = [
    'analytics/overview',
    'analytics/sales/heatmap',
    'analytics/sales/trend',
    'analytics/sales/patterns',
    'analytics/sales/breakdowns',
    'analytics/tax',
  ];

  it('404s on every endpoint when the businessId belongs to someone else', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    for (const path of ENDPOINTS) {
      await request(server())
        .get(`/v1/portal/${path}`)
        .query({ ...RANGE, businessId: theirs.businessId })
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    }
  });

  it('404s on every endpoint when the branchId belongs to someone else', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    for (const path of ENDPOINTS) {
      await request(server())
        .get(`/v1/portal/${path}`)
        .query({ ...RANGE, businessId: mine.businessId, branchId: theirs.branchId })
        .set('Authorization', `Bearer ${mine.token}`)
        .expect(404);
    }
  });

  it("never counts another owner's sales in an unscoped sweep", async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    await seedSale(raw, {
      branchId: mine.branchId,
      terminalId: mine.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 10000 }],
    });
    await seedSale(raw, {
      branchId: theirs.branchId,
      terminalId: theirs.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1, unitPriceC: 99900 }],
    });

    const overview = await request(server())
      .get('/v1/portal/analytics/overview')
      .query(RANGE)
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(overview.body.grossSalesC.value).toBe(10000);

    const breakdowns = await request(server())
      .get('/v1/portal/analytics/sales/breakdowns')
      .query(RANGE)
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(breakdowns.body.byBranch.map((b: any) => b.branchId)).toEqual([mine.branchId]);

    const dashboard = await request(server())
      .get('/v1/portal/dashboard')
      .set('Authorization', `Bearer ${mine.token}`)
      .expect(200);
    expect(dashboard.body.businesses.map((b: any) => b.businessId)).toEqual([
      mine.businessId,
    ]);
  });

  it('rejects an unauthenticated caller on every endpoint, dashboard included', async () => {
    for (const path of [...ENDPOINTS, 'dashboard']) {
      await request(server()).get(`/v1/portal/${path}`).query(RANGE).expect(401);
    }
  });
```

- [ ] **Step 2: Run the tenancy sweep**

```bash
npm run test:e2e -- portal-analytics-tenancy
```

Expected: PASS. A failure here means a report query is missing its `branch_id` predicate — fix the SQL builder, not the test. If `runScoped`'s tripwire caught it, the failure will be a 500 naming the builder.

- [ ] **Step 3: Write the invariant spec**

Create `test/portal-analytics-invariants.e2e-spec.ts`, reusing the bootstrap and `seedTenant` block, then:

```ts
  /*
   * Properties that must hold across reports, not within one.
   *
   * The modifier case is the one that matters most: `sale_items.unit_price` is
   * the BASE price and priced modifiers live in the jsonb array, so a report
   * that multiplies qty by unit_price alone silently understates revenue on
   * every such line. Here the report must agree with `sales.subtotal`, which
   * the engine computed.
   */
  const DURING = new Date('2026-03-02T02:00:00.000Z');
  const RANGE = { from: '2026-03-01', to: '2026-03-07' };

  const get = (token: string, path: string, query: Record<string, string> = {}) =>
    request(server())
      .get(`/v1/portal/${path}`)
      .query({ ...RANGE, ...query })
      .set('Authorization', `Bearer ${token}`);

  it('matches the stored subtotal when every line carries a priced modifier', async () => {
    const t = await seedTenant();
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [
        {
          qty: 2.5,
          unitPriceC: 13300,
          modifiers: [
            { groupId: 'g1', modifierId: 'm1', name: 'Oat milk', priceDeltaC: 2500 },
            { groupId: 'g2', modifierId: 'm2', name: 'Extra shot', priceDeltaC: 1750 },
          ],
        },
        {
          qty: 1,
          unitPriceC: 9900,
          modifiers: [
            { groupId: 'g2', modifierId: 'm3', name: 'Decaf', priceDeltaC: 0 },
          ],
        },
      ],
    });

    const overview = await get(t.token, 'analytics/overview').expect(200);
    expect(overview.body.grossSalesC.value).toBe(sale.subtotal);

    // And the naive reading — which is what a missing lateral join produces.
    const naive = Math.round(2.5 * 13300) + 1 * 9900;
    expect(overview.body.grossSalesC.value).toBeGreaterThan(naive);
  });

  it('agrees between the overview, the heatmap and the trend for one range', async () => {
    const t = await seedTenant();
    const common = { branchId: t.branchId, terminalId: t.terminalId, createdAt: DURING };
    await seedSale(raw, {
      ...common,
      lines: [
        { qty: 1, unitPriceC: 25000, discount: { source: 'free', kind: 'percent', value: 10 } },
      ],
    });
    await seedSale(raw, { ...common, lines: [{ qty: 3, unitPriceC: 4999 }] });

    const [overview, heatmap, trend] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/sales/heatmap').expect(200),
      get(t.token, 'analytics/sales/trend', { granularity: 'day' }).expect(200),
    ]);

    const net = overview.body.netSalesC.value;
    const heatmapTotal = heatmap.body.reduce((n: number, d: any) => n + d.salesC, 0);
    const trendTotal = trend.body.reduce((n: number, b: any) => n + b.salesC, 0);

    expect(heatmapTotal).toBe(net);
    expect(trendTotal).toBe(net);
  });

  it('agrees between the tax summary and the overview on service charge', async () => {
    const t = await seedTenant({ serviceChargeRate: '0.10' });
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      orderType: 'dine_in',
      serviceChargeRate: 0.1,
      lines: [{ qty: 1, unitPriceC: 20000 }],
    });

    const [overview, tax] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/tax').expect(200),
    ]);

    expect(tax.body.totals.serviceChargeC).toBe(overview.body.serviceChargeC.value);
  });

  it('never reports a zero margin for an uncosted catalogue, on any report', async () => {
    const t = await seedTenant();
    await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 4, unitPriceC: 7500, costC: null }],
    });

    const [overview, trend, dashboard] = await Promise.all([
      get(t.token, 'analytics/overview').expect(200),
      get(t.token, 'analytics/sales/trend', { granularity: 'day' }).expect(200),
      request(server())
        .get('/v1/portal/dashboard')
        .set('Authorization', `Bearer ${t.token}`)
        .expect(200),
    ]);

    expect(overview.body.grossProfitC.value).toBeNull();
    expect(overview.body.marginPct.value).toBeNull();
    for (const bucket of trend.body) {
      expect(bucket.grossProfitC).toBeNull();
    }
    expect(dashboard.body.businesses[0].today.grossProfitC).toBeNull();
  });

  it('rounds a weight quantity per line, the way the engine does', async () => {
    const t = await seedTenant();
    // 1.335 kg at 99.99 — the engine rounds the line, not the total.
    const sale = await seedSale(raw, {
      branchId: t.branchId,
      terminalId: t.terminalId,
      createdAt: DURING,
      lines: [{ qty: 1.335, unitPriceC: 9999 }],
    });

    const overview = await get(t.token, 'analytics/overview').expect(200);
    expect(overview.body.grossSalesC.value).toBe(sale.subtotal);
  });
```

- [ ] **Step 4: Run the invariant spec**

```bash
npm run test:e2e -- portal-analytics-invariants
```

Expected: PASS. The first case fails if any revenue query dropped its modifier lateral; the last fails if SQL rounding and `halfUp` have diverged — check that the SQL rounds per line rather than summing then rounding.

- [ ] **Step 5: Run everything**

```bash
npm test
npm run test:e2e
npm run lint && npm run build
```

Expected: the whole unit suite and the whole e2e suite green, including every pre-existing spec. A failure in `pos-sales` or `portal-catalog` means Task 1's include change or a shared helper broke something — fix it before committing.

- [ ] **Step 6: Refresh the emitted OpenAPI document**

The repo publishes `openapi.json` with stable operation ids so the portal can generate a typed client.

```bash
npm run openapi:emit
git diff --stat openapi.json
```

Expected: the diff adds the new `GET` operations and nothing else. If unrelated operations changed, investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add test/portal-analytics-tenancy.e2e-spec.ts \
        test/portal-analytics-invariants.e2e-spec.ts \
        openapi.json
git commit -m "test(api): tenancy sweep and cross-report invariants for analytics"
```

- [ ] **Step 8: Report, do not push**

Summarise for the user: endpoints added, test counts, and that `sentry-pos-be` now has unpushed commits awaiting their own `git push`. **Never run `git push`.**

---

## Self-Review

Run against the spec after the plan was complete.

**1. Spec coverage.** §0 dashboard → Task 10. §1 overview → Task 7. §2 sales (heatmap, trend, patterns, breakdowns) → Task 8. §6 tax → Task 9. Shared mechanisms (scope resolver, raw-SQL guard, business-day, CSV, report audit) → Tasks 2–5. Catalog modifier-group read → Task 1. Sale seeding → Task 6. Tenancy, null-cost, business-day and modifier-revenue guarantees → Tasks 7, 8 and 11. §3, §4 and §5 are plan 2, as the spec says.

**2. Placeholders.** None: every step carries the code or the exact command it needs. The three e2e specs that say "reuse the bootstrap block from `portal-analytics-overview.e2e-spec.ts`" point at a file this plan writes in full, in Task 7, before any of them.

**3. Type consistency.** `ScopedBusiness` and `ResolvedScope` are defined in Task 4 and consumed unchanged by Tasks 5, 7, 8, 9 and 10. `runScoped`/`runScopedOne` keep one signature throughout. `CsvSection` from Task 3 is what every `*.csv.ts` returns. `centavosToPesos` is the only money formatter. `Kpi`/`NullableKpi`/`MarginKpi` are declared in Task 7 and used only there. Row interfaces (`SalesAggregateRow`, `LineAggregateRow`, `BucketRow`, `TaxRow`, `DashboardBranchRow`, …) each live beside their SQL builder and are imported by name.

**4. Gaps found and closed while reviewing.** Two, both folded in above: `resolveToday` needed the same-day-last-week comparison rather than the resolver's default "immediately preceding period", and `addDays` did not exist in Task 2 — Task 10 adds it with its own test rather than assuming it.

**One thing left deliberately undone:** the trend endpoint zero-fills nothing. Days are zero-filled in the heatmap because the calendar grid needs every cell; weeks and months are not, because generating an empty month series needs a calendar the portal already has. If plan 2 shows the portal wants it, it is a small change in `SalesReportService.trend`.
