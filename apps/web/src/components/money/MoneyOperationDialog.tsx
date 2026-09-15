import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronRight, ExternalLink, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useCashAccounts, useCashFlowDeposit, useCashFlowOperationTypes, useCashFlowWithdraw, useTreasuryTransfer,
  type CashAccount,
} from '@/features/accounting/api';
import { apiErrorMessage } from '@/lib/api-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatAmount, useAmountCurrency } from './money-ui';

export type MoneyOperationMode = 'in' | 'out' | 'transfer';

const TITLES: Record<MoneyOperationMode, { title: string; icon: typeof ArrowDownLeft }> = {
  in: { title: 'Record other money in', icon: ArrowDownLeft },
  out: { title: 'Record other money out', icon: ArrowUpRight },
  transfer: { title: 'Transfer between accounts', icon: ArrowLeftRight },
};

/** Money that has its own workflow — send people there instead of posting a manual entry. */
const ELSEWHERE: Record<'in' | 'out', { label: string; hint: string; href: string }[]> = {
  in: [
    { label: 'A POS sale', hint: 'Recorded automatically when the cashier charges the order', href: '/pos/terminal' },
    { label: 'A customer paying an invoice', hint: 'Use Receipts so the invoice is marked paid', href: '/payments' },
    { label: 'Card or mobile-money payout to the bank', hint: 'Use Settlements so fees are recorded', href: '/accounts/cash-accounts/settlements' },
  ],
  out: [
    { label: 'Pay a supplier invoice', hint: 'Use Supplier Payments so the bill is cleared', href: '/supplier-payments' },
    { label: 'Record a business expense', hint: 'Use Expenses for approvals and receipts', href: '/expenses' },
    { label: 'Pay salaries', hint: 'Use Payroll', href: '/hr/payroll' },
    { label: 'Bank cash from a register', hint: 'Use the register page so the shift is updated', href: '/pos/cash-registers' },
  ],
};

/** Operation types that duplicate a dedicated workflow above. */
const HIDDEN_OPERATIONS = new Set(['expense']);

const today = () => new Date().toISOString().slice(0, 10);

