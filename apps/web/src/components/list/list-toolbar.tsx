import { type ReactNode } from 'react';
import { format, startOfMonth, subDays, startOfYear, endOfMonth, subMonths } from 'date-fns';
import { CalendarRange, ChevronDown, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** Card-like strip that holds the search box, filters and active-filter chips. */
export function ListToolbar({ children, chips }: { children: ReactNode; chips?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {chips}
    </div>
  );
}

export function SearchInput({
  value, onChange, placeholder = 'Search…', className,
}: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative min-w-[220px] flex-1 sm:max-w-sm', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="h-9 pl-9 pr-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Radix Select forbids an empty-string item value, so "All" uses a sentinel.
const ALL = '__all__';

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  value, onChange, options, allLabel, className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
  allLabel: string;
  className?: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger className={cn('h-9 w-[160px] bg-background', value && 'border-primary/60 bg-primary/5 font-medium', className)}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

function datePresets(): Array<{ label: string; from: string; to: string }> {
  const today = new Date();
  const lastMonth = subMonths(today, 1);
  return [
    { label: 'Today', from: ymd(today), to: ymd(today) },
    { label: 'Yesterday', from: ymd(subDays(today, 1)), to: ymd(subDays(today, 1)) },
    { label: 'Last 7 days', from: ymd(subDays(today, 6)), to: ymd(today) },
    { label: 'Last 30 days', from: ymd(subDays(today, 29)), to: ymd(today) },
    { label: 'This month', from: ymd(startOfMonth(today)), to: ymd(today) },
    { label: 'Last month', from: ymd(startOfMonth(lastMonth)), to: ymd(endOfMonth(lastMonth)) },
    { label: 'This year', from: ymd(startOfYear(today)), to: ymd(today) },
  ];
}

export function DateRangeFilter({
  from, to, onChange,
}: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const active = from || to;
  return (
    <div className={cn('flex items-center gap-1 rounded-md border bg-background px-1', active && 'border-primary/60 bg-primary/5')}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
            <CalendarRange className="h-3.5 w-3.5" /> Range <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {datePresets().map((p) => (
            <DropdownMenuItem key={p.label} onClick={() => onChange(p.from, p.to)}>{p.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        type="date"
        aria-label="From date"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange(e.target.value, to)}
        className="h-7 w-[124px] bg-transparent px-1 text-xs outline-none"
      />
      <span className="text-xs text-muted-foreground">→</span>
      <input
        type="date"
        aria-label="To date"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange(from, e.target.value)}
        className="h-7 w-[124px] bg-transparent px-1 text-xs outline-none"
      />
    </div>
  );
}

export interface ActiveChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function FilterChips({ chips, onClearAll }: { chips: ActiveChip[]; onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
      <span className="mr-1 text-xs text-muted-foreground">Filters:</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
        >
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label}`}
            onClick={c.onRemove}
            className="rounded-full p-0.5 hover:bg-primary/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}

/** Human-readable summary of the active filters, for export subtitles. */
export function describeFilters(chips: ActiveChip[]): string | undefined {
  return chips.length ? `Filters: ${chips.map((c) => c.label).join(' · ')}` : undefined;
}

export function dateRangeLabel(from: string, to: string): string {
  if (from && to) return from === to ? from : `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Until ${to}`;
}
