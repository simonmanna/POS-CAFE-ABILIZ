// Shift-close dialog. Shows expected cash, asks for counted cash, reports variance.
import React, { useEffect, useState } from 'react';
import { PowerOff, AlertTriangle, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCloseShift, useExpectedCash } from './api';
import type { CashSession } from './types';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  session: CashSession | null;
  onClose: () => void;
  onClosed: () => void;
}

const fmt = (n: number | string | null | undefined) => `UGX ${Number(n || 0).toLocaleString()}`;

export const ShiftCloseDialog: React.FC<Props> = ({ open, session, onClose, onClosed }) => {
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const closeShift = useCloseShift();
  const { data: expected } = useExpectedCash(open && session ? session.id : undefined);

  useEffect(() => {
    if (open) {
      setCounted('');
      setNotes('');
      setErr(null);
    }
  }, [open]);

  if (!session) return null;

  const expectedCash = Number(expected?.expectedCash ?? session.openingFloat ?? 0);
  const countedNum = Number(counted);
  const variance = Number.isFinite(countedNum) ? countedNum - expectedCash : 0;

  const submit = async () => {
    setErr(null);
    if (!Number.isFinite(countedNum) || countedNum < 0) { setErr('Counted cash must be a non-negative number'); return; }
    try {
      await closeShift.mutateAsync({ closingCounted: countedNum, notes: notes.trim() || undefined });
      toast.success(`Shift closed. Variance: ${fmt(variance)}`);
      onClosed();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to close shift');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PowerOff className="h-4 w-4 text-rose-600" /> Close shift
          </DialogTitle>
          <DialogDescription>
            Count the cash in the drawer and enter the total. Variance is recorded in the Z-report.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Opening float</span>
            <span className="font-mono">{fmt(session.openingFloat)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Expected cash (sales − refunds + pay-in − pay-out)</span>
            <span className="font-mono font-bold">{fmt(expectedCash)}</span>
          </div>
        </div>

        <div>
          <Label>Counted cash (UGX)</Label>
          <Input
            type="number"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder="0"
            className="text-right text-xl h-12 font-mono font-bold"
            autoFocus
          />
        </div>

        {Number.isFinite(countedNum) && countedNum >= 0 ? (
          <div
            className={
              'rounded-lg px-3 py-2 text-sm font-bold flex items-center gap-2 ' +
              (variance === 0
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : variance > 0
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-rose-50 text-rose-700 border border-rose-200')
            }
          >
            {variance === 0 ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            Variance: {variance >= 0 ? '+' : ''}{fmt(variance)}
            <span className="ml-auto font-normal text-xs opacity-75">
              {variance === 0 ? 'Drawer balanced' : variance > 0 ? 'Cashier is over' : 'Cashier is short'}
            </span>
          </div>
        ) : null}

        <div>
          <Label>Notes (optional)</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Took UGX 20k for bread run"
          />
        </div>

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={closeShift.isPending} style={{ background: '#dc2626' }}>
            {closeShift.isPending ? 'Closing…' : 'Close shift & print Z'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};