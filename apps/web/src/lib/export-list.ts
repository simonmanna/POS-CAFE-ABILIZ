import { exportCSV } from './export-csv';
import { exportPDF } from './export-pdf';

/** One exported column: header text plus how to turn a row into a cell. */
export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
}

export type ExportFormat = 'csv' | 'pdf';

export interface ExportListOptions<T> {
  format: ExportFormat;
  /** File name without extension; the date and extension are appended. */
  basename: string;
  title: string;
  subtitle?: string;
  columns: ExportColumn<T>[];
  rows: T[];
  /** Optional totals row (PDF footer / last CSV row). */
  totals?: Array<string | number | null | undefined>;
}

const cell = (v: string | number | null | undefined) => (v == null ? '' : String(v));

export function exportList<T>({ format, basename, title, subtitle, columns, rows, totals }: ExportListOptions<T>) {
  const headers = columns.map((c) => c.header);
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))));
  const stamp = new Date().toISOString().slice(0, 10);
  const foot = totals ? [totals.map(cell)] : undefined;
  if (format === 'csv') {
    exportCSV(`${basename}-${stamp}.csv`, headers, foot ? [...body, ...foot] : body);
  } else {
    exportPDF(`${basename}-${stamp}.pdf`, title, headers, body, {
      subtitle,
      align: columns.map((c) => c.align),
      foot,
    });
  }
}

/**
 * Walk every page of a paginated endpoint and collect the rows, so an export
 * covers the whole filtered result rather than only the page on screen.
 * `maxRows` bounds the work for very large result sets.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ rows: T[]; totalPages: number }>,
  { pageSize = 100, maxRows = 10_000 }: { pageSize?: number; maxRows?: number } = {},
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetchPage(page, pageSize);
    rows.push(...res.rows);
    totalPages = res.totalPages;
    page += 1;
  } while (page <= totalPages && rows.length < maxRows);
  return { rows: rows.slice(0, maxRows), truncated: page <= totalPages || rows.length > maxRows };
}
