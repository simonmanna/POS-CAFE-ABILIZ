import React, { useState } from 'react';
import { AlertTriangle, ChefHat } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { CartLine } from '@/features/pos/types';

interface Props {
  open: boolean;
  line: CartLine | null;
  /** True when this line has already been sent to the kitchen — the server will
   *  demand a manager approval, so say so before the cashier commits. */
  sentToKitchen?: boolean;
  onClose: () => void;
  onConfirm: (lineId: string, reason: string) => void | Promise<void>;
}

/**
 * A-016 — collect the reason for taking a line off an order.
 *
 * The old dialog asked for the cashier's own PIN and then removed the line
 * locally: the PIN authorised nothing, and the removal reached the server as an
 * ordinary auto-save that left no record. Voiding now goes through
 * `DELETE /pos/orders/:id/items/:itemId`, which records who, why and how much,
 * pulls the line off the kitchen board, and refuses outright unless a manager
 * approves a line the kitchen has already been told to cook. This dialog
 * therefore collects the one thing the server cannot infer — the reason — and
 * the manager PIN is prompted afterwards, only when it is genuinely required.
 */
export const VoidItemDialog: React.FC<Props> = ({ open, line, sentToKitchen, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  React.useEffect(() => {
    if (!open) { setReason(''); setErr(null); setBusy(false); }
  }, [open]);

  if (!line) return null;

  const submit = async () => {
    setErr(null);
    if (!reason.trim()) { setErr('A reason is required'); return; }
    try {
      setBusy(true);
      await onConfirm(line.lineId, reason.trim());
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Could not void the item');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-600">
            <AlertTriangle className="w-4 h-4" /> Void Item
          </DialogTitle>
          <DialogDescription>
            Take <strong>{line.name}</strong> (×{line.quantity}) off this order. The item stays on
            the order's record with your name against it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {sentToKitchen ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800">
              <ChefHat className="h-4 w-4 shrink-0" />
              <span>The kitchen has already been sent this item. A manager PIN is required next.</span>
            </div>
          ) : null}
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer changed their mind, wrong item ordered…"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm resize-none h-20"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          {err ? <p className="text-sm text-rose-600">{err}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || busy}
            onClick={submit}
          >
            <AlertTriangle className="w-4 h-4 mr-1" /> {busy ? 'Voiding…' : 'Void Item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default VoidItemDialog;
