/**
 * Manager-side shift custody controls on the Cash Register page.
 *
 *  - Force-close: a shift left open by another cashier is closed by a manager
 *    with a blind count and a reason. Closed shifts are never reopened.
 *  - Bank closed-shift cash: after the Z-read the counted cash still sits on the
 *    drawer ledger. Banking it posts drawer → bank without touching the frozen
 *    shift, and only while no shift is open on the register.
 */
import React, { useMemo, useState } from 'react';
import { Landmark, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuthStore } from '@/stores/auth.store';
import { useCashAccounts } from '@/features/accounting/api';
import { useForceCloseShift, useRecordBankDeposit } from '../api';
import type { CashSession, SessionHistoryItem } from '../types';

const cur = () => useAuthStore.getState().organization?.currencyCode ?? 'UGX';
const fmt = (n: number | string | null | undefined) => `${cur()} ${Number(n ?? 0).toLocaleString()}`;

export const ForceCloseCard: React.FC<{ session: CashSession; onDone: () => void }> = ({ session, onDone }) => {
  const canForce = useAuthStore((s) => s.hasPermission('cash_session:force_close'));
  const forceClose = useForceCloseShift();
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [varianceReason, setVarianceReason] = useState('');

  const submit = async () => {
    const amount = Number(counted);
    if (counted.trim() === '' || !(amount >= 0)) { toast.error('Enter the cash counted in the drawer'); return; }
    if (!reason.trim()) { toast.error('Say why this shift is being force-closed'); return; }
    try {
      await forceClose.mutateAsync({
        sessionId: session.id,
        closingCounted: amount,
        notes: reason.trim(),
        varianceReason: varianceReason.trim() || undefined,
      });
      toast.success('Shift force-closed and Z-report stored');
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Force-close failed'));
    }
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-amber-900">
          <p className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4" /> This register is open under another cashier</p>
          <p className="text-amber-800">
            Open since {session.openedAt ? new Date(session.openedAt).toLocaleString() : '—'}. Only that cashier can close it normally
            (or hand it over). If they have left, a manager can force-close it with a blind count.
          </p>
        </div>
        {canForce && (
          <Button variant="outline" className="border-amber-400 text-amber-900" onClick={() => { setCounted(''); setReason(''); setVarianceReason(''); setOpen(true); }}>
            Force close
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!forceClose.isPending) setOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Force-close shift</DialogTitle>
            <DialogDescription>
              Count the drawer without looking at the expected figure. You approve any variance, so you cannot be the cashier of this shift.
              Wallet and bank balances must still be entered by the cashier's normal close; if they cannot be, close from the POS with "Could not check".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Cash counted ({cur()})</Label>
              <Input type="number" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} className="text-right font-mono" autoFocus />
            </div>
            <div>
              <Label>Why is this shift being force-closed?</Label>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cashier left at end of day without closing" />
            </div>
            <div>
              <Label>Variance explanation <span className="font-normal text-slate-400">(if the count differs)</span></Label>
              <Input value={varianceReason} onChange={(e) => setVarianceReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={forceClose.isPending}>Cancel</Button>
            <Button onClick={submit} disabled={forceClose.isPending}>{forceClose.isPending ? 'Closing…' : 'Force close'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export const BankClosedShiftCard: React.FC<{ registerId: string; lastClosed: SessionHistoryItem | null; onDone: () => void }> = ({ registerId, lastClosed, onDone }) => {
  const canBank = useAuthStore((s) => s.hasPermission('cash_session:reconcile'));
  const { data: cashAccounts = [], refetch } = useCashAccounts();
  const bankDeposit = useRecordBankDeposit();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [reference, setReference] = useState('');

  const drawer = useMemo(() => (cashAccounts as any[]).find((a) => a.cashRegister?.id === registerId), [cashAccounts, registerId]);
  const banks = useMemo(() => (cashAccounts as any[]).filter((a) => a.accountType === 'bank' && !a.cashRegister), [cashAccounts]);
  const inDrawer = Number(drawer?.balance ?? 0);

  if (!lastClosed || !(inDrawer > 0)) return null;

  const submit = async () => {
    const amt = Number(amount);
    if (!(amt > 0) || amt > inDrawer) { toast.error(`Enter an amount up to ${fmt(inDrawer)}`); return; }
    const bank = banks.find((b) => b.id === destinationAccountId);
    if (!bank) { toast.error('Choose the bank account'); return; }
    try {
      await bankDeposit.mutateAsync({ sessionId: lastClosed.id, amount: amt, destinationAccountId: bank.id, bankName: bank.bankName || bank.name, reference: reference.trim() || undefined });
      toast.success('Deposit recorded');
      setOpen(false);
      await refetch();
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Deposit failed'));
    }
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-center justify-between gap-3">
      <div className="text-sm text-amber-900">
        <p className="font-semibold">{fmt(inDrawer)} is still on this drawer's books</p>
        <p className="text-amber-800">Bank it before opening with a smaller float: the opening count cannot be below the drawer ledger.</p>
      </div>
      {canBank && (
        <Button variant="outline" className="border-amber-400 text-amber-900" onClick={() => { setAmount(String(inDrawer)); setDestinationAccountId(''); setReference(''); setOpen(true); }}>
          <Landmark className="h-4 w-4 mr-1" /> Bank it
        </Button>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!bankDeposit.isPending) setOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bank drawer cash</DialogTitle>
            <DialogDescription>The closed shift and its Z-report are not changed; this posts the deposit from the drawer to the bank.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Amount ({cur()})</Label>
              <Input type="number" min={0} max={inDrawer} value={amount} onChange={(e) => setAmount(e.target.value)} className="text-right font-mono" />
            </div>
            <div>
              <Label>Bank account</Label>
              <select className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm" value={destinationAccountId} onChange={(e) => setDestinationAccountId(e.target.value)}>
                <option value="">Choose…</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Deposit slip reference <span className="font-normal text-slate-400">(optional)</span></Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={bankDeposit.isPending}>Cancel</Button>
            <Button onClick={submit} disabled={bankDeposit.isPending}>{bankDeposit.isPending ? 'Recording…' : 'Record deposit'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
