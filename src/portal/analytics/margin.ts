/**
 * The one place the costed/uncosted split turns into a profit and a margin.
 *
 * Extracted because §1, §2, §3, §4 and §5 all need it and all must agree. The
 * rule, from the spec: a null cost means UNKNOWN margin, never zero margin.
 *
 *  - No costed lines at all → both figures are null. There is nothing to say.
 *  - Costed lines exist → profit is over those lines only, and the caller
 *    reports `costedRevenueC` / `uncostedRevenueC` beside it so the reader can
 *    see what share of revenue the number covers.
 *  - Costed revenue of zero (a fully discounted costed line) → profit is
 *    knowable, margin is a division by zero, so margin alone is null.
 */
export interface Margin {
  grossProfitC: number | null;
  marginPct: number | null;
}

export function marginOf(
  costedLines: number,
  costedRevenueC: number,
  costedCostC: number,
): Margin {
  if (costedLines === 0) return { grossProfitC: null, marginPct: null };

  const grossProfitC = costedRevenueC - costedCostC;
  return {
    grossProfitC,
    marginPct:
      costedRevenueC === 0 ? null : (grossProfitC / costedRevenueC) * 100,
  };
}
