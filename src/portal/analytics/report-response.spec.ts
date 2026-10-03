import type { Response } from 'express';
import { renderReport } from './report-response';
import {
  requestContext,
  RequestContext,
} from '../../common/context/request-context';

function fakeRes() {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

const query = { from: '2026-03-01', to: '2026-03-07' };
const data = { totalC: 12345 };
const sections = (d: typeof data) => [
  { columns: ['total'], rows: [[d.totalC]] },
];

describe('renderReport', () => {
  it('does not leak unit costs through inventory values or CSV totals to managers', () => {
    const context = { actor: { type: 'staff', id: 'u-1' } } as RequestContext;
    const report = {
      rows: [{ qty: 2, valueC: 8600 }],
      totals: { valueC: 8600 },
    };
    const toSections = () => [
      { columns: ['Quantity', 'Value'], rows: [[2, 8600]] },
    ];
    requestContext.run(context, () => {
      const { res } = fakeRes();
      expect(
        renderReport(res, 'inventory-on-hand', query, report, toSections),
      ).toEqual({ rows: [{ qty: 2 }], totals: {} });
      const csv = renderReport(
        res,
        'inventory-on-hand',
        { ...query, format: 'csv' },
        report,
        toSections,
      );
      expect(csv).toContain('Quantity');
      expect(csv).not.toContain('8600');
      expect(csv).not.toContain('Value');
    });
  });
  it('omits cost and margin columns in manager JSON and CSV exports', () => {
    const context = { actor: { type: 'staff', id: 'u-1' } } as RequestContext;
    const report = { salesC: 10000, costC: 4300, grossMarginC: 5700 };
    const toSections = (value: typeof report) => [
      {
        columns: ['Sales', 'Cost', 'Gross margin'],
        rows: [[value.salesC, value.costC, value.grossMarginC]],
      },
    ];
    requestContext.run(context, () => {
      const { res } = fakeRes();
      expect(renderReport(res, 'sales', query, report, toSections)).toEqual({
        salesC: 10000,
      });
      const csv = renderReport(
        res,
        'sales',
        { ...query, format: 'csv' },
        report,
        toSections,
      );
      expect(csv).toContain('Sales');
      expect(csv).not.toContain('Cost');
      expect(csv).not.toContain('margin');
      expect(csv).not.toContain('4300');
      expect(csv).not.toContain('5700');
    });
  });

  it('returns the data untouched for JSON, setting no headers', () => {
    const { res, setHeader } = fakeRes();
    expect(renderReport(res, 'overview', query, data, sections)).toBe(data);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('renders CSV and names the file after the report and its range', () => {
    const { res, setHeader } = fakeRes();
    const out = renderReport(
      res,
      'overview',
      { ...query, format: 'csv' as const },
      data,
      sections,
    );
    expect(typeof out).toBe('string');
    expect(out).toContain('12345');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/csv; charset=utf-8',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="overview-2026-03-01-2026-03-07.csv"',
    );
  });
});
