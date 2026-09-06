import { centavosToPesos, type CsvSection } from '../csv';
import type { TaxReport } from './tax-report.service';

export function taxCsv(report: TaxReport): CsvSection[] {
  const columns = [
    'business',
    'tax rate',
    'vatable sales',
    'VAT',
    'VAT-exempt sales',
    'SC/PWD discount',
    'service charge',
  ];
  return [
    {
      title: `Tax summary ${report.from} to ${report.to}`,
      columns,
      rows: [
        ...report.businesses.map((b): (string | number | null)[] => [
          b.name,
          b.taxRate,
          centavosToPesos(b.vatableSalesC),
          centavosToPesos(b.vatC),
          centavosToPesos(b.vatExemptSalesC),
          centavosToPesos(b.scPwdDiscountC),
          centavosToPesos(b.serviceChargeC),
        ]),
        [
          'All businesses',
          // No blended rate: it would be true of nothing.
          null,
          centavosToPesos(report.totals.vatableSalesC),
          centavosToPesos(report.totals.vatC),
          centavosToPesos(report.totals.vatExemptSalesC),
          centavosToPesos(report.totals.scPwdDiscountC),
          centavosToPesos(report.totals.serviceChargeC),
        ],
      ],
    },
  ];
}
