import { centavosToPesos, type CsvSection } from '../csv';
import type {
  ProductTrendReport,
  SlowProductsReport,
  SoldRow,
  TopProductsReport,
} from './products-report.service';

const SOLD_COLUMNS = [
  'Product',
  'Units',
  'Revenue',
  'Gross profit',
  'Margin %',
];

/** Margins are fractions internally; a CSV reader expects a percentage. */
const asPercent = (fraction: number | null): string =>
  fraction === null ? '' : (fraction * 100).toFixed(1);

const soldRows = (rows: SoldRow[]) =>
  rows.map((r) => [
    r.name,
    r.units,
    centavosToPesos(r.revenueC),
    centavosToPesos(r.grossProfitC),
    asPercent(r.marginPct),
  ]);

export function topProductsCsv(report: TopProductsReport): CsvSection[] {
  return [
    { columns: SOLD_COLUMNS, rows: soldRows(report.rows) },
    {
      title: 'By category',
      columns: ['Category', 'Units', 'Revenue'],
      rows: report.categories.map((c) => [
        c.name,
        c.units,
        centavosToPesos(c.revenueC),
      ]),
    },
  ];
}

export function slowProductsCsv(report: SlowProductsReport): CsvSection[] {
  return [
    { columns: SOLD_COLUMNS, rows: soldRows(report.bottom) },
    {
      title: 'No sales in this period',
      columns: ['Product', 'Category'],
      rows: report.zeroSales.map((z) => [z.name, z.categoryName]),
    },
  ];
}

export function productTrendCsv(report: ProductTrendReport): CsvSection[] {
  return [
    {
      columns: ['Bucket', 'Units', 'Revenue', 'Gross profit', 'Margin %'],
      rows: report.buckets.map((b) => [
        b.bucket,
        b.units,
        centavosToPesos(b.revenueC),
        centavosToPesos(b.grossProfitC),
        asPercent(b.marginPct),
      ]),
    },
  ];
}
