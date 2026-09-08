import { centavosToPesos, type CsvSection } from '../csv';
import type { MarginFigures, ProfitReport } from './profit-report.service';

/** Margins are fractions internally; a CSV reader expects a percentage. */
const asPercent = (fraction: number | null): string =>
  fraction === null ? '' : (fraction * 100).toFixed(1);

const marginCells = (m: MarginFigures) => [
  centavosToPesos(m.revenueC),
  centavosToPesos(m.costC),
  centavosToPesos(m.grossProfitC),
  asPercent(m.marginPct),
];

const MARGIN_COLUMNS = ['Revenue', 'Cost', 'Gross profit', 'Margin %'];

export function profitCsv(report: ProfitReport): CsvSection[] {
  return [
    {
      title: 'Over time',
      columns: ['Bucket', 'Gross profit', 'Margin %'],
      rows: report.overTime.map((b) => [
        b.bucket,
        centavosToPesos(b.grossProfitC),
        asPercent(b.marginPct),
      ]),
    },
    {
      title: 'By product',
      columns: ['Product', ...MARGIN_COLUMNS],
      rows: report.byProduct.map((p) => [p.name, ...marginCells(p)]),
    },
    {
      title: 'By category',
      columns: ['Category', ...MARGIN_COLUMNS],
      rows: report.byCategory.map((c) => [c.name, ...marginCells(c)]),
    },
    {
      title: 'Profit coverage',
      columns: ['Costed revenue', 'Uncosted revenue'],
      rows: [
        [
          centavosToPesos(report.costedRevenueC),
          centavosToPesos(report.uncostedRevenueC),
        ],
      ],
    },
  ];
}
