import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Banknote, ChevronDown, Info, Loader2, RefreshCw,
} from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMoneyOverview } from '@/features/money/api';
import { usePosPaymentMethodConfig } from '@/features/accounting/api';
import { MoneyActivityList } from '@/components/money/MoneyActivityList';
import { MoneyOperationDialog, type MoneyOperationMode } from '@/components/money/MoneyOperationDialog';
import { AccountTypeIcon, LoadError, MoneyAmount, MoneyPage, StatCard } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const FLOW_KEY = 'money-overview:flow-open';

function HowMoneyFlows({ bankName }: { bankName: string }) {
  const { data: methods = [], isLoading } = usePosPaymentMethodConfig();
  const [open, setOpen] = useState(() => {
    try { return window.localStorage.getItem(FLOW_KEY) !== '0'; } catch { return true; }
  });
  const toggle = () => {
    setOpen((v) => { try { window.localStorage.setItem(FLOW_KEY, v ? '0' : '1'); } catch { /* ignore */ } return !v; });
  };

  // One row per receiving account; methods sharing an account are listed together.
  const active = methods.filter((m) => m.isActive && m.kind !== 'store_credit');
  const rows = new Map<string, { labels: string[]; to: string; then: string; connected: boolean }>();
  for (const m of active) {
    if (m.kind === 'cash') {
      const r = rows.get('cash') ?? { labels: [], to: 'Drawer of the register taking the sale', then: `Counted at shift close, then banked to ${bankName}`, connected: true };
      r.labels.push(m.label);
      rows.set('cash', r);
      continue;
    }
    const key = m.accountId ?? `unmapped:${m.id}`;
    const r = rows.get(key) ?? {
      labels: [],
      to: m.accountName ?? 'Not connected to an account',
      then: m.kind === 'bank' ? 'Already in the bank' : `Settled to ${bankName} (fees recorded)`,
      connected: !!m.accountId,
    };
    r.labels.push(m.label);
    rows.set(key, r);
  }
  if (!rows.has('cash')) rows.set('cash', { labels: ['Cash'], to: 'Drawer of the register taking the sale', then: `Counted at shift close, then banked to ${bankName}`, connected: true });

  return (
    <section className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          <span className="block font-semibold text-foreground">How money flows here</span>
          <span className="block text-xs text-muted-foreground">What happens to a customer’s payment after the cashier charges it.</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div className="border-t px-4 py-3">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : (
            <ol className="space-y-2">
              {[...rows.values()].map((r, i) => (
                <li key={i} className="grid items-center gap-2 text-sm md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)_auto_minmax(0,1.2fr)]">
                  <span className="font-medium text-foreground">Customer pays with {r.labels.join(' / ')}</span>
                  <ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" aria-hidden />
                  <span className={cn(!r.connected && 'font-medium text-destructive')}>
                    <span className="text-muted-foreground md:hidden">→ </span>{r.to}
                  </span>
                  <ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" aria-hidden />
                  <span className="text-muted-foreground"><span className="md:hidden">→ </span>{r.then}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            These links are set in <Link to="/settings/payment-methods" className="font-medium text-primary hover:underline">Settings → Payment methods</Link>.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function MoneyOverviewPage() {
  const navigate = useNavigate();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canMove = hasPermission(PERMISSIONS.treasury.transfer);
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useMoneyOverview();
  const [op, setOp] = useState<MoneyOperationMode | null>(null);
  const currency = data?.baseCurrency ?? null;

  const actions = canMove ? (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
      <Button variant="outline" className="min-h-[44px]" onClick={() => setOp('in')}><ArrowDownLeft className="mr-2 h-4 w-4" aria-hidden /> <span className="sm:hidden">Money in</span><span className="hidden sm:inline">Record other money in</span></Button>
      <Button variant="outline" className="min-h-[44px]" onClick={() => setOp('out')}><ArrowUpRight className="mr-2 h-4 w-4" aria-hidden /> <span className="sm:hidden">Money out</span><span className="hidden sm:inline">Record other money out</span></Button>
      <Button className="col-span-2 min-h-[44px]" onClick={() => setOp('transfer')}><ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden /> Transfer between accounts</Button>
    </div>
  ) : null;

  const bank = data?.byType.find((t) => t.key === 'bank');
  // Money accounts are organisation-wide; say so plainly for multi-branch businesses.
  const branchCount = useQuery<{ data: { id: string }[] }>({
    queryKey: ['branches-switch'],
    queryFn: async () => (await api.get('/branches', { params: { pageSize: 200 } })).data,
    staleTime: 5 * 60_000,
  }).data?.data.length ?? 0;
  const todayLabel = data?.todayDate
    ? new Date(`${data.todayDate}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : null;

  return (
    <MoneyPage title="Money & Accounts" description="See where your money is, what changed today, and what needs attention." actions={actions}>
      {isLoading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : isError || !data ? (
        <LoadError message="The overview could not be loaded." onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <>
          {/* Where is the money now? */}
          <section aria-labelledby="money-now" className="space-y-3">
            <div className="rounded-xl border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="money-now" className="text-sm font-medium text-muted-foreground">
                    Total money on the books{currency ? ` in ${currency}` : ''}
                  </h2>
                  <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-foreground sm:text-4xl">
                    <MoneyAmount value={data.totalAvailableBookBalance} currency={currency} />
                  </p>
                  <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                    What the books record across your cash, bank and mobile-money accounts — not all of it is ready to spend. Drawer cash is expected until counted at shift close, and card or mobile-money takings wait for the provider to settle.
                    {branchCount > 1 ? <> Covers <strong className="font-medium text-foreground">all branches</strong>.</> : null}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
                  Updated {new Date(dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </button>
              </div>
              {data.foreignCurrencyAccounts.length ? (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  Not included (different currency): {data.foreignCurrencyAccounts.map((a) => `${a.name} (${a.currencyId})`).join(', ')}.
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {data.byType.map((t) => (
                <StatCard
                  key={t.key}
                  label={t.label}
                  value={<MoneyAmount value={t.balance} currency={currency} />}
                  hint={t.key === 'drawers' ? 'Expected, not yet counted' : `${t.accountCount} account${t.accountCount === 1 ? '' : 's'}`}
                  onClick={() => navigate(t.key === 'drawers' ? '/pos/cash-registers' : `/accounts/cash-accounts/accounts?type=${t.key}`)}
                >
                  <AccountTypeIcon type={t.key} className="mt-1 h-7 w-7" />
                </StatCard>
              ))}
              {Number(data.cashAwaitingBanking) > 0 ? (
                <StatCard
                  label="Cash awaiting banking"
                  value={<MoneyAmount value={data.cashAwaitingBanking} currency={currency} />}
                  hint="In drawers of closed shifts (part of Register drawers)"
                  icon={Banknote}
                  onClick={() => navigate('/pos/cash-registers?tab=history')}
                />
              ) : null}
            </div>
          </section>

          {/* What needs attention? */}
          <section aria-labelledby="money-attention" className="space-y-2">
            <h2 id="money-attention" className="text-base font-semibold text-foreground">Needs attention</h2>
            {data.attention.length === 0 ? (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Nothing needs attention right now.</p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card">
                {data.attention.map((a, i) => (
                  <li key={`${a.kind}-${i}`} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-2 text-sm">
                      {a.severity === 'warning'
                        ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-label="Warning" />
                        : <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-label="Information" />}
                      <span className="text-foreground">
                        {a.message}
                        {a.amount ? <> — <MoneyAmount value={a.amount} currency={currency} className="font-medium" /></> : null}
                      </span>
                    </div>
                    <Button asChild variant="outline" className="min-h-[44px] self-stretch sm:self-auto">
                      <Link to={a.href}>{a.actionLabel}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Open registers */}
            <section aria-labelledby="money-registers" className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 id="money-registers" className="text-base font-semibold text-foreground">Open registers</h2>
                <Link to="/pos/cash-registers" className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline">Registers</Link>
              </div>
              {data.openRegisters.length === 0 ? (
                <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No register is open.</p>
              ) : (
                <ul className="divide-y rounded-xl border bg-card">
                  {data.openRegisters.map((r) => (
                    <li key={r.sessionId} className="flex items-center justify-between gap-3 p-3 text-sm">
                      <div>
                        <p className="font-medium text-foreground">{r.registerName}</p>
                        <p className="text-xs text-muted-foreground">Open · {r.cashierName ?? 'Unknown cashier'} · since {new Date(r.openedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <div className="text-right">
                        <MoneyAmount value={r.expectedCash} currency={currency} className="font-semibold" />
                        <p className="text-xs text-muted-foreground">Expected cash</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Today */}
            <section aria-labelledby="money-today" className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 id="money-today" className="text-base font-semibold text-foreground">Today{todayLabel ? <span className="ml-2 text-sm font-normal text-muted-foreground">{todayLabel}</span> : null}</h2>
                <Link to="/accounts/cash-accounts/activity?period=today" className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline">See today’s activity</Link>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Money in" value={<MoneyAmount value={data.today.externalIn} currency={currency} className="text-emerald-700 dark:text-emerald-400" />} hint={<>POS: <MoneyAmount value={data.today.posReceipts} currency={currency} /></>} onClick={() => navigate('/accounts/cash-accounts/activity?period=today&direction=in')} />
                <StatCard label="Money out" value={<MoneyAmount value={data.today.externalOut} currency={currency} className="text-rose-700 dark:text-rose-400" />} onClick={() => navigate('/accounts/cash-accounts/activity?period=today&direction=out')} />
                <StatCard label="Moved between accounts" value={<MoneyAmount value={data.today.internalMoved} currency={currency} />} hint="Does not change total money" onClick={() => navigate('/accounts/cash-accounts/activity?period=today&direction=internal')} />
                <StatCard label="Activities" value={data.today.activityCount} hint={`Day and times in ${data.timezone}`} />
              </div>
            </section>
          </div>

          <HowMoneyFlows bankName={bank ? 'the bank' : 'a bank account'} />

          <section aria-labelledby="money-recent" className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 id="money-recent" className="text-base font-semibold text-foreground">Recent activity</h2>
              <Link to="/accounts/cash-accounts/activity" className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline">See all</Link>
            </div>
            <MoneyActivityList rows={data.recent} emptyText="No money activity has been recorded yet." />
          </section>
        </>
      )}

      {op ? <MoneyOperationDialog mode={op} open={!!op} onClose={() => setOp(null)} /> : null}
    </MoneyPage>
  );
}
