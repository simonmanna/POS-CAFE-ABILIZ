import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, Filter, RotateCcw, Search, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { MOVE_TYPES } from './shared';

// ---------------------------------------------------------------------------
// Date presets — always LOCAL calendar days (the API interprets them the same way)
// ---------------------------------------------------------------------------

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_7', label: 'Last 7 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
] as const;

export function presetRange(preset: string): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const day = (offset: number) => iso(new Date(y, m, d + offset));
  switch (preset) {
    case 'today': return { start: day(0), end: day(0) };
    case 'yesterday': return { start: day(-1), end: day(-1) };
    case 'this_week': {
      const dow = (now.getDay() + 6) % 7; // Monday-based
      return { start: day(-dow), end: day(0) };
    }
    case 'last_7': return { start: day(-6), end: day(0) };
    case 'this_month': return { start: iso(new Date(y, m, 1)), end: day(0) };
    case 'last_month': return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) };
    case 'last_30': return { start: day(-29), end: day(0) };
    case 'last_90': return { start: day(-89), end: day(0) };
    case 'this_quarter': return { start: iso(new Date(y, Math.floor(m / 3) * 3, 1)), end: day(0) };
    case 'this_year': return { start: iso(new Date(y, 0, 1)), end: day(0) };
    default: return { start: '', end: '' };
  }
}

// ---------------------------------------------------------------------------
// URL-backed filter state (shareable links, survives refresh, per-tab)
// ---------------------------------------------------------------------------

export interface ReportFilters {
  tab: string;
  preset: string;
  start: string;
  end: string;
  locationId: string;
  categoryId: string;
  productId: string;
  search: string;
  moveTypes: string[];
  status: string;
  days: string;
  includeIdle: boolean;
  excludeTransfers: boolean;
  includeZero: boolean;
  detailed: boolean;
  staffId: string;
  source: string;
  reason: string;
  direction: string;
}

const DEFAULTS: Record<string, string> = { tab: 'movements', preset: 'this_month', status: 'all', days: '30' };

export function useReportFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? DEFAULTS[k] ?? '';
  const preset = get('preset');
  const range = preset === 'custom' ? { start: get('start'), end: get('end') } : presetRange(preset);

  const filters: ReportFilters = {
    tab: get('tab'),
    preset,
    start: range.start,
    end: range.end,
    locationId: get('locationId'),
    categoryId: get('categoryId'),
    productId: get('productId'),
    search: get('search'),
    moveTypes: get('moveTypes').split(',').filter(Boolean),
    status: get('status'),
    days: get('days'),
    includeIdle: get('includeIdle') === 'true',
    excludeTransfers: get('excludeTransfers') === 'true',
    includeZero: get('includeZero') === 'true',
    detailed: get('detailed') === 'true',
    staffId: get('staffId'),
    source: get('source'),
    reason: get('reason'),
    direction: get('direction'),
  };

  const set = (patch: Partial<Record<keyof ReportFilters, string | boolean | string[]>>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, raw] of Object.entries(patch)) {
        const v = Array.isArray(raw) ? raw.join(',') : typeof raw === 'boolean' ? (raw ? 'true' : '') : raw ?? '';
        if (!v || v === DEFAULTS[k]) next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  };

  const reset = () => setParams(filters.tab !== DEFAULTS.tab ? { tab: filters.tab } : {}, { replace: true });

  /** Query string for the API with the given keys. */
  const toQuery = (keys: (keyof ReportFilters)[]) => {
    const qs = new URLSearchParams();
    for (const k of keys) {
      const v = filters[k];
      if (Array.isArray(v)) { if (v.length) qs.set(k, v.join(',')); }
      else if (typeof v === 'boolean') { if (v) qs.set(k, 'true'); }
      else if (v) qs.set(k, v);
    }
    return qs.toString();
  };

  return { filters, set, reset, toQuery };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface Lookup { id: string; code?: string; name: string; parentId?: string | null }

const listOf = <T,>(d: unknown): T[] => (Array.isArray(d) ? d : ((d as { data?: T[] })?.data ?? []));

