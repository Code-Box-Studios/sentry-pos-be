import type { Response } from 'express';
import { renderReport } from './report-response';

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
