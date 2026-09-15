import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, Info, Landmark, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import { useSettleTender, useSettlementHistory, useSettlementSources, type SettlementSource } from '@/features/money/api';
import { apiErrorMessage } from '@/lib/api-error';
import { AccountTypeIcon, EmptyState, MoneyAmount, MoneyPage, formatAmount } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const today = () => new Date().toISOString().slice(0, 10);

function SettleDialog({
  source, open, onClose, destinations, feeAccounts, currency,
}: {
  source: SettlementSource | null;
  open: boolean;
  onClose: () => void;
  destinations: { id: string; code: string; name: string }[];
  feeAccounts: { id: string; code: string; name: string }[];
  currency: string | null;
}) {
  const settle = useSettleTender();
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [destinationId, setDestinationId] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0');
  const [feeAccountId, setFeeAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());

  useEffect(() => {
    if (!open || !source) return;
    setStep('form');
    setDestinationId(destinations.length === 1 ? destinations[0].id : '');
    setAmount(Number(source.suggestedAmount) > 0 ? String(Number(source.suggestedAmount)) : '');
    setFee('0'); setFeeAccountId(''); setReference(''); setDate(today());
  }, [open, source, destinations]);

  if (!source) return null;
  const gross = Number(amount);
  const feeN = Number(fee) || 0;
  const net = gross - feeN;
  const overBalance = gross > Number(source.balance);
  const valid = gross > 0 && !overBalance && feeN >= 0 && feeN < gross && !!destinationId && !!reference.trim() && !!date && (feeN === 0 || !!feeAccountId);
  const dest = destinations.find((d) => d.id === destinationId);
  const fmt = (v: number | string) => formatAmount(v, currency);

  const submit = async () => {
    try {
      await settle.mutateAsync({
        sourceAccountId: source.accountId,
        destinationAccountId: destinationId,
        grossAmount: gross,
        feeAmount: feeN || undefined,
        feeAccountId: feeN ? feeAccountId : undefined,
        reference: reference.trim(),
        settledAt: new Date(`${date}T12:00:00`).toISOString(),
      });
      toast.success('Settlement recorded');
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The settlement was not recorded. Keep the provider reference and check history before retrying.'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !settle.isPending) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settle {source.accountName} to the bank</DialogTitle>
          <DialogDescription>Record money the provider paid into your bank. Use the date and reference on the provider statement.</DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) setStep('review'); }}>
            <div className="space-y-1.5">
              <Label htmlFor="settle-dest">Bank that received the money</Label>
              <select id="settle-dest" required className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">{destinations.length ? 'Choose bank account' : 'No bank account — add one under Accounts'}</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.code}</option>)}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settle-amount">Amount settled{currency ? ` (${currency})` : ''}</Label>
                <Input id="settle-amount" type="number" inputMode="decimal" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
                <p className={overBalance ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>
                  {overBalance ? 'More than the provider account holds: ' : 'Balance on provider account: '}{fmt(source.balance)}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-fee">Provider fee</Label>
                <Input id="settle-fee" type="number" inputMode="decimal" min="0" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
              </div>
            </div>
            {Number(source.suggestedAmount) > 0 ? (
              <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Suggested amount {fmt(source.suggestedAmount)} comes from recorded POS receipts since the last settlement. Verify against the provider statement before posting.
              </p>
            ) : null}
            {feeN > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="settle-fee-acct">Record the fee as</Label>
                <select id="settle-fee-acct" required className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={feeAccountId} onChange={(e) => setFeeAccountId(e.target.value)}>
                  <option value="">Choose expense account</option>
                  {feeAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </select>
              </div>
            ) : null}
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Bank receives</span><strong>{gross > 0 ? fmt(net) : '—'}</strong></div>
              {feeN >= gross && gross > 0 ? <p className="mt-1 text-xs text-destructive">The fee must be less than the amount settled.</p> : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settle-ref">Provider reference</Label>
                <Input id="settle-ref" required value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Statement / batch ID" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-date">Settlement date</Label>
                <Input id="settle-date" type="date" required max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!valid}>Review</Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>
                {fmt(gross)} leaves {source.accountName}. {dest?.name} receives {fmt(net)}
                {feeN > 0 ? <> and the {fmt(feeN)} fee is recorded as an expense (money that leaves the business)</> : null}. Reference {reference}, dated {date}.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setStep('form')} disabled={settle.isPending}>Back</Button>
              <Button type="button" onClick={submit} disabled={settle.isPending}>
                {settle.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Confirm settlement
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MoneySettlementsPage() {
  const [params, setParams] = useSearchParams();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const allowed = hasPermission(PERMISSIONS.cashSession.reconcile);
  const { data, isLoading, isError, refetch } = useSettlementSources(allowed);
  const sourceFilter = params.get('source') ?? '';
  const [page, setPage] = useState(1);
  const history = useSettlementHistory({ sourceAccountId: sourceFilter || undefined, page });
  const [settling, setSettling] = useState<SettlementSource | null>(null);
  const currency = data?.currencyCode ?? null;
  const filterName = useMemo(() => data?.sources.find((s) => s.accountId === sourceFilter)?.accountName, [data, sourceFilter]);

  return (
    <MoneyPage
      title="Settlements"
      description="Card and mobile-money payments wait on the provider account until the provider pays them into your bank."
    >
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : isError || !data ? (
        <div className="flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Settlement accounts could not be loaded. <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : data.sources.length === 0 ? (
        <EmptyState icon={Landmark} title="No card or mobile-money account to settle">
          Connect card or mobile-money payment methods to their receiving accounts in <Link to="/settings/payment-methods" className="font-medium text-primary hover:underline">Settings → Payment methods</Link>.
        </EmptyState>
      ) : (
        <section aria-label="Accounts to settle" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.sources.map((s) => (
            <article key={s.accountId} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <AccountTypeIcon type={s.accountType} />
                <div className="min-w-0">
                  <h2 className="font-semibold text-foreground">{s.accountName}</h2>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.methods.map((m) => <span key={m.id} className="rounded-full border px-2 py-0.5 text-[11px]">{m.label}</span>)}
                  </div>
                </div>
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                <dt className="text-muted-foreground">Balance on provider account</dt>
                <dd className="text-right font-semibold"><MoneyAmount value={s.balance} currency={currency} /></dd>
                <dt className="text-muted-foreground">POS receipts since last settlement</dt>
                <dd className="text-right"><MoneyAmount value={s.posReceiptsSinceLastSettlement} currency={currency} /></dd>
                <dt className="text-muted-foreground">Last settlement</dt>
                <dd className="text-right">{s.lastSettledAt ? new Date(s.lastSettledAt).toLocaleDateString() : 'None recorded'}</dd>
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button className="min-h-[44px] flex-1" disabled={Number(s.balance) <= 0} onClick={() => setSettling(s)}>Settle to bank</Button>
                <Button variant="outline" className="min-h-[44px]" onClick={() => { const n = new URLSearchParams(params); if (sourceFilter === s.accountId) n.delete('source'); else n.set('source', s.accountId); setParams(n, { replace: true }); setPage(1); }}>
                  {sourceFilter === s.accountId ? 'All history' : 'History'}
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="settlement-history" className="space-y-2">
        <h2 id="settlement-history" className="text-base font-semibold text-foreground">
          Settlement history{filterName ? ` — ${filterName}` : ''}
        </h2>
        {history.isLoading ? (
          <div className="flex h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
        ) : !history.data?.data.length ? (
          <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">No settlements recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">From → To</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2 text-right font-medium">Bank received</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">Links</th>
                </tr>
              </thead>
              <tbody>
                {history.data.data.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2">{new Date(r.settledAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2">{r.source.name} → {r.destination.name}</td>
                    <td className="px-3 py-2 text-right"><MoneyAmount value={r.grossAmount} currency={currency} /></td>
                    <td className="px-3 py-2 text-right">{Number(r.feeAmount) > 0 ? <MoneyAmount value={r.feeAmount} currency={currency} /> : '—'}</td>
                    <td className="px-3 py-2 text-right font-medium"><MoneyAmount value={r.netAmount} currency={currency} /></td>
                    <td className="px-3 py-2 font-mono text-xs">{r.reference}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.session ? <span className="mr-2 text-muted-foreground">{r.session.registerName} shift</span> : null}
                      {r.journalEntryId ? <Link to={`/journal-entries/${r.journalEntryId}`} className="inline-flex items-center gap-1 text-primary hover:underline">Entry <ExternalLink className="h-3 w-3" aria-hidden /></Link> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.data && history.data.totalPages > 1 ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-muted-foreground">Page {page} of {history.data.totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= history.data.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </section>

      <SettleDialog
        source={settling}
        open={!!settling}
        onClose={() => setSettling(null)}
        destinations={data?.destinations ?? []}
        feeAccounts={data?.feeAccounts ?? []}
        currency={currency}
      />
    </MoneyPage>
  );
}
