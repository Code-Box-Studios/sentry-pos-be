import type { Response } from 'express';
import { CsvSection, toCsv } from './csv';

/** The part of `AnalyticsQueryDto` this needs — kept narrow so tests are trivial. */
export interface ReportRange {
  from: string;
  to: string;
  format?: 'json' | 'csv';
}

/**
 * JSON by default; CSV when asked, built from the SAME object the JSON response
 * would have returned. One code path, so an export cannot drift from what the
 * portal shows.
 *
 * Used with `@Res({ passthrough: true })` so Nest still serialises the returned
 * value and the global exception filter still applies.
 */
export function renderReport<T>(
  res: Response,
  reportName: string,
  query: ReportRange,
  data: T,
  toSections: (data: T) => CsvSection[],
): T | string {
  if (query.format !== 'csv') return data;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${reportName}-${query.from}-${query.to}.csv"`,
  );
  return toCsv(toSections(data));
}
