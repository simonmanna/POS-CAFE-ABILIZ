/**
 * The one table every POS report tab renders through.
 *
 * Each tab used to hand-roll its markup, its CSV builder and its PDF builder
 * separately, so a column could show one thing on screen and export another (and
 * several footers summed different columns than the ones above them). Declaring
 * columns once means the screen, the CSV and the PDF are the same report by
 * construction, and sorting comes for free on every tab.
 */
import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { exportCSV } from '@/lib/export-csv';
import { exportPDF } from '@/lib/export-pdf';
import { useTableSort } from './report-utils';

export interface ReportColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => string | number | null | undefined;
  cell: (row: T) => React.ReactNode;
  /** Plain text for CSV. Omit for UI-only columns (action buttons). */
  text?: (row: T) => string;
  /** Formatted text for PDF; falls back to `text`. */
  pdf?: (row: T) => string;
  /** Footer cell — rendered in the totals row. */
  footer?: (rows: T[]) => React.ReactNode;
  className?: string;
}

interface Props<T> {
  title: string;
  rows: T[];
  columns: Array<ReportColumn<T>>;
  /** Base filename for exports (no extension). */
  exportName: string;
  /** PDF document title; defaults to `title`. */
  exportTitle?: string;
  loading?: boolean;
  emptyMessage?: string;
  rowKey?: (row: T, index: number) => string;
  initialSortKey?: string;
  initialSortDir?: 'asc' | 'desc';
  /** Rendered above the table (summary cards, notes). */
  children?: React.ReactNode;
  /** Explanatory line under the heading — what the numbers mean. */
  note?: React.ReactNode;
}

export function ReportTable<T>({
  title,
  rows,
  columns,
  exportName,
  exportTitle,
  loading,
  emptyMessage = 'No data for these filters.',
  rowKey,
  initialSortKey,
  initialSortDir = 'desc',
  children,
  note,
}: Props<T>) {
  const accessors = React.useMemo(() => {
    const map: Record<string, (row: T) => string | number | null | undefined> = {};
    for (const c of columns) if (c.sort) map[c.key] = c.sort;
    return map;
  }, [columns]);

  const { sorted, sortKey, dir, toggle } = useTableSort(rows, accessors, initialSortKey, initialSortDir);

  // Exports follow the SORTED, filtered view — what the user is looking at is
  // what lands in the file.
  const exportable = columns.filter((c) => c.text);
  const headers = exportable.map((c) => c.header);
  const handleCSV = () => exportCSV(`${exportName}.csv`, headers, sorted.map((r) => exportable.map((c) => c.text!(r))));
  const handlePDF = () =>
    exportPDF(`${exportName}.pdf`, exportTitle ?? title, headers, sorted.map((r) => exportable.map((c) => (c.pdf ?? c.text!)(r))));

  const hasFooter = columns.some((c) => c.footer);
  const alignClass = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : '');

  return (
    <div className="pos-report-card">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <h3>{title}</h3>
          {note ? <p className="text-sm text-slate-500 mt-0.5">{note}</p> : null}
        </div>
        {rows.length > 0 && (
          <div className="flex gap-1 no-print">
            <Button variant="outline" size="sm" onClick={handleCSV}><Download className="h-3.5 w-3.5 mr-1" /> CSV</Button>
            <Button variant="outline" size="sm" onClick={handlePDF}><FileText className="h-3.5 w-3.5 mr-1" /> PDF</Button>
          </div>
        )}
      </div>

      {children}

      {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {rows.length === 0 && !loading ? (
        <p className="text-sm text-slate-500">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200 text-slate-600">
                {columns.map((c) => (
                  <th key={c.key} className={`py-2 pr-3 ${alignClass(c.align)} ${c.className ?? ''}`}>
                    {c.sort ? (
                      <button
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                        onClick={() => toggle(c.key)}
                        title={`Sort by ${c.header}`}
                      >
                        {c.header}
                        {sortKey === c.key ? (
                          dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={rowKey ? rowKey(r, i) : i} className="border-b border-slate-100">
                  {columns.map((c) => (
                    <td key={c.key} className={`py-2 pr-3 ${alignClass(c.align)} ${c.className ?? ''}`}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {hasFooter && (
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-bold text-slate-800">
                  {columns.map((c) => (
                    <td key={c.key} className={`py-2 pr-3 ${alignClass(c.align)}`}>
                      {c.footer ? c.footer(sorted) : null}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

export default ReportTable;
