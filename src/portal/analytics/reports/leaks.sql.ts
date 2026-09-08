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
 * the order-level amount is `sales.discount` minus that. It has to be derived
 * because the engine never writes it down separately; attributing all of
 * `sales.discount` to the order would double-count every line promo.
 */

/** Completed, live sales for this business's branches and window. */
function completedSales(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND s.status = 'completed'
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
  `;
}

/** Per-sale sum of its line discounts, for the order-level derivation. */
const LINE_DISCOUNTS_LATERAL = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(li.discount), 0) AS line_discounts
    FROM sale_items li
    WHERE li.sale_id = s.id AND li.deleted_at IS NULL
  ) ld
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
      COALESCE(SUM(s.discount), 0)::bigint         AS sale_discount_c,
      COALESCE(SUM(ld.line_discounts), 0)::bigint  AS line_discount_c,
      COALESCE(SUM(s.sc_pwd_discount), 0)::bigint  AS sc_pwd_discount_c,
      COALESCE(SUM(s.vat_exempt_sales), 0)::bigint AS vat_exempt_sales_c,
      COUNT(*) FILTER (WHERE s.sc_pwd IS NOT NULL)::bigint AS sc_pwd_sales,
      COALESCE(SUM(s.subtotal - s.discount - s.sc_pwd_discount), 0)::bigint AS net_sales_c
    FROM sales s
    ${LINE_DISCOUNTS_LATERAL}
    WHERE ${completedSales(business)}
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
    WHERE ${completedSales(business)}
      AND si.deleted_at IS NULL
    GROUP BY 1, 2, 3
  `;
}

/** Named discounts applied at ORDER level, using the derived remainder. */
export function orderDiscountsSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT d.id::text AS discount_id, d.name AS name, d.kind::text AS kind,
           COUNT(*)::bigint AS times_used,
           COALESCE(SUM(s.discount - (ld.line_discounts - s.sc_pwd_discount)), 0)::bigint
             AS amount_c
    FROM sales s
    JOIN discounts d ON d.id = s.discount_id
    ${LINE_DISCOUNTS_LATERAL}
    WHERE ${completedSales(business)}
    GROUP BY 1, 2, 3
  `;
}

export interface MiscLinesRow {
  revenue_c: bigint;
}

/** Open-price lines — `product_id IS NULL` is what makes a line "misc". */
export function miscLinesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(SUM(${LINE_NET_C}), 0)::bigint AS revenue_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
    WHERE ${completedSales(business)}
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
 * Voided and refunded sales with their reasons. This is the ONE report where
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
 * was counted in, so one opened on the 6th and closed on the 7th is the 7th's
 * variance.
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
