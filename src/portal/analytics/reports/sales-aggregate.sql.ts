import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';
import { LINE_COST_C, LINE_MONEY_JOINS, LINE_NET_C } from './line-money.sql';

/**
 * The two aggregates every money report is built from.
 *
 * Both are scoped by `branch_id = ANY(...)` over ids the scope resolver read
 * through the tenancy choke point — raw SQL gets no scoping of its own
 * (`scoped-sql.ts` explains why).
 *
 * Status rules, applied identically everywhere: VOIDED sales contribute to no
 * money figure and to no transaction count; REFUNDED sales contribute to no
 * money figure but are counted. Conditional aggregates keep all three counts in
 * one pass over the same rows.
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