export function useLookups() {
  const locations = useQuery<Lookup[]>({
    queryKey: ['inventory-locations', 'report-lookup'],
    queryFn: async () => listOf<Lookup>((await api.get('/inventory/locations?pageSize=200')).data),
    staleTime: 5 * 60_000,
  });
  const categories = useQuery<Lookup[]>({
    queryKey: ['product-categories', 'report-lookup'],
    queryFn: async () => listOf<Lookup>((await api.get('/product-categories?pageSize=1000')).data),
    staleTime: 5 * 60_000,
  });
  const products = useQuery<Lookup[]>({
    queryKey: ['products', 'report-lookup'],
    queryFn: async () => listOf<Lookup>((await api.get('/products?pageSize=1000')).data),
    staleTime: 5 * 60_000,
  });
  return { locations, categories, products };
}

/** Indented category labels ("Drinks › Hot"). */
function categoryOptions(rows: Lookup[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = (c: Lookup): string => {
    const names: string[] = [];
    let cur: Lookup | undefined = c;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); names.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return names.join(' › ');
  };
  return rows.map((c) => ({ value: c.id, label: path(c) })).sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

export type FilterKey = 'date' | 'location' | 'category' | 'product' | 'search' | 'moveTypes' | 'status' | 'days' | 'idle' | 'transfers' | 'zero' | 'detailed';

export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function MoveTypePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const groups = [...new Set(MOVE_TYPES.map((t) => t.group))];
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  const toggleGroup = (g: string) => {
    const members = MOVE_TYPES.filter((t) => t.group === g).map((t) => t.value);
    const all = members.every((m) => value.includes(m));
    onChange(all ? value.filter((v) => !members.includes(v)) : [...new Set([...value, ...members])]);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 w-full justify-between font-normal">
          <span className={cn('truncate', !value.length && 'text-muted-foreground')}>
            {value.length ? `${value.length} type(s)` : 'All movement types'}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {groups.map((g) => (
            <div key={g}>
              <button type="button" className="mb-1 text-xs font-semibold uppercase text-muted-foreground hover:text-foreground" onClick={() => toggleGroup(g)}>
                {g}
              </button>
              {MOVE_TYPES.filter((t) => t.group === g).map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => toggle(t.value)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                >
                  <span className={cn('flex h-4 w-4 items-center justify-center rounded border', value.includes(t.value) && 'border-primary bg-primary text-primary-foreground')}>
                    {value.includes(t.value) && <Check className="h-3 w-3" />}
                  </span>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {value.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => onChange([])}>Clear selection</Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function FilterBar({ show, ctl, extra }: { show: FilterKey[]; ctl: ReturnType<typeof useReportFilters>; extra?: React.ReactNode }) {
  const { filters: f, set, reset } = ctl;
  const { locations, categories, products } = useLookups();
  const has = (k: FilterKey) => show.includes(k);

  // Debounced free-text search.
  const [searchDraft, setSearchDraft] = useState(f.search);
  useEffect(() => setSearchDraft(f.search), [f.search]);
  useEffect(() => {
    if (searchDraft === f.search) return;
    const t = setTimeout(() => set({ search: searchDraft }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const locationOpts = useMemo(
    () => [{ value: '', label: 'All locations' }, ...(locations.data ?? []).map((l) => ({ value: l.id, code: l.code, label: l.name }))],
    [locations.data],
  );
  const categoryOpts = useMemo(() => [{ value: '', label: 'All categories' }, ...categoryOptions(categories.data ?? [])], [categories.data]);
  const productOpts = useMemo(
    () => [{ value: '', label: 'All items' }, ...(products.data ?? []).map((p) => ({ value: p.id, code: p.code, label: p.name }))],
    [products.data],
  );

  const chips: { label: string; clear: () => void }[] = [];
  if (has('location') && f.locationId) chips.push({ label: `Location: ${locationOpts.find((o) => o.value === f.locationId)?.label ?? '…'}`, clear: () => set({ locationId: '' }) });
  if (has('category') && f.categoryId) chips.push({ label: `Category: ${categoryOpts.find((o) => o.value === f.categoryId)?.label ?? '…'}`, clear: () => set({ categoryId: '' }) });
  if (has('product') && f.productId) chips.push({ label: `Item: ${productOpts.find((o) => o.value === f.productId)?.label ?? '…'}`, clear: () => set({ productId: '' }) });
  if (has('search') && f.search) chips.push({ label: `Search: "${f.search}"`, clear: () => set({ search: '' }) });
  if (has('moveTypes') && f.moveTypes.length) chips.push({ label: `${f.moveTypes.length} movement type(s)`, clear: () => set({ moveTypes: [] }) });

  return (
    <Card className="space-y-3 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        {has('date') && (
          <>
            <Field label="Period">
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={f.preset}
                onChange={(e) => {
                  const p = e.target.value;
                  if (p === 'custom') set({ preset: p, start: f.start, end: f.end });
                  else set({ preset: p, start: '', end: '' });
                }}
              >
                {DATE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="From">
              <Input type="date" value={f.start} max={f.end || undefined} onChange={(e) => set({ preset: 'custom', start: e.target.value, end: f.end })} />
            </Field>
            <Field label="To">
              <Input type="date" value={f.end} min={f.start || undefined} onChange={(e) => set({ preset: 'custom', start: f.start, end: e.target.value })} />
            </Field>
          </>
        )}
        {has('location') && (
          <Field label="Location">
            <SearchableSelect value={f.locationId} onValueChange={(v) => set({ locationId: v })} options={locationOpts} placeholder="All locations" searchPlaceholder="Search locations…" />
          </Field>
        )}
        {has('category') && (
          <Field label="Category (incl. sub-categories)">
            <SearchableSelect value={f.categoryId} onValueChange={(v) => set({ categoryId: v })} options={categoryOpts} placeholder="All categories" searchPlaceholder="Search categories…" />
          </Field>
        )}
        {has('product') && (
          <Field label="Item">
            <SearchableSelect value={f.productId} onValueChange={(v) => set({ productId: v })} options={productOpts} placeholder="All items" searchPlaceholder="Search items…" />
          </Field>
        )}
        {has('search') && (
          <Field label="Search code / name / SKU / barcode">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" value={searchDraft} placeholder="Type to filter…" onChange={(e) => setSearchDraft(e.target.value)} />
            </div>
          </Field>
        )}
        {has('moveTypes') && (
          <Field label="Movement types">
            <MoveTypePicker value={f.moveTypes} onChange={(v) => set({ moveTypes: v })} />
          </Field>
        )}
        {has('status') && (
          <Field label="Stock status">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="all">All with stock</option>
              <option value="in_stock">In stock</option>
              <option value="low">Low stock</option>
              <option value="below_par">At / below par</option>
              <option value="out">Out of stock</option>
              <option value="negative">Negative stock</option>
            </select>
          </Field>
        )}
        {has('days') && (
          <Field label="Expiring within">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.days} onChange={(e) => set({ days: e.target.value })}>
              {['7', '14', '30', '60', '90', '180', '365'].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </Field>
        )}
        {extra}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {has('detailed') && <Toggle checked={f.detailed} onChange={(v) => set({ detailed: v })} label="Breakdown by movement group" />}
        {has('idle') && <Toggle checked={f.includeIdle} onChange={(v) => set({ includeIdle: v })} label="Include items with no stock / movement" />}
        {has('transfers') && <Toggle checked={f.excludeTransfers} onChange={(v) => set({ excludeTransfers: v })} label="Exclude internal transfers" />}
        {has('zero') && f.status === 'all' && <Toggle checked={f.includeZero} onChange={(v) => set({ includeZero: v })} label="Include zero-stock items" />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs">
              <Filter className="h-3 w-3" />{c.label}
              <button type="button" onClick={c.clear} aria-label={`Clear ${c.label}`} className="hover:text-destructive"><X className="h-3 w-3" /></button>
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={() => { setSearchDraft(''); reset(); }}>
            <RotateCcw className="mr-1 h-3 w-3" />Reset filters
          </Button>
        </div>
      </div>
    </Card>
  );
}
