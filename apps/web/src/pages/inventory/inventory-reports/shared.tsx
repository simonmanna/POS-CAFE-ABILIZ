import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { exportCSV } from '@/lib/export-csv';
import { formatMoney } from '@/lib/format';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const qty = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

export const money = (v: number | string | null | undefined) => formatMoney(Number(v ?? 0));

export const MOVE_TYPES: { value: string; label: string; group: string }[] = [
  { value: 'receipt', label: 'Receipt', group: 'Received' },
  { value: 'return_in', label: 'Customer return', group: 'Received' },
  { value: 'production_output', label: 'Production output', group: 'Received' },
  { value: 'opening_balance', label: 'Opening balance', group: 'Received' },
  { value: 'issue', label: 'Issue / sale', group: 'Consumed' },
  { value: 'production_consume', label: 'Production consume', group: 'Consumed' },
  { value: 'adjustment_in', label: 'Adjustment in', group: 'Adjusted' },
  { value: 'adjustment_out', label: 'Adjustment out', group: 'Adjusted' },
  { value: 'transfer_in', label: 'Transfer in', group: 'Transferred' },
  { value: 'transfer_out', label: 'Transfer out', group: 'Transferred' },
  { value: 'waste', label: 'Waste', group: 'Lost' },
  { value: 'expiry_write_off', label: 'Expiry write-off', group: 'Lost' },
  { value: 'internal_use', label: 'Internal use', group: 'Lost' },
  { value: 'promo_sample', label: 'Promo / sample', group: 'Lost' },
  { value: 'return_to_supplier', label: 'Return to supplier', group: 'Returned' },
];
export const moveTypeLabel = (t: string) => MOVE_TYPES.find((m) => m.value === t)?.label ?? t;

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-600',
          tone === 'bad' && 'text-destructive',
          tone === 'warn' && 'text-amber-600',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{children}</div>;
}

// ---------------------------------------------------------------------------
// Sortable, paginated, exportable table
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null;
  /** CSV cell; defaults to the sort value. Return undefined to leave the column out of CSV. */
  csv?: (row: T) => string | number | null;
  footer?: ReactNode;
  className?: string;
  hidden?: boolean;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  exportName?: string;
  emptyText?: string;
  toolbar?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
}

const PAGE_SIZES = [25, 50, 100, 0];

export function DataTable<T>({
  rows, columns, rowKey, defaultSort, exportName, emptyText = 'No data for the selected filters.',
  toolbar, rowClassName, onRowClick,
}: DataTableProps<T>) {
  const cols = columns.filter((c) => !c.hidden);
  const [sort, setSort] = useState(defaultSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const sorted = useMemo(() => {
    const col = sort && cols.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const dir = sort!.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sort!(a);
      const vb = col.sort!(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort?.key, sort?.dir]);

  const totalPages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, totalPages);
  const visible = pageSize ? sorted.slice((current - 1) * pageSize, current * pageSize) : sorted;

  const toggleSort = (key: string) => {
    setPage(1);
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  };

  const doExport = () => {
    const exportCols = cols.filter((c) => c.csv !== undefined || c.sort !== undefined);
    exportCSV(
      `${exportName ?? 'report'}.csv`,
      exportCols.map((c) => c.header),
      sorted.map((r) => exportCols.map((c) => String((c.csv ?? c.sort)!(r) ?? ''))),
    );
  };

  const hasFooter = cols.some((c) => c.footer !== undefined);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{sorted.length.toLocaleString()} row(s)</span>
          {toolbar}
        </div>
        {exportName && (
          <Button variant="outline" size="sm" onClick={doExport} disabled={sorted.length === 0}>
            <Download className="mr-2 h-3 w-3" />Export CSV
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 font-medium',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                  )}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn('inline-flex items-center gap-1 hover:text-foreground', c.align === 'right' && 'flex-row-reverse')}
                    >
                      {c.header}
                      {sort?.key === c.key
                        ? sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-3 py-10 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            )}
            {visible.map((r) => (
              <tr
                key={rowKey(r)}
                className={cn('border-b hover:bg-muted/30', onRowClick && 'cursor-pointer', rowClassName?.(r))}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 py-2',
                      c.align === 'right' && 'text-right font-mono tabular-nums',
                      c.align === 'center' && 'text-center',
                      c.className,
                    )}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {hasFooter && sorted.length > 0 && (
            <tfoot>
              <tr className="border-t bg-muted/40 font-medium">
                {cols.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2', c.align === 'right' && 'text-right font-mono tabular-nums')}>
                    {c.footer}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {sorted.length > 25 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <label className="flex items-center gap-2">
            Rows per page
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
            </select>
          </label>
          {pageSize > 0 && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</Button>
              <span>Page {current} of {totalPages}</span>
              <Button size="sm" variant="outline" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReportState({ query, children }: { query: { isLoading: boolean; isError: boolean; error: unknown; data: unknown }; children: ReactNode }) {
  if (query.isLoading) {
    return <Card className="p-10 text-center text-sm text-muted-foreground">Loading report…</Card>;
  }
  if (query.isError) {
    const e = query.error as { response?: { status?: number; data?: { message?: string | string[] } }; message?: string };
    const msg = e?.response?.data?.message ?? e?.message ?? 'Unknown error';
    return (
      <Card className="p-6 text-sm text-destructive">
        Failed to load the report{e?.response?.status ? ` (HTTP ${e.response.status})` : ''}: {Array.isArray(msg) ? msg.join(', ') : msg}
      </Card>
    );
  }
  return query.data ? <>{children}</> : null;
}