export function MoneyOperationDialog({
  mode, open, onClose, defaultAccountId,
}: {
  mode: MoneyOperationMode;
  open: boolean;
  onClose: () => void;
  defaultAccountId?: string;
}) {
  const navigate = useNavigate();
  const { data: accounts = [] } = useCashAccounts();
  const { data: operationTypes } = useCashFlowOperationTypes(open && mode !== 'transfer');
  const deposit = useCashFlowDeposit();
  const withdraw = useCashFlowWithdraw();
  const transfer = useTreasuryTransfer();
  const currency = useAmountCurrency();

  const [step, setStep] = useState<'purpose' | 'details' | 'review'>('details');
  const [operation, setOperation] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [counterpartId, setCounterpartId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep(mode === 'transfer' ? 'details' : 'purpose');
    setOperation(''); setCounterpartId(''); setAmount(''); setDate(today()); setReference(''); setNote('');
    setAccountId(defaultAccountId ?? '');
    setToAccountId('');
  }, [open, mode, defaultAccountId]);

  // Register drawers move only through their shift; never offered here.
  const eligible = useMemo(
    () => (accounts as CashAccount[]).filter((a) => !(a.restrictions ?? []).includes('drawer') && !a.cashRegister),
    [accounts],
  );
  const byId = (id: string) => eligible.find((a) => a.id === id);
  const source = byId(accountId);
  const destination = byId(toAccountId);
  const ops = (mode === 'in' ? operationTypes?.deposit : operationTypes?.withdrawal)?.filter((o) => !HIDDEN_OPERATIONS.has(o.key)) ?? [];
  const op = ops.find((o) => o.key === operation);
  const counterpart = op?.accounts.find((a) => a.id === counterpartId);
  const n = Number(amount);
  const needsFunds = mode === 'out' || mode === 'transfer';
  const insufficient = needsFunds && source && n > Number(source.balance);
  const pending = deposit.isPending || withdraw.isPending || transfer.isPending;
  const fmt = (v: string | number) => formatAmount(v, currency);

  const detailsValid = n > 0 && !!accountId && !!date && !insufficient && (
    mode === 'transfer' ? !!toAccountId && toAccountId !== accountId : !!operation && !!counterpartId && !!note.trim()
  );

  const summary = (() => {
    if (!source) return '';
    if (mode === 'transfer') {
      return destination
        ? `Transfer ${fmt(n)} from ${source.name} to ${destination.name}. ${source.name} goes down, ${destination.name} goes up. Total money is unchanged.`
        : '';
    }
    const label = op?.label ?? 'Operation';
    return mode === 'in'
      ? `Record ${fmt(n)} coming into ${source.name} as “${label}” (booked against ${counterpart?.name ?? 'the selected account'}). Total money goes up.`
      : `Record ${fmt(n)} leaving ${source.name} as “${label}” (booked against ${counterpart?.name ?? 'the selected account'}). Total money goes down.`;
  })();

  const submit = async () => {
    if (pending) return;
    try {
      if (mode === 'transfer') {
        await transfer.mutateAsync({ fromAccountId: accountId, toAccountId, amount: n, date, reference: reference.trim() || undefined });
        toast.success('Transfer recorded');
      } else {
        const description = [note.trim(), reference.trim() ? `ref ${reference.trim()}` : ''].filter(Boolean).join(' · ');
        const input = { accountId, counterpartAccountId: counterpartId, operationType: operation, amount: n, description, date };
        if (mode === 'in') await deposit.mutateAsync(input); else await withdraw.mutateAsync(input);
        toast.success(mode === 'in' ? 'Money in recorded' : 'Money out recorded');
      }
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The operation was not recorded'));
    }
  };

  const Icon = TITLES[mode].icon;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !pending) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Icon className="h-5 w-5" aria-hidden /> {TITLES[mode].title}</DialogTitle>
          <DialogDescription>
            {mode === 'transfer'
              ? 'Move money between your own cash, bank and mobile-money accounts. Register drawers move only through their shifts.'
              : 'Use this only for money not already recorded through POS sales, customer receipts, supplier payments, expenses, payroll or settlements.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'purpose' && mode !== 'transfer' ? (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Is this one of these? They have their own screen:</p>
              <ul className="space-y-1.5">
                {ELSEWHERE[mode].map((e) => (
                  <li key={e.href}>
                    <button
                      type="button"
                      onClick={() => { onClose(); navigate(e.href); }}
                      className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>
                        <span className="font-medium text-foreground">{e.label}</span>
                        <span className="block text-xs text-muted-foreground">{e.hint}</span>
                      </span>
                      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Otherwise, continue here:</p>
              {!operationTypes ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
              ) : (
                <ul className="space-y-1.5">
                  {ops.map((o) => (
                    <li key={o.key}>
                      <button
                        type="button"
                        onClick={() => { setOperation(o.key); setCounterpartId(o.accounts.length === 1 ? o.accounts[0].id : ''); setStep('details'); }}
                        className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {o.label}
                        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {step === 'details' ? (
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (detailsValid) setStep('review'); }}
          >
            {mode !== 'transfer' && op ? (
              <p className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm">
                <span><span className="text-muted-foreground">Purpose:</span> <strong>{op.label}</strong></span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep('purpose')}>Change</Button>
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="money-op-account">{mode === 'in' ? 'Receive into' : mode === 'out' ? 'Pay from' : 'From'}</Label>
              <select id="money-op-account" required className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Choose account</option>
                {eligible.map((a) => <option key={a.id} value={a.id}>{a.name} — {fmt(a.balance)}</option>)}
              </select>
            </div>

            {mode === 'transfer' ? (
              <div className="space-y-1.5">
                <Label htmlFor="money-op-to">To</Label>
                <select id="money-op-to" required className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                  <option value="">Choose account</option>
                  {eligible.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={a.id}>{a.name} — {fmt(a.balance)}</option>)}
                </select>
              </div>
            ) : op ? (
              <div className="space-y-1.5">
                <Label htmlFor="money-op-counterpart">Accounting account</Label>
                <select id="money-op-counterpart" required className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={counterpartId} onChange={(e) => setCounterpartId(e.target.value)}>
                  <option value="">{op.accounts.length ? 'Choose account' : 'No eligible account — add one to the chart of accounts'}</option>
                  {op.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Where this is recorded in the books ({op.accounts[0]?.classification ?? 'ledger'} account).</p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="money-op-amount">Amount{currency ? ` (${currency})` : ''}</Label>
                <Input id="money-op-amount" type="number" inputMode="decimal" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
                {source && needsFunds ? (
                  <p className={insufficient ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>
                    {insufficient ? 'More than is available: ' : 'Available: '}{fmt(source.balance)}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="money-op-date">Date</Label>
                <Input id="money-op-date" type="date" required value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="money-op-ref">Reference <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="money-op-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank slip, transaction ID…" />
            </div>

            {mode !== 'transfer' ? (
              <div className="space-y-1.5">
                <Label htmlFor="money-op-note">Description</Label>
                <Input id="money-op-note" required value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'in' ? 'e.g. Capital from owner' : 'e.g. Monthly bank charges'} />
              </div>
            ) : null}

            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!detailsValid}>Review</Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === 'review' ? (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p className="text-foreground">{summary}</p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Date</dt><dd>{date}</dd>
              {reference ? (<><dt className="text-muted-foreground">Reference</dt><dd>{reference}</dd></>) : null}
              {note ? (<><dt className="text-muted-foreground">Description</dt><dd>{note}</dd></>) : null}
            </dl>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('details')} disabled={pending}>Back</Button>
              <Button type="button" onClick={submit} disabled={pending}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Confirm and record
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
