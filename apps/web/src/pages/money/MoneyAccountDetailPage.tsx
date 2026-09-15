import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Lock } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import { useCashAccounts, useCashAccountTransactions, type CashAccount } from '@/features/accounting/api';
import { useMoneyActivity } from '@/features/money/api';
import { MoneyActivityList } from '@/components/money/MoneyActivityList';
import { MoneyOperationDialog, type MoneyOperationMode } from '@/components/money/MoneyOperationDialog';
import { AccountTypeIcon, CategoryBadge, MoneyAmount, StatCard, accountTypeLabel } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function MoneyAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [view, setView] = useState<'activity' | 'ledger'>('activity');
  const [page, setPage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [op, setOp] = useState<MoneyOperationMode | null>(null);

  const { data: accounts = [], isLoading: loadingAccounts } = useCashAccounts();
  const account = (accounts as CashAccount[]).find((a) => a.id === id);
  const activity = useMoneyActivity({ accountId: id, page, pageSize: 20 });
  const ledger = useCashAccountTransactions(view === 'ledger' ? id : undefined, { page: ledgerPage, pageSize: 25 });

  if (loadingAccounts) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  }
  if (!account) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <Link to="/accounts/cash-accounts/accounts" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft className="h-4 w-4" /> Accounts</Link>
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">This account was not found, is inactive, or is not a money account.</p>
      </div>
    );
  }

  const drawer = (account.restrictions ?? []).includes('drawer') || !!account.cashRegister;
  const canMove = hasPermission(PERMISSIONS.treasury.transfer) && !drawer;
  const currency = account.baseCurrency ?? null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
      <Link to="/accounts/cash-accounts/accounts" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All accounts
      </Link>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <AccountTypeIcon type={drawer ? 'drawers' : account.accountType} className="h-11 w-11" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{account.name}</h1>
            <p className="text-sm text-muted-foreground">
              {accountTypeLabel(drawer ? 'drawers' : account.accountType)} · {account.code}
              {account.bankName ? ` · ${account.bankName}` : ''}{account.accountNumber ? ` · ${account.accountNumber}` : ''}
              {account.currencyCode ? ` · ${account.currencyCode}` : ''}
            </p>
          </div>
        </div>
        {canMove ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-[44px]" onClick={() => setOp('in')}><ArrowDownLeft className="mr-2 h-4 w-4" /> Other money in</Button>
            <Button variant="outline" className="min-h-[44px]" onClick={() => setOp('out')}><ArrowUpRight className="mr-2 h-4 w-4" /> Other money out</Button>
            <Button className="min-h-[44px]" onClick={() => setOp('transfer')}><ArrowLeftRight className="mr-2 h-4 w-4" /> Transfer</Button>
          </div>
        ) : drawer ? (
          <p className="flex max-w-sm items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Drawer cash moves only through register shifts: sales, cash in/out, banking and close. <Link to="/pos/cash-registers" className="font-medium text-primary hover:underline">Open registers</Link>
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard tone="primary" label={`Book balance${currency ? ` (${currency})` : ''}`} value={<MoneyAmount value={account.balance} currency={currency} className={cn(Number(account.balance) < 0 && 'text-destructive')} />} hint={account.lastActivityAt ? `Last activity ${new Date(account.lastActivityAt).toLocaleString()}` : 'No activity yet'} />
        <StatCard label="In today" value={<MoneyAmount value={account.todayIn ?? 0} currency={currency} className="text-emerald-700 dark:text-emerald-400" />} />
        <StatCard label="Out today" value={<MoneyAmount value={account.todayOut ?? 0} currency={currency} className="text-rose-700 dark:text-rose-400" />} />
      </div>

      <section aria-labelledby="acct-inflows" className="rounded-xl border bg-card p-4">
        <h2 id="acct-inflows" className="text-sm font-semibold text-foreground">What goes into this account</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {(account.registers ?? []).map((r) => <li key={r.id}>Cash sales and cash-in/out of the <strong>{r.name}</strong> register shifts</li>)}
          {(account.posMethods ?? []).map((m) => (
            <li key={m.id}>POS payments by <strong>{m.label}</strong>{!m.isActive ? <span className="text-muted-foreground"> (hidden at the till)</span> : null}</li>
          ))}
          {!(account.registers ?? []).length && !(account.posMethods ?? []).length ? (
            <li className="text-muted-foreground">No POS payment method or register uses this account. Money arrives through receipts, transfers, settlements or manual entries.</li>
          ) : null}
        </ul>
        <Link to="/settings/payment-methods" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">Change payment method links</Link>
      </section>

      <div className="flex gap-1 border-b" role="tablist" aria-label="Account history view">
        {(['activity', 'ledger'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn('min-h-[44px] border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view === v ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {v === 'activity' ? 'Activity' : 'Ledger & running balance'}
          </button>
        ))}
      </div>

      {view === 'activity' ? (
        activity.isLoading ? (
          <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
        ) : (
          <>
            <MoneyActivityList rows={activity.data?.data ?? []} emptyText="No activity on this account yet." />
            {activity.data && activity.data.totalPages > 1 ? (
              <Pager page={page} totalPages={activity.data.totalPages} onChange={setPage} />
            ) : null}
          </>
        )
      ) : ledger.isLoading || !ledger.data ? (
        <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">In</th>
                  <th className="px-3 py-2 text-right font-medium">Out</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.data.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No ledger lines yet.</td></tr>
                ) : ledger.data.data.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2">{new Date(t.postingDate).toLocaleDateString()}</td>
                    <td className="px-3 py-2">{t.category ? <CategoryBadge category={t.category} label={t.categoryLabel ?? t.category} /> : null}</td>
                    <td className="max-w-[280px] truncate px-3 py-2" title={t.description ?? undefined}>
                      <Link to={`/journal-entries/${t.journalEntryId}`} className="hover:underline">{t.description || t.entryNumber}</Link>
                    </td>
                    <td className="px-3 py-2 text-right">{Number(t.baseDebit) > 0 ? <MoneyAmount value={t.baseDebit} currency={currency} /> : ''}</td>
                    <td className="px-3 py-2 text-right">{Number(t.baseCredit) > 0 ? <MoneyAmount value={t.baseCredit} currency={currency} /> : ''}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground"><MoneyAmount value={t.runningBalance} currency={currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ledger.data.totalPages > 1 ? <Pager page={ledgerPage} totalPages={ledger.data.totalPages} onChange={setLedgerPage} /> : null}
        </>
      )}

      {op ? <MoneyOperationDialog mode={op} open={!!op} onClose={() => setOp(null)} defaultAccountId={account.id} /> : null}
    </div>
  );
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
      </div>
    </div>
  );
}
