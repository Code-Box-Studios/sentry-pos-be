import { centavosToPesos, type CsvSection } from '../csv';
import type { MarginFigures, ProfitReport } from './profit-report.service';
import type { LeaksReport } from './leaks-report.service';

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

const statusSection = (
  title: string,
  bucket: LeaksReport['voids'],
): CsvSection => ({
  title,
  columns: ['Reason', 'Count', 'Value'],
  rows: bucket.reasons.map((r) => [
    r.reason,
    r.count,
    centavosToPesos(r.valueC),
  ]),
});

export function leaksCsv(report: LeaksReport): CsvSection[] {
  return [
    {
      title: 'Discounts by name',
      columns: ['Name', 'Kind', 'Times used', 'Amount'],
      rows: report.discountsByName.map((d) => [
        d.name,
        d.kind,
        d.timesUsed,
        centavosToPesos(d.amountC),
      ]),
    },
    {
      title: 'Summary',
      columns: ['Measure', 'Value'],
      rows: [
        ['Order-level discount', centavosToPesos(report.orderLevelDiscountC)],
        ['SC/PWD discount', centavosToPesos(report.scPwd.discountC)],
        ['VAT-exempt sales', centavosToPesos(report.scPwd.vatExemptSalesC)],
        ['SC/PWD sales', report.scPwd.saleCount],
        ['Misc revenue', centavosToPesos(report.miscLines.revenueC)],
        ['Misc % of net sales', asPercent(report.miscLines.pctOfNetSales)],
      ],
    },
    statusSection('Voids', report.voids),
    statusSection('Refunds', report.refunds),
    {
      title: 'Over / short',
      columns: ['Branch', 'Closed at', 'Expected', 'Counted', 'Variance'],
      rows: report.overShort.map((o) => [
        o.branchName,
        o.closedAt.toISOString(),
        centavosToPesos(o.expectedCashC),
        centavosToPesos(o.closingCashC),
        centavosToPesos(o.varianceC),
      ]),
    },
  ];
}
