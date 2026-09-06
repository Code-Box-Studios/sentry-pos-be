import { centavosToPesos, type CsvSection } from '../csv';
import type { OverviewReport } from './overview.service';

type MoneyLike = {
  value: number | null;
  previous: number | null;
  changePct?: number | null;
};

/** One row per KPI, so the export reads like the cards on screen. */
export function overviewCsv(report: OverviewReport): CsvSection[] {
  const money = (label: string, kpi: MoneyLike): (string | number | null)[] => [
    label,
    centavosToPesos(kpi.value),
    centavosToPesos(kpi.previous),
    kpi.changePct ?? null,
  ];
  const count = (
    label: string,
    kpi: { value: number; previous: number; changePct: number | null },
  ): (string | number | null)[] => [
    label,
    kpi.value,
    kpi.previous,
    kpi.changePct,
  ];

  return [
    {
      title: `Overview ${report.from} to ${report.to}`,
      columns: ['metric', 'value', 'previous', 'change'],
      rows: [
        money('Gross sales', report.grossSalesC),
        money('Discounts', report.discountsC),
        money('Net sales', report.netSalesC),
        money('Service charge', report.serviceChargeC),
        count('Transactions', report.transactions),
        count('Voids', report.voidCount),
        count('Refunds', report.refundCount),
        money('Average basket', report.averageBasketC),
        money('Gross profit', report.grossProfitC),
        [
          'Margin',
          report.marginPct.value,
          report.marginPct.previous,
          report.marginPct.changePoints,
        ],
        money('Costed revenue', {
          value: report.costedRevenueC,
          previous: null,
        }),
        money('Uncosted revenue', {
          value: report.uncostedRevenueC,
          previous: null,
        }),
      ],
    },
  ];
}
