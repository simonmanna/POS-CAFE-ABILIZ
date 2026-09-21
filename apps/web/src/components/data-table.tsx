import { type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  render?: (row: T) => ReactNode;
  /** Server-side sort field; makes the header clickable when `onSortChange` is set. */
  sortKey?: string;
}

export interface DataTableSort {
  by: string;
  order: 'asc' | 'desc';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: ReactNode;
  getRowId?: (row: T) => string;
  className?: string;
  compact?: boolean;
  cellClassName?: string;
  headerRowClassName?: string;
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  onRowClick?: (row: T) => void;
  loadingRows?: number;
}

function SortIcon({ active, order }: { active: boolean; order?: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
  return order === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />;
}

/** Reusable, presentational data table. Pagination/search live in the page. */
export function DataTable<T>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No records found.',
  getRowId,
  className = '',
  compact = false,
  cellClassName = '',
  headerRowClassName = '',
  sort,
  onSortChange,
  onRowClick,
  loadingRows = 6,
}: DataTableProps<T>) {
  // asc -> desc -> unsorted
  const nextSort = (key: string): DataTableSort | null => {
    if (sort?.by !== key) return { by: key, order: 'asc' };
    return sort.order === 'asc' ? { by: key, order: 'desc' } : null;
  };

  return (
    <div className={`rounded-md border ${className}`}>
      <Table>
        <TableHeader>
          <TableRow className={headerRowClassName}>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                className={compact ? `h-7 py-1.5 text-xs ${c.className ?? ''}` : c.className}
                aria-sort={sort && c.sortKey && sort.by === c.sortKey ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.sortKey && onSortChange ? (
                  <button
                    type="button"
                    onClick={() => onSortChange(nextSort(c.sortKey!))}
                    className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
                  >
                    {c.header}
                    <SortIcon active={sort?.by === c.sortKey} order={sort?.order} />
                  </button>
                ) : (
                  c.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }).map((_, i) => (
              <TableRow key={`s-${i}`}>
                {columns.map((c) => (
                   <TableCell key={c.key} className={compact ? 'p-1.5' : ''}>
                     <Skeleton className="h-3.5 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : data.length === 0 ? (
            <TableRow>
               <TableCell colSpan={columns.length} className={`${compact ? 'p-1.5' : 'h-24'} text-center text-muted-foreground`}>
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row, i) => (
              <TableRow
                key={getRowId ? getRowId(row) : i}
                onClick={
                  onRowClick
                    ? (e) => {
                        // Links, buttons and menus inside the row keep their own behaviour.
                        if ((e.target as HTMLElement).closest('a,button,input,[role="menuitem"]')) return;
                        onRowClick(row);
                      }
                    : undefined
                }
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {columns.map((c) => (
                   <TableCell key={c.key} className={`${compact ? 'p-1.5 text-sm leading-tight' : ''} ${c.className ?? ''} ${cellClassName}`}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
