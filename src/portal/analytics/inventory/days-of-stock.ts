import { halfUp } from '../../../common/totals/money';

/**
 * Stock-on-hand maths (analytics-spec §5). Pure — no Prisma, no Nest.
 *
 * Each function has one null case, and each null means UNKNOWN, never zero.
 * That distinction is the whole point: a zero valuation reads as worthless
 * stock, and a zero runway reads as "out today".
 */

/**
 * How many days the shelf lasts at the period's average rate:
 * `qty ÷ (unitsSold ÷ dayCount)`.
 *
 * Null when the product did not sell in the period — the runway is unbounded,
 * which is not a number a report can render — or when the period has no days.
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
export function valuationC(
  qty: number,
  unitCostC: number | null,
): number | null {
  if (unitCostC === null) return null;
  return halfUp(qty * unitCostC);
}

/**
 * At or below the threshold. A product with NO threshold is unmonitored, which
 * is a different state from low — treating it as low would fill the attention
 * list with noise on day one.
 */
export function isLow(qty: number, threshold: number | null): boolean {
  if (threshold === null) return false;
  return qty <= threshold;
}
