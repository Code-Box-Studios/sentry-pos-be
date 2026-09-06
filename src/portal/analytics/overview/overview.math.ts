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

/** Sales after every discount. Service charge is its own KPI, not part of this. */
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
