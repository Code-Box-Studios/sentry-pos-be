import type { Response } from 'express';
import { CsvSection, toCsv } from './csv';
import { requestContext } from '../../common/context/request-context';
import {
  SENSITIVE_FIELD,
  withoutSensitiveFields,
} from '../../staff/manager-data.interceptor';

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
  const manager = requestContext.getStore()?.actor?.type === 'staff';
  if (query.format !== 'csv') {
    return manager ? (withoutSensitiveFields(data) as T) : data;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${reportName}-${query.from}-${query.to}.csv"`,
  );
  const sections = toSections(data);
  if (!manager) return toCsv(sections);
  return toCsv(
    sections.map((section) => {
      const keep = section.columns.flatMap((column, index) =>
        SENSITIVE_FIELD.test(column) ||
        (reportName.startsWith('inventory') && /^value$/i.test(column))
          ? []
          : [index],
      );
      return {
        ...section,
        columns: keep.map((index) => section.columns[index]),
        rows: section.rows.map((row) =>
          keep.map((index) => row[index] ?? null),
        ),
      };
    }),
  );
}
