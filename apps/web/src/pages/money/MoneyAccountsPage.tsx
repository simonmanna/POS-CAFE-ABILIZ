import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Lock, Pencil, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import {
  useCashAccounts, useCreateCashAccount, useCurrencies, useUpdateCashAccount, type CashAccount,
} from '@/features/accounting/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useOrgCurrency } from '@/lib/format';
import { AccountTypeIcon, EmptyState, MoneyAmount, MoneyPage, accountTypeLabel } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const TYPES = ['cash', 'bank', 'mobile_money', 'petty_cash'] as const;
type AccountType = typeof TYPES[number];
/** Display groups: drawers are cash accounts, but people look for them separately. */
const GROUPS = ['drawers', 'bank', 'mobile_money', 'cash', 'petty_cash'] as const;

const isDrawer = (a: CashAccount) => (a.restrictions ?? []).includes('drawer') || !!a.cashRegister;
const groupOf = (a: CashAccount) => (isDrawer(a) ? 'drawers' : a.accountType);

const emptyForm = { name: '', code: '', type: 'bank' as AccountType, currencyId: '', bankName: '', accountNumber: '', isDefault: false };

function AccountFormDialog({ open, onClose, editing, initialType }: { open: boolean; onClose: () => void; editing: CashAccount | null; initialType?: AccountType }) {
  const create = useCreateCashAccount();
  const update = useUpdateCashAccount();
  const { data: currencies = [] } = useCurrencies();
  const base = useOrgCurrency();
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    if (!open) return;
    setForm(editing
      ? { name: editing.name, code: editing.code, type: (editing.accountType as AccountType) ?? 'bank', currencyId: editing.currencyId ?? '', bankName: editing.bankName ?? '', accountNumber: editing.accountNumber ?? '', isDefault: editing.isDefault }
      : { ...emptyForm, type: initialType ?? 'bank', currencyId: base });
  }, [open, editing, initialType, base]);

  const saving = create.isPending || update.isPending;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.code.trim()) { toast.error('Name and code are required'); return; }
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, name: form.name.trim(), bankName: form.bankName.trim() || undefined, accountNumber: form.accountNumber.trim() || undefined, isDefault: form.isDefault });
        toast.success('Account updated');
      } else {
        await create.mutateAsync({ code: form.code.trim(), name: form.name.trim(), accountType: form.type, currencyId: form.currencyId || undefined, bankName: form.bankName.trim() || undefined, accountNumber: form.accountNumber.trim() || undefined, isDefault: form.isDefault });
        toast.success('Account created');
      }
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The account was not saved'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add a money account'}</DialogTitle>
          <DialogDescription>A place where the business holds money: a bank account, mobile-money wallet, safe or petty-cash box. Register drawers are created with their register.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="acct-name">Name</Label>
            <Input id="acct-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Stanbic Operations" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="acct-type">Type</Label>
              <select id="acct-type" disabled={!!editing} className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}>
                {TYPES.map((t) => <option key={t} value={t}>{accountTypeLabel(t)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acct-code">Code</Label>
              <Input id="acct-code" required disabled={!!editing} className="font-mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. BANK-02" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-currency">Currency</Label>
            <select id="acct-currency" disabled={!!editing} className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60" value={form.currencyId} onChange={(e) => setForm({ ...form, currencyId: e.target.value })}>
              {!base ? <option value="">Organisation currency</option> : null}
              {(currencies as any[]).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}{c.code === base ? ' (base)' : ''}</option>)}
              {base && !(currencies as any[]).some((c) => c.code === base) ? <option value={base}>{base} (base)</option> : null}
            </select>
            {form.currencyId && base && form.currencyId !== base ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">POS payments can only use {base} accounts. Balances are still shown in {base}.</p>
            ) : null}
          </div>
          {form.type === 'bank' || form.type === 'mobile_money' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="acct-bank">{form.type === 'bank' ? 'Bank' : 'Provider'}</Label>
                <Input id="acct-bank" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder={form.type === 'bank' ? 'e.g. Stanbic' : 'e.g. MTN'} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acct-number">{form.type === 'bank' ? 'Account number' : 'Wallet number'}</Label>
                <Input id="acct-number" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
              </div>
            </div>
          ) : null}
          <label className="flex min-h-[44px] items-center gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
            <span>
              <span className="font-medium">Main {accountTypeLabel(form.type).toLowerCase()} account</span>
              <span className="block text-xs text-muted-foreground">Suggested first wherever this type of account is chosen.</span>
            </span>
          </label>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{editing ? 'Save changes' : 'Add account'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoneyAccountsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const { data: accounts = [], isLoading, isError, refetch } = useCashAccounts();
  const type = params.get('type') ?? 'all';
  const q = params.get('q') ?? '';
  const [dialog, setDialog] = useState<{ editing: CashAccount | null; type?: AccountType } | null>(null);

  useEffect(() => {
    const t = params.get('new');
    if (t && hasPermission(PERMISSIONS.account.create)) {
      setDialog({ editing: null, type: (TYPES as readonly string[]).includes(t) ? (t as AccountType) : undefined });
      const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true });
    }
  }, [params, setParams, hasPermission]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (!v || v === 'all') next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  const list = accounts as CashAccount[];
  const totals = useMemo(() => {
    const m = new Map<string, { count: number; balance: number }>();
    for (const a of list) {
      const g = groupOf(a) ?? 'other';
      const cur = m.get(g) ?? { count: 0, balance: 0 };
      cur.count += 1; cur.balance += Number(a.balance);
      m.set(g, cur);
    }
    return m;
  }, [list]);

  const filtered = list.filter((a) => {
    if (type !== 'all' && groupOf(a) !== type) return false;
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [a.name, a.code, a.bankName, a.accountNumber, ...(a.posMethods ?? []).map((m) => m.label), ...(a.registers ?? []).map((r) => r.name)]
      .some((v) => (v ?? '').toLowerCase().includes(s));
  });
  const groups = [...GROUPS, ...[...totals.keys()].filter((g) => !(GROUPS as readonly string[]).includes(g))];

  return (
    <MoneyPage
      title="Accounts"
      description="Every place the business holds money, what flows into each one, and its current book balance."
      actions={hasPermission(PERMISSIONS.account.create) ? (
        <Button className="min-h-[44px]" onClick={() => setDialog({ editing: null })}><Plus className="mr-2 h-4 w-4" /> Add account</Button>
      ) : null}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search accounts" value={q} onChange={(e) => set('q', e.target.value)} placeholder="Search name, code, bank, number, payment method or register…" className="pl-9" />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Account type">
          {(['all', ...GROUPS] as string[]).filter((g) => g === 'all' || totals.has(g)).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={type === g}
              onClick={() => set('type', g)}
              className={cn('inline-flex min-h-[36px] items-center rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                type === g ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted')}
            >
              {g === 'all' ? `All (${list.length})` : `${accountTypeLabel(g)} (${totals.get(g)?.count ?? 0})`}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : isError ? (
        <div className="flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Accounts could not be loaded. <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title={q || type !== 'all' ? 'No accounts match' : 'No money accounts yet'}>
          {q || type !== 'all' ? 'Try another search or type.' : 'Add your bank, mobile-money and petty-cash accounts to start tracking money.'}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => {
            const rows = filtered.filter((a) => groupOf(a) === g);
            if (rows.length === 0) return null;
            const t = totals.get(g);
            return (
              <section key={g} aria-labelledby={`group-${g}`} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id={`group-${g}`} className="flex items-center gap-2 text-base font-semibold text-foreground">
                    <AccountTypeIcon type={g} className="h-7 w-7" /> {accountTypeLabel(g)}
                    <span className="text-xs font-normal text-muted-foreground">{t?.count ?? rows.length} account{(t?.count ?? rows.length) === 1 ? '' : 's'}</span>
                  </h2>
                  <span className="text-sm text-muted-foreground">Total <MoneyAmount value={t?.balance ?? 0} className="font-semibold text-foreground" /></span>
                </div>
                <ul className="divide-y rounded-xl border bg-card">
                  {rows.map((a) => (
                    <li key={a.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        onClick={() => navigate(`/accounts/cash-accounts/${a.id}`)}
                        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <AccountTypeIcon type={isDrawer(a) ? 'drawers' : a.accountType} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{a.name}</span>
                            {a.isDefault ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase">Main</span> : null}
                            {isDrawer(a) ? <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium"><Lock className="h-3 w-3" aria-hidden /> Shift only</span> : null}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {a.code}{a.bankName ? ` · ${a.bankName}` : ''}{a.accountNumber ? ` · ${a.accountNumber}` : ''}{a.currencyCode ? ` · ${a.currencyCode}` : ''}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            {(a.registers ?? []).map((r) => <span key={r.id} className="rounded-full border px-2 py-0.5 text-[11px]">Drawer of {r.name}</span>)}
                            {(a.posMethods ?? []).filter((m) => m.isActive).map((m) => <span key={m.id} className="rounded-full border px-2 py-0.5 text-[11px]">Receives {m.label}</span>)}
                          </span>
                        </span>
                      </button>
                      <div className="flex items-center justify-between gap-4 sm:justify-end">
                        <div className="text-right">
                          <MoneyAmount value={a.balance} className={cn('font-semibold', Number(a.balance) < 0 && 'text-destructive')} />
                          <p className="text-[11px] text-muted-foreground">
                            {Number(a.todayIn ?? 0) || Number(a.todayOut ?? 0)
                              ? <>Today +<MoneyAmount value={a.todayIn} currency="" /> / −<MoneyAmount value={a.todayOut} currency="" /></>
                              : a.lastActivityAt ? `Last activity ${new Date(a.lastActivityAt).toLocaleDateString()}` : 'No activity yet'}
                          </p>
                        </div>
                        {hasPermission(PERMISSIONS.account.update) ? (
                          <Button variant="outline" size="sm" className="min-h-[40px]" onClick={() => setDialog({ editing: a })}>
                            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Edit
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <AccountFormDialog open={!!dialog} onClose={() => setDialog(null)} editing={dialog?.editing ?? null} initialType={dialog?.type} />
    </MoneyPage>
  );
}
