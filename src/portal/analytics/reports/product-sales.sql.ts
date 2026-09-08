import { Prisma } from '@prisma/client';
import type { ScopedBusiness } from '../scope/analytics-scope.service';

/**
 * Per-product sold aggregates (analytics-spec §3), with the per-category rollup
 * and zero-sales anti-join that go with them.
 *
 * MISC LINES ARE EXCLUDED. An open-price line has `product_id IS NULL`; it is a
 * sale but not a product, and including it would put "Open item" at the top of a
 * catalogue report. It surfaces in §4's `miscLines` instead. The consequence is
 * deliberate: product revenue does NOT sum to net sales.
 *
 * Rows are keyed by (product_id, variant_id) because a variant is what actually
 * sells — a "Latte" total merging Small and Large answers no question worth
 * asking. Names come from `name_snapshot`, so a product archived since the sale
 * still reports under the name it sold as.
 *
 * Quantities cast to `float8`: `qty` is DECIMAL(10,3) and Prisma would otherwise
 * hand back a Decimal object. Three decimals are exact in float64 and these are
 * ranking/display figures. Money stays integer centavos and never touches a
 * float.
 */

/** Sum of the chosen modifiers' price deltas for a `sale_items` row. */
export const MODS_LATERAL = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM((m->>'priceDeltaC')::int), 0) AS mods_c
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(si.modifiers) = 'array'
           THEN si.modifiers ELSE '[]'::jsonb END
    ) AS m
  ) mods
`;

/**
 * Line net revenue. MUST follow `MODS_LATERAL` — `unit_price` is the base price
 * and the priced modifiers live in the jsonb (`sales.service.ts:507`), so
 * `qty * unit_price` alone understates every line that has one.
 */
export const LINE_NET_LATERAL = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT round(si.qty * (si.unit_price + mods.mods_c)) - si.discount AS net_c
  ) line
`;

/** Completed, live sale items for this business's branches and window. */
function soldInWindow(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    s.branch_id = ANY(${business.branchIds}::uuid[])
    AND s.deleted_at IS NULL
    AND si.deleted_at IS NULL
    AND s.status = 'completed'
    AND s.created_at >= ${business.fromUtc}
    AND s.created_at <  ${business.toUtc}
  `;
}

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
    ${MODS_LATERAL}
    ${LINE_NET_LATERAL}
    WHERE ${soldInWindow(business)}
      AND si.product_id IS NOT NULL
    GROUP BY si.product_id, si.variant_id
  `;
}

export interface CategorySalesRow {
  category_id: string;
  name: string;
  units: number;
  revenue_c: bigint;
  costed_lines: bigint;
  costed_revenue_c: bigint;
  costed_cost_c: bigint;
}

/**
 * Category rollup. Carries the costed split as well as units and revenue so §4
 * can compute category margin from the same query §3 uses for its rollup —
 * two queries disagreeing about a category's revenue would be invisible.
 */
export function categorySalesSql(business: ScopedBusiness): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id::text AS category_id,
      c.name     AS name,
      COALESCE(SUM(si.qty), 0)::float8 AS units,
      COALESCE(SUM(line.net_c), 0)::bigint AS revenue_c,
      COUNT(*) FILTER (WHERE si.cost_snapshot IS NOT NULL)::bigint AS costed_lines,
      COALESCE(SUM(line.net_c) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_revenue_c,
      COALESCE(SUM(round(si.qty * si.cost_snapshot)) FILTER (WHERE si.cost_snapshot IS NOT NULL), 0)::bigint
        AS costed_cost_c
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    JOIN categories c ON c.id = p.category_id
    ${MODS_LATERAL}
    ${LINE_NET_LATERAL}
    WHERE ${soldInWindow(business)}
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
 * The `branch_id` predicate lives in the NOT EXISTS subquery, which is both what
 * the `runScoped` tripwire looks for and where the scope genuinely belongs: the
 * outer list is this business's products, the inner check is "did it sell in
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
