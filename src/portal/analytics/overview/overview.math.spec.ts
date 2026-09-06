import {
  addRows,
  averageBasketC,
  emptyTotals,
  grossProfitC,
  marginPct,
  netSalesC,
  toKpi,
  toMarginKpi,
  toNullableKpi,
} from './overview.math';
import type {
  LineAggregateRow,
  SalesAggregateRow,
} from '../reports/sales-aggregate.sql';

const sales = (over: Partial<SalesAggregateRow> = {}): SalesAggregateRow => ({
  gross_sales_c: 0n,
  discounts_c: 0n,
  service_charge_c: 0n,
  transactions: 0n,
  void_count: 0n,
  refund_count: 0n,
  ...over,
});

const lines = (over: Partial<LineAggregateRow> = {}): LineAggregateRow => ({
  costed_lines: 0n,
  costed_revenue_c: 0n,
  costed_cost_c: 0n,
  uncosted_revenue_c: 0n,
  ...over,
});

describe('addRows', () => {
  it('sums across businesses, converting bigint to number', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({ gross_sales_c: 10000n, transactions: 2n }),
      lines(),
    );
    addRows(totals, sales({ gross_sales_c: 5000n, transactions: 1n }), lines());
    expect(totals.grossSalesC).toBe(15000);
    expect(totals.transactions).toBe(3);
  });
});

describe('netSalesC', () => {
  it('is gross sales less every discount, and excludes service charge', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({
        gross_sales_c: 100000n,
        discounts_c: 15000n,
        service_charge_c: 8000n,
      }),
      lines(),
    );
    expect(netSalesC(totals)).toBe(85000);
  });
});

describe('grossProfitC and marginPct — the null-cost rule', () => {
  it('is null, NOT zero, when nothing in the range carries a cost', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({ gross_sales_c: 50000n }),
      lines({ uncosted_revenue_c: 50000n }),
    );
    expect(grossProfitC(totals)).toBeNull();
    expect(marginPct(totals)).toBeNull();
  });

  it('counts only costed lines, and reports the uncosted revenue alongside', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales({ gross_sales_c: 50000n }),
      lines({
        costed_lines: 3n,
        costed_revenue_c: 30000n,
        costed_cost_c: 18000n,
        uncosted_revenue_c: 20000n,
      }),
    );
    expect(grossProfitC(totals)).toBe(12000);
    expect(marginPct(totals)).toBeCloseTo(0.4, 10);
    expect(totals.uncostedRevenueC).toBe(20000);
  });

  it('reports a loss as a negative profit rather than clamping at zero', () => {
    const totals = emptyTotals();
    addRows(
      totals,
      sales(),
      lines({
        costed_lines: 1n,
        costed_revenue_c: 1000n,
        costed_cost_c: 1500n,
      }),
    );
    expect(grossProfitC(totals)).toBe(-500);
  });
});

describe('averageBasketC', () => {
  it('is null when there were no transactions, never a divide by zero', () => {
    expect(averageBasketC(emptyTotals())).toBeNull();
  });

  it('rounds half-up to whole centavos', () => {
    const totals = emptyTotals();
    addRows(totals, sales({ gross_sales_c: 1001n, transactions: 2n }), lines());
    expect(averageBasketC(totals)).toBe(501);
  });
});

describe('toKpi', () => {
  it('reports change as a ratio of the previous period', () => {
    expect(toKpi(150, 100)).toEqual({
      value: 150,
      previous: 100,
      changePct: 0.5,
    });
  });

  it('leaves change null from a standing start, rather than claiming infinity', () => {
    expect(toKpi(150, 0)).toEqual({ value: 150, previous: 0, changePct: null });
  });
});

describe('toNullableKpi', () => {
  it('leaves change null when either side is unknown', () => {
    expect(toNullableKpi(null, 100).changePct).toBeNull();
    expect(toNullableKpi(150, null).changePct).toBeNull();
  });
});

describe('toMarginKpi', () => {
  it('reports the difference in percentage POINTS, not a percentage change', () => {
    const kpi = toMarginKpi(0.42, 0.4);
    expect(kpi.value).toBe(0.42);
    expect(kpi.previous).toBe(0.4);
    expect(kpi.changePoints).toBeCloseTo(0.02, 10);
  });

  it('leaves the difference null when either margin is unknown', () => {
    expect(toMarginKpi(null, 0.4).changePoints).toBeNull();
  });
});
