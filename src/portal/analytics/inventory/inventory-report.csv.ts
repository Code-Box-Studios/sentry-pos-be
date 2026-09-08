import { centavosToPesos, type CsvSection } from '../csv';
import type { Paginated } from '../../../common/types/pagination';
import type {
  Movement,
  OnHandReport,
  ShrinkageReport,
} from './inventory-report.service';

export function movementsCsv(page: Paginated<Movement>): CsvSection[] {
  return [
    {
      columns: [
        'Date',
        'Branch',
        'Product',
        'Variant',
        'Type',
        'Quantity',
        'Reason',
        'Unit cost',
        'Note',
        'Actor',
        'Action',
      ],
      rows: page.data.map((m) => [
        m.createdAt.toISOString(),
        m.branchName,
        m.productName,
        m.variantName,
        m.type,
        m.qtyDelta,
        m.reasonCategory,
        centavosToPesos(m.unitCostC),
        m.note,
        m.actor?.actorType ?? null,
        m.actor?.action ?? null,
      ]),
    },
  ];
}

export function shrinkageCsv(report: ShrinkageReport): CsvSection[] {
  return [
    {
      columns: ['Reason', 'Units', 'Value at cost', 'Uncosted units'],
      rows: report.rows.map((r) => [
        r.reasonCategory,
        r.units,
        centavosToPesos(r.valueC),
        r.uncostedUnits,
      ]),
    },
  ];
}

export function onHandCsv(report: OnHandReport): CsvSection[] {
  return [
    {
      columns: [
        'Branch',
        'Item',
        'Quantity',
        'Unit cost',
        'Value',
        'Low stock threshold',
        'Low',
        'Days of stock',
      ],
      rows: report.rows.map((r) => [
        r.branchName,
        r.name,
        r.qty,
        centavosToPesos(r.unitCostC),
        centavosToPesos(r.valueC),
        r.lowStockThreshold,
        r.isLow ? 'yes' : 'no',
        r.daysOfStock === null ? '' : r.daysOfStock.toFixed(1),
      ]),
    },
    {
      title: 'Totals',
      columns: ['Value', 'Items with no cost'],
      rows: [
        [centavosToPesos(report.totals.valueC), report.totals.uncostedItems],
      ],
    },
  ];
}
