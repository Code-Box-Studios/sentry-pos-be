import { Prisma } from '@prisma/client';
import type { MovementType } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Inventory queries (analytics-spec §5): the movement ledger, shrinkage by
 * reason, and stock on hand.
 *
 * Quantities cast to `float8` — `qty_delta` and `qty` are DECIMAL(10,3), which
 * Prisma would otherwise return as Decimal objects. Money stays integer
 * centavos.
 */

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
 * The "who and why" §5 asks for comes from `audit_logs`, joined on the movement
 * id as `entity_id`. A LEFT JOIN LATERAL taking the earliest match: a movement
 * written by a path that does not audit reports a NULL actor rather than a
 * fabricated one.
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

export interface ShrinkageRow {
  reason_category: string;
  units: number;
  costed_rows: bigint;
  value_c: bigint;
  uncosted_units: number;
}

/**
 * Adjustment LOSSES only: `type = 'adjustment'` AND `qty_delta < 0`. A positive
 * adjustment is a correction upward, not shrinkage, and sales and receives are
 * not losses at all.
 *
 * Valued at the CURRENT cost of the thing that shrank — the variant's when the
 * movement names one, otherwise the product's (§5). Rows with no cost contribute
 * their units to `uncosted_units` and nothing to `value_c`: shrinkage of unknown
 * value is not shrinkage of zero value.
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
 * The `units_sold` lateral matches product AND variant with `IS NOT DISTINCT
 * FROM`, because a plain `=` never matches when both sides are NULL — which is
 * exactly the common case of a product with no variants.
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
