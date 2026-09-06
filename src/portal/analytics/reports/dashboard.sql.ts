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
 * Per-branch sales and profit for one window, with every in-scope branch present
 * even when it sold nothing — the dashboard lists branches, not just active
 * ones. The profit half joins `sale_items` through the same modifier lateral
 * every revenue query uses; `unit_price` alone would understate any line with a
 * priced modifier.
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
           COALESCE(SUM(ss.net_c), 0)::bigint            AS sales_c,
           COUNT(ss.id)::bigint                          AS transactions,
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
    SELECT ((s.created_at + (${shift} * INTERVAL '1 minute'))::date) AS bucket,
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
