import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react';
import { useCashAccounts } from '@/features/accounting/api';
import { useMoneyActivity, type MoneyDirection } from '@/features/money/api';
import { MoneyActivityList } from '@/components/money/MoneyActivityList';
import { MoneyAmount, MoneyPage, StatCard } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const DATE_PRESETS: { key: string; label: string; range: () => { from?: string; to?: string } }[] = [
  { key: 'today', label: 'Today', range: () => ({ from: ymd(new Date()), to: ymd(new Date()) }) },
  { key: '7d', label: 'Last 7 days', range: () => { const d = new Date(); d.setDate(d.getDate() - 6); return { from: ymd(d), to: ymd(new Date()) }; } },
  { key: '30d', label: 'Last 30 days', range: () => { const d = new Date(); d.setDate(d.getDate() - 29); return { from: ymd(d), to: ymd(new Date()) }; } },
  { key: 'month', label: 'This month', range: () => { const d = new Date(); return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d) }; } },
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
  'inline-flex min-h-[36px] items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted',
);

export function MoneyActivityPage() {
  const [params, setParams] = useSearchParams();
  const preset = params.get('period') ?? (params.get('from') || params.get('to') ? 'custom' : '30d');
  const range = preset === 'custom'
    ? { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined }
    : (DATE_PRESETS.find((p) => p.key === preset) ?? DATE_PRESETS[2]).range();
  const categories = (params.get('categories') ?? '').split(',').filter(Boolean);
  const direction = (params.get('direction') ?? 'all') as MoneyDirection | 'all';
  const accountId = params.get('account') ?? '';
  const search = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k); else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const { data, isLoading, isFetching, isError } = useMoneyActivity({
    ...range, categories, direction, accountId: accountId || undefined, search, page, pageSize: 25,
  });
  const { data: accounts = [] } = useCashAccounts();
  const categoryOptions = data?.categoryOptions ?? [];
  const toggleCategory = (key: string) => {
    const set = new Set(categories);
    if (set.has(key)) set.delete(key); else set.add(key);
    update({ categories: [...set].join(',') || null });
  };
  const hasFilters = categories.length > 0 || direction !== 'all' || !!accountId || !!search || preset !== '30d';
  const accountName = useMemo(() => (accounts as any[]).find((a) => a.id === accountId)?.name, [accounts, accountId]);

  return (
    <MoneyPage
      title="Money Activity"
      description="Every movement of money in your cash, bank and mobile-money accounts — what it was, where it went and why."
    >
      <section aria-label="Filters" className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              key={search}
              aria-label="Search activity"
              defaultValue={search}
              onKeyDown={(e) => { if (e.key === 'Enter') update({ q: (e.target as HTMLInputElement).value }); }}
              onBlur={(e) => { if (e.target.value !== search) update({ q: e.target.value }); }}
              placeholder="Search description, entry number or account…"
              className="pl-9"
            />
          </div>
          <select
            aria-label="Account"
            className="min-h-[40px] rounded-md border bg-background px-3 text-sm"
            value={accountId}
            onChange={(e) => update({ account: e.target.value })}
          >
            <option value="">All accounts</option>
            {(accounts as any[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
          {DATE_PRESETS.map((p) => (
            <button key={p.key} type="button" className={chip(preset === p.key)} aria-pressed={preset === p.key} onClick={() => update({ period: p.key === '30d' ? null : p.key, from: null, to: null })}>
              {p.label}
            </button>
          ))}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <label className="sr-only" htmlFor="activity-from">From</label>
            <input id="activity-from" type="date" className="min-h-[36px] rounded-md border bg-background px-2 text-xs" value={range.from ?? ''} onChange={(e) => update({ period: null, from: e.target.value, to: range.to ?? '' })} />
            –
            <label className="sr-only" htmlFor="activity-to">To</label>
            <input id="activity-to" type="date" className="min-h-[36px] rounded-md border bg-background px-2 text-xs" value={range.to ?? ''} onChange={(e) => update({ period: null, to: e.target.value, from: range.from ?? '' })} />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Direction">
          {DIRECTIONS.map((d) => (
            <button key={d.key} type="button" className={chip(direction === d.key)} aria-pressed={direction === d.key} onClick={() => update({ direction: d.key === 'all' ? null : d.key })}>
              {d.label}
            </button>
          ))}
        </div>

        {categoryOptions.length ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Type of activity">
            {categoryOptions.map((c) => (
              <button key={c.key} type="button" className={chip(categories.includes(c.key))} aria-pressed={categories.includes(c.key)} onClick={() => toggleCategory(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
        ) : null}

        {hasFilters ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {accountName ? <span>Account: <strong className="text-foreground">{accountName}</strong></span> : null}
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X className="mr-1 h-3.5 w-3.5" /> Clear filters
            </Button>
          </div>
        ) : null}
      </section>

      {data?.pageTotals ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Money in (this page)" value={<MoneyAmount value={data.pageTotals.externalIn} currency={data.currencyCode} className="text-emerald-700 dark:text-emerald-400" />} />
          <StatCard label="Money out (this page)" value={<MoneyAmount value={data.pageTotals.externalOut} currency={data.currencyCode} className="text-rose-700 dark:text-rose-400" />} />
          <StatCard label="Moved between accounts (this page)" value={<MoneyAmount value={data.pageTotals.internalMoved} currency={data.currencyCode} />} hint="Transfers do not change total money." />
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : isError ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">Money activity could not be loaded. Check your connection and try again.</p>
      ) : (
        <div className={cn('transition-opacity', isFetching && 'opacity-60')}>
          <MoneyActivityList rows={data?.data ?? []} />
        </div>
      )}

      {data && data.totalPages > 1 ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">Page {data.page} of {data.totalPages} · {data.total} activities</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => update({ page: String(page + 1) })}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
          </div>
        </div>
      ) : null}
    </MoneyPage>
  );
}
