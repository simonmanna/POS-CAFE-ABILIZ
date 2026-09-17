import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useCashAccounts } from '@/features/accounting/api';
import { useMoneyActivity, type MoneyDirection } from '@/features/money/api';
import { MoneyActivityList } from '@/components/money/MoneyActivityList';
import { LoadError, MoneyAmount, MoneyPage, Pager, StatCard, addDays, useOrgToday } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Period presets, counted in the organisation's calendar (not the browser's, not UTC). */
const DATE_PRESETS: { key: string; label: string; range: (today: string) => { from?: string; to?: string } }[] = [
  { key: 'today', label: 'Today', range: (t) => ({ from: t, to: t }) },
  { key: '7d', label: 'Last 7 days', range: (t) => ({ from: addDays(t, -6), to: t }) },
  { key: '30d', label: 'Last 30 days', range: (t) => ({ from: addDays(t, -29), to: t }) },
  { key: 'month', label: 'This month', range: (t) => ({ from: `${t.slice(0, 8)}01`, to: t }) },
  { key: 'all', label: 'All time', range: () => ({}) },
];

const DIRECTIONS: { key: MoneyDirection | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'in', label: 'Money in' },
  { key: 'out', label: 'Money out' },
  { key: 'internal', label: 'Between accounts' },
  { key: 'adjustment', label: 'Adjustments' },
];

const chip = (active: boolean) => cn(
  'inline-flex min-h-[44px] shrink-0 items-center rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[36px] sm:text-xs',
  active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted',
);

const selectClass = 'min-h-[44px] w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-auto';

interface BranchOption { id: string; code: string; name: string }

