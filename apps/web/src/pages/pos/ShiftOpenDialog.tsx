import { usePaymentAccounts } from '@/features/pos/payment-accounts';
import { FinancialAccountCounts } from './FinancialAccountCounts';
import { useAuthStore } from '@/stores/auth.store';
const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
// Shift-open dialog. Cashier picks a register, enters opening float, opens session.
import React, { useEffect, useState } from 'react';
import { Power, Calculator, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCashRegisters, useDrawerBalance, useOpenShift } from './api';
import { toast } from 'sonner';

interface Props {
  preselectedRegisterId?: string;
  open: boolean;
  onClose: () => void;
  onOpened: () => void;
}

const QUICK_FLOATS = [0, 50000, 100000, 200000, 500000];

export const ShiftOpenDialog: React.FC<Props> = ({ open, onClose, onOpened, preselectedRegisterId }) => {
  const { data: registers = [] } = useCashRegisters();
  const [registerId, setRegisterId] = useState<string>('');
  const [openingFloat, setOpeningFloat] = useState('50000');
  const [notes, setNotes] = useState('');
  const { data: fundingAccounts = [] } = usePaymentAccounts();
  const [openingSourceAccountId, setOpeningSourceAccountId] = useState('');
  const [accountCounts, setAccountCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  /** When accepted, a count above/below the drawer is auto-recorded as cash-in / withdrawal. */
  const [autoAdjust, setAutoAdjust] = useState(true);
  const openShift = useOpenShift();
  const { data: drawer } = useDrawerBalance(registerId || undefined, open);
  const drawerLedger = drawer ? Number(drawer.ledger) : null;
  const floatNum = Number(openingFloat);
  const drawerDiff = drawerLedger != null && Number.isFinite(floatNum) ? floatNum - drawerLedger : null;

  useEffect(() => {
    if (open) {
      setRegisterId(preselectedRegisterId ?? registers[0]?.id ?? '');
      setOpeningFloat('50000');
      setNotes('');
      setAccountCounts({});
      setErr(null);
      setAutoAdjust(true);
    }
  }, [open, registers.length]);

  const submit = async () => {
    setErr(null);
    if (!registerId) { setErr('Pick a cash register'); return; }
    const float = Number(openingFloat);
    if (!Number.isFinite(float) || float < 0) { setErr('Opening float must be a non-negative number'); return; }
    try {
      await openShift.mutateAsync({
        cashRegisterId: registerId,
        openingFloat: float,
        openingSourceAccountId: openingSourceAccountId || undefined,
        openingAccounts: accountCounts,
        notes: notes.trim() || undefined,
        autoAdjust,
      });
      toast.success('Shift opened — you can now sell');
      onOpened();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to open shift');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Power className="h-4 w-4 text-emerald-600" /> Open shift
          </DialogTitle>
          <DialogDescription>
            Pick the cash register you're working on today and count the opening float.
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label>Cash register</Label>
          {registers.length === 0 ? (
            <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2 mt-1">
              No active cash registers. Ask a manager to create one under Accounting → Cash Registers.
            </div>
          ) : (
            <select
              className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm"
              value={registerId}
              onChange={(e) => setRegisterId(e.target.value)}
            >
              {registers.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.code} — {r.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <Label className="flex items-center gap-1 mb-2">
            <Calculator className="h-3 w-3" /> Opening float ({orgCur()})
          </Label>
          <Input
            type="number"
            value={openingFloat}
            onChange={(e) => setOpeningFloat(e.target.value)}
            className="text-right text-lg h-11 font-mono font-bold"
            autoFocus
          />
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {QUICK_FLOATS.map((q) => (
              <button
                key={q}
                type="button"
                className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-xs font-bold"
                onClick={() => setOpeningFloat(String(q))}
              >
                {q === 0 ? 'No float' : q.toLocaleString()}
              </button>
            ))}
          </div>
          {drawerLedger != null ? (
            <p className="mt-2 text-xs text-slate-500">
              This drawer currently holds <span className="font-mono font-bold text-slate-700">{orgCur()} {drawerLedger.toLocaleString()}</span>.
            </p>
          ) : null}
        </div>

        {drawerDiff != null && Math.abs(drawerDiff) > 0.005 && Number.isFinite(floatNum) ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700">
              {drawerDiff < 0 ? <ArrowDownToLine className="h-3.5 w-3.5" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
              Drawer difference
            </p>
            <p className="mt-1 text-sm text-amber-900">
              You are entering <span className="font-mono font-bold">{orgCur()} {floatNum.toLocaleString()}</span> —{' '}
              {drawerDiff < 0
                ? <>{orgCur()} {Math.abs(drawerDiff).toLocaleString()} <b>less</b> than the drawer. If accepted, this is recorded as a <b>withdrawal</b>.</>
                : <>{orgCur()} {drawerDiff.toLocaleString()} <b>more</b> than the drawer. If accepted, this is recorded as a <b>cash-in</b> (owner adds money).</>}
            </p>
            <label className="mt-2 flex items-start gap-2 text-sm font-semibold text-amber-900 cursor-pointer">
              <input type="checkbox" checked={autoAdjust} onChange={(e) => setAutoAdjust(e.target.checked)} className="mt-0.5" />
              Accept — record the difference automatically
            </label>
            {!autoAdjust ? (
              <p className="mt-1 text-xs text-amber-800">
                Without accepting, the count must match the drawer{drawerDiff > 0 ? ' (and a funding source is required)' : ''}.
              </p>
            ) : null}
          </div>
        ) : null}

        <div>
          <Label>Notes (optional)</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Morning shift"
          />
        </div>

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <label className="text-sm">Source of additional float (when adding money)
          <select className="w-full border rounded p-2" value={openingSourceAccountId} onChange={(e) => setOpeningSourceAccountId(e.target.value)}>
            <option value="">Use cash already recorded in this drawer</option>
            {fundingAccounts.filter((a) => ['cash', 'petty_cash', 'bank'].includes(a.accountType)).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select>
          <span className="text-xs text-slate-500">Adding float transfers funds from this account. Enter its reason in Notes.</span>
        </label>
        <FinancialAccountCounts stage="opening" value={accountCounts} onChange={setAccountCounts} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={openShift.isPending || registers.length === 0}
            style={{ background: '#16a34a' }}
          >
            {openShift.isPending ? 'Opening…' : 'Open shift'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};