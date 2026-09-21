import { useState } from 'react';
import { Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportList, type ExportColumn, type ExportFormat } from '@/lib/export-list';
import { notify, apiMessage } from '@/lib/notify';

export interface ExportMenuProps<T> {
  basename: string;
  title: string;
  subtitle?: string;
  columns: ExportColumn<T>[];
  /** Rows currently on screen. */
  pageRows: T[];
  /** Fetch every row matching the current filters. */
  fetchAll: () => Promise<{ rows: T[]; truncated: boolean }>;
  total?: number;
  totals?: (rows: T[]) => Array<string | number | null | undefined>;
}

export function ExportMenu<T>({
  basename, title, subtitle, columns, pageRows, fetchAll, total, totals,
}: ExportMenuProps<T>) {
  const [busy, setBusy] = useState(false);

  const run = async (format: ExportFormat, scope: 'page' | 'all') => {
    const write = (rows: T[]) =>
      exportList({ format, basename, title, subtitle, columns, rows, totals: totals?.(rows) });
    if (scope === 'page') return write(pageRows);
    setBusy(true);
    try {
      const { rows, truncated } = await fetchAll();
      if (!rows.length) return notify.info('Nothing to export');
      write(rows);
      if (truncated) notify.warning(`Export capped at ${rows.length.toLocaleString()} rows`, 'Narrow the filters to export the rest.');
    } catch (e) {
      notify.error('Export failed', apiMessage(e, 'Could not load the rows to export.'));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || (!pageRows.length && !total);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          All matching{total != null ? ` (${total.toLocaleString()})` : ''}
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run('csv', 'all')}>
          <FileSpreadsheet className="mr-2 h-4 w-4 text-emerald-600" /> CSV (Excel)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run('pdf', 'all')}>
          <FileText className="mr-2 h-4 w-4 text-rose-600" /> PDF
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Current page ({pageRows.length})
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={!pageRows.length} onClick={() => run('csv', 'page')}>
          <FileSpreadsheet className="mr-2 h-4 w-4 text-emerald-600" /> CSV (Excel)
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!pageRows.length} onClick={() => run('pdf', 'page')}>
          <FileText className="mr-2 h-4 w-4 text-rose-600" /> PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
