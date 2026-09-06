/**
 * The one CSV writer every report export goes through, applied to the SAME
 * object the JSON response returns — so an export can never drift from what the
 * portal shows.
 *
 * RFC 4180: CRLF line endings, fields containing a comma, a double quote, CR or
 * LF are quoted, and embedded quotes are doubled. A leading BOM makes Excel open
 * the file as UTF-8 instead of guessing a local codepage.
 */

export interface CsvSection {
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
}

const BOM = '﻿';
const EOL = '\r\n';

/**
 * Money leaves the API as integer centavos, but a CSV goes to an accountant,
 * not a parser — so exports render pesos. `null` becomes an empty field: an
 * unknown cost is not a zero cost.
 */
export function centavosToPesos(c: number | null): string {
  if (c === null) return '';
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function escapeField(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sections: CsvSection[]): string {
  const lines: string[] = [];
  sections.forEach((section, index) => {
    if (index > 0) lines.push('');
    if (section.title !== undefined) lines.push(escapeField(section.title));
    lines.push(section.columns.map(escapeField).join(','));
    for (const row of section.rows) {
      lines.push(row.map(escapeField).join(','));
    }
  });
  return BOM + lines.join(EOL) + EOL;
}
