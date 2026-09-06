import React, { useState } from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CartLine } from '@/features/pos/types';
import { useVerifyPin } from './api';

interface Props {
  open: boolean;
  line: CartLine | null;
  onClose: () => void;
  onConfirm: (lineId: string, reason: string) => void;
}

export const VoidItemDialog: React.FC<Props> = ({ open, line, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const verify = useVerifyPin();

  React.useEffect(() => {
    if (!open) { setReason(''); setPin(''); setErr(null); }
  }, [open]);

  if (!line) return null;

  const submit = async () => {
    setErr(null);
    if (!reason.trim()) { setErr('A reason is required'); return; }
    if (!pin) { setErr('PIN is required'); return; }
    try {
      await verify.mutateAsync(pin);
      onConfirm(line.lineId, reason.trim());
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Invalid PIN');
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
            Remove <strong>{line.name}</strong> (×{line.quantity}) from this order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-xs text-slate-500">
            A reason and your PIN are required to void this item.
          </div>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer changed mind, wrong item ordered…"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm resize-none h-20"
          />
          <div className="space-y-2 px-1 py-2">
            <Label className="flex items-center gap-1">
              <KeyRound className="h-3 w-3" /> Your PIN (4–8 digits)
            </Label>
            <Input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••"
              maxLength={8}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          </div>
          {err ? <p className="text-sm text-rose-600">{err}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || !pin || verify.isPending}
            onClick={submit}
          >
            <AlertTriangle className="w-4 h-4 mr-1" /> Void Item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default VoidItemDialog;
