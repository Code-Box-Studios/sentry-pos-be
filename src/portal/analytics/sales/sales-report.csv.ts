import { centavosToPesos, type CsvSection } from '../csv';
import type {
  BreakdownsReport,
  HeatmapDay,
  PatternsReport,
  TrendBucket,
} from './sales-report.service';

export function heatmapCsv(days: HeatmapDay[]): CsvSection[] {
  return [
    {
      title: 'Sales by day',
      columns: ['date', 'sales', 'transactions'],
      rows: days.map((d) => [
        d.date,
        centavosToPesos(d.salesC),
        d.transactions,
      ]),
    },
  ];
}

export function trendCsv(buckets: TrendBucket[]): CsvSection[] {
  return [
    {
      title: 'Sales trend',
      columns: ['bucket', 'sales', 'gross profit', 'transactions'],
      rows: buckets.map((b) => [
        b.bucket,
        centavosToPesos(b.salesC),
        centavosToPesos(b.grossProfitC),
        b.transactions,
      ]),
    },
  ];
}

export function patternsCsv(report: PatternsReport): CsvSection[] {
  return [
    {
      title: 'By hour of day',
      columns: ['hour', 'sales', 'transactions'],
      rows: report.hourOfDay.map((h) => [
        h.hour,
        centavosToPesos(h.salesC),
        h.transactions,
      ]),
    },
    {
      title: 'By day of week (0 = Sunday)',
      columns: ['day of week', 'sales', 'transactions'],
      rows: report.dayOfWeek.map((d) => [
        d.dayOfWeek,
        centavosToPesos(d.salesC),
        d.transactions,
      ]),
    },
  ];
}

export function breakdownsCsv(report: BreakdownsReport): CsvSection[] {
  return [
    {
      title: 'By payment method',
      columns: ['method', 'sales', 'transactions'],
      rows: report.byPaymentMethod.map((r) => [
        r.method,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By order type',
      columns: ['order type', 'sales', 'transactions'],
      rows: report.byOrderType.map((r) => [
        r.orderType,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
    {
      title: 'By branch',
      columns: ['branch', 'sales', 'transactions'],
      rows: report.byBranch.map((r) => [
        r.name,
        centavosToPesos(r.salesC),
        r.transactions,
      ]),
    },
  ];
}
