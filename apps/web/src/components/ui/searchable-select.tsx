import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SearchableSelectOption {
  value: string;
  /** Primary line, e.g. the product name. */
  label: string;
  /** Optional muted prefix, e.g. the product code. */
  code?: string;
  /** Optional second line, e.g. on-hand or UOM. */
  hint?: string;
  /** Extra text matched by the search box but not displayed. */
  keywords?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /** Popover width; defaults to matching the trigger. */
  contentClassName?: string;
}

/**
 * Select with a type-ahead search box in the dropdown — for lists (products,
 * partners…) that are too long to scroll. Keyboard: ↑/↓ move, Enter picks,
 * Esc closes. The panel is portalled, so it never clips inside a dialog.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches found',
  disabled,
  className,
  contentClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.code ?? ''} ${o.label} ${o.hint ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Reset the search each time the panel opens, and start on the current pick.
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const pick = (option: SearchableSelectOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = filtered[activeIndex];
      if (option) pick(option);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate text-left', !selected && 'text-muted-foreground')}>
            {selected
              ? `${selected.code ? `${selected.code} — ` : ''}${selected.label}`
              : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className={cn('w-[var(--radix-popover-trigger-width)] min-w-[240px] p-0', contentClassName)}
        onOpenAutoFocus={(e) => {
          // Focus the search box, not the first option.
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b px-3 bg-popover">
          <Search className="h-4 w-4 shrink-0 opacity-50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div ref={listRef} className="max-h-64 overflow-y-auto p-1 bg-popover">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          )}
          {filtered.map((option, idx) => (
            <button
              key={option.value}
              type="button"
              data-active={idx === activeIndex}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => pick(option)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none disabled:pointer-events-none disabled:opacity-50 bg-popover',
                idx === activeIndex && 'bg-accent text-accent-foreground',
              )}
            >
              <Check className={cn('h-4 w-4 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {option.code && <span className="font-mono text-xs text-muted-foreground">{option.code} — </span>}
                  {option.label}
                </span>
                {option.hint && <span className="block truncate text-xs text-muted-foreground">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
