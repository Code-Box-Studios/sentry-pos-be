import { Prisma } from '@prisma/client';
import { MANILA_OFFSET_MINUTES } from '../scope/business-day';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import { LINE_COST_C, LINE_MONEY_JOINS, LINE_NET_C } from './line-money.sql';

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
  return Prisma.sql`((s.created_at + (${shift} * INTERVAL '1 minute'))::date)`;
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

/**
 * `date_trunc` on the business-day date. Postgres weeks start Monday, as §2
 * asks.
 *
 * Exported because §3's per-product trend and §4's profit-over-time bucket the
 * same way. Three reports quietly disagreeing about what a "week" is would be a
 * bug nobody could see.
 */
export function bucketExpr(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  if (granularity === 'day') return dayBucketExpr(business);
  return Prisma.sql`(date_trunc(${granularity}, ${dayBucketExpr(business)}::timestamp)::date)`;
}

export function trendSalesSql(
  business: ScopedBusiness,
  granularity: Granularity,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${bucketExpr(business, granularity)} AS bucket,
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
    SELECT ${bucketExpr(business, granularity)} AS bucket,
           COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
           COALESCE(SUM(${LINE_NET_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
             AS costed_revenue_c,
           COALESCE(SUM(${LINE_COST_C}) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
             AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    ${LINE_MONEY_JOINS}
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
    SELECT EXTRACT(HOUR FROM s.created_at + (${MANILA_OFFSET_MINUTES} * INTERVAL '1 minute'))::int AS hour,
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

export interface BranchSalesRow {
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
