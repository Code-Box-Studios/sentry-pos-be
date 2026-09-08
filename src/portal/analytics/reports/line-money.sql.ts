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

/** Line cost. NULL when no cost was recorded — never coerced to zero. */
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