export function MoneyActivityPage() {
  const [params, setParams] = useSearchParams();
  const today = useOrgToday();
  const preset = params.get('period') ?? (params.get('from') || params.get('to') ? 'custom' : '30d');
  const range = preset === 'custom'
    ? { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined }
    : (DATE_PRESETS.find((p) => p.key === preset) ?? DATE_PRESETS[2]).range(today);
  const categories = (params.get('categories') ?? '').split(',').filter(Boolean);
  const direction = (params.get('direction') ?? 'all') as MoneyDirection | 'all';
  const accountId = params.get('account') ?? '';
  const branchId = params.get('branch') ?? '';
  const search = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k); else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const { data, isLoading, isFetching, isError, refetch } = useMoneyActivity({
    ...range, categories, direction, accountId: accountId || undefined, branchId: branchId || undefined, search, page, pageSize: 25,
  });
  const { data: accounts = [] } = useCashAccounts();
  const { data: branchData } = useQuery<{ data: BranchOption[] }>({
    queryKey: ['branches-switch'],
    queryFn: async () => (await api.get('/branches', { params: { pageSize: 200 } })).data,
    staleTime: 5 * 60_000,
  });
  const branches = branchData?.data ?? [];
  const categoryOptions = data?.categoryOptions ?? [];
  const toggleCategory = (key: string) => {
    const set = new Set(categories);
    if (set.has(key)) set.delete(key); else set.add(key);
    update({ categories: [...set].join(',') || null });
  };
  const accountName = useMemo(() => (accounts as any[]).find((a) => a.id === accountId)?.name, [accounts, accountId]);
  const branchName = branches.find((b) => b.id === branchId)?.name;
  const periodLabel = preset === 'custom'
    ? `${range.from ?? '…'} – ${range.to ?? '…'}`
    : DATE_PRESETS.find((p) => p.key === preset)?.label ?? 'Last 30 days';
  // Filters tucked behind "Filters" on small screens; count shows what is applied there.
  const hiddenFilterCount = categories.length + (direction !== 'all' ? 1 : 0) + (preset !== '30d' ? 1 : 0);
  const hasFilters = hiddenFilterCount > 0 || !!accountId || !!branchId || !!search;
  const currency = data?.currencyCode ?? null;
  const totals = data?.totals ?? data?.pageTotals;

  return (
    <MoneyPage
      title="Money Activity"
      description="Every movement of money in your cash, bank and mobile-money accounts — what it was, where it went and why."
    >
      <section aria-label="Filters" className="space-y-3 rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              key={search}
              type="search"
              aria-label="Search activity"
              defaultValue={search}
              onKeyDown={(e) => { if (e.key === 'Enter') update({ q: (e.target as HTMLInputElement).value }); }}
              onBlur={(e) => { if (e.target.value !== search) update({ q: e.target.value }); }}
              placeholder="Search description, entry number or account…"
              className="min-h-[44px] pl-9"
            />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 lg:flex">
            <select aria-label="Account" className={selectClass} value={accountId} onChange={(e) => update({ account: e.target.value })}>
              <option value="">All accounts</option>
              {(accounts as any[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px] lg:hidden"
              aria-expanded={filtersOpen}
              aria-controls="activity-more-filters"
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden />
              Filters{hiddenFilterCount ? ` (${hiddenFilterCount})` : ''}
            </Button>
            {branches.length > 1 ? (
              <select aria-label="Branch" className={cn(selectClass, 'col-span-2')} value={branchId} onChange={(e) => update({ branch: e.target.value })}>
                <option value="">All branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : null}
          </div>
        </div>

        <div id="activity-more-filters" className={cn('space-y-3', !filtersOpen && 'hidden lg:block')}>
          <div role="group" aria-label="Period" className="space-y-2">
            <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              {DATE_PRESETS.map((p) => (
                <button key={p.key} type="button" className={chip(preset === p.key)} aria-pressed={preset === p.key} onClick={() => update({ period: p.key === '30d' ? null : p.key, from: null, to: null })}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center">
                From
                <input type="date" max={today} className="min-h-[44px] rounded-md border bg-background px-2 text-sm text-foreground sm:min-h-[36px] sm:text-xs" value={range.from ?? ''} onChange={(e) => update({ period: null, from: e.target.value, to: range.to ?? '' })} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center">
                To
                <input type="date" max={today} className="min-h-[44px] rounded-md border bg-background px-2 text-sm text-foreground sm:min-h-[36px] sm:text-xs" value={range.to ?? ''} onChange={(e) => update({ period: null, to: e.target.value, from: range.from ?? '' })} />
              </label>
            </div>
          </div>

          <div role="group" aria-label="Direction" className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
            {DIRECTIONS.map((d) => (
              <button key={d.key} type="button" className={chip(direction === d.key)} aria-pressed={direction === d.key} onClick={() => update({ direction: d.key === 'all' ? null : d.key })}>
                {d.label}
              </button>
            ))}
          </div>

          {categoryOptions.length ? (
            <div role="group" aria-label="Type of activity" className="flex flex-wrap gap-2">
              {categoryOptions.map((c) => (
                <button key={c.key} type="button" className={chip(categories.includes(c.key))} aria-pressed={categories.includes(c.key)} onClick={() => toggleCategory(c.key)}>
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {hasFilters ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
            <span>{periodLabel}</span>
            {accountName ? <span>Account: <strong className="font-medium text-foreground">{accountName}</strong></span> : null}
            {branchName ? <span>Branch: <strong className="font-medium text-foreground">{branchName}</strong></span> : null}
            {search ? <span>Search: <strong className="font-medium text-foreground">“{search}”</strong></span> : null}
            <Button variant="ghost" className="ml-auto min-h-[44px] sm:min-h-[36px]" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X className="mr-1 h-3.5 w-3.5" aria-hidden /> Clear filters
            </Button>
          </div>
        ) : null}
      </section>

      {totals && !isError ? (
        <section aria-label="Totals for the filtered activity" className="space-y-2">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard label="Money in" value={<MoneyAmount value={totals.externalIn} currency={currency} className="text-emerald-700 dark:text-emerald-400" />} />
            <StatCard label="Money out" value={<MoneyAmount value={totals.externalOut} currency={currency} className="text-rose-700 dark:text-rose-400" />} />
            <div className="col-span-2 lg:col-span-1">
              <StatCard label="Moved between accounts" value={<MoneyAmount value={totals.internalMoved} currency={currency} />} hint="Transfers do not change total money." />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {data?.totals
              ? <>Totals cover all {data.total} matching {data.total === 1 ? 'activity' : 'activities'}, not only this page. Reversed entries are left out.</>
              : <>Totals cover this page only.</>}
            {data?.timezone ? <> Dates follow {data.timezone} time.</> : null}
          </p>
        </section>
      ) : null}

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : isError ? (
        <LoadError message="Money activity could not be loaded. Check your connection and try again." onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <div className={cn('transition-opacity', isFetching && 'opacity-60')} aria-busy={isFetching}>
          <MoneyActivityList rows={data?.data ?? []} />
        </div>
      )}

      {data && data.totalPages > 1 && !isError ? (
        <Pager
          page={data.page}
          totalPages={data.totalPages}
          onChange={(p) => { update({ page: String(p) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          summary={`Page ${data.page} of ${data.totalPages} · ${data.total} activities`}
        />
      ) : null}
    </MoneyPage>
  );
}
