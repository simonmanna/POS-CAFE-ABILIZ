import React, { useEffect, useState } from 'react';
import { KeyRound, MessageSquareWarning, ShieldCheck, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useVerifyPin } from './api';

interface Props {
  open: boolean;
  title?: string;
  description?: string;
  /** Collect a mandatory reason alongside the PIN. Defaults to true. */
  requireReason?: boolean;
  /** Label above the reason box. */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  onClose: () => void;
  /** Called once the PIN verifies. Receives the trimmed reason when one is collected. */
  onVerified: (reason: string) => void | Promise<void>;
}

export const PinConfirmDialog: React.FC<Props> = ({
  open,
  title,
  description,
  requireReason = true,
  reasonLabel,
  reasonPlaceholder,
  onClose,
  onVerified,
}) => {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const verify = useVerifyPin();

  useEffect(() => {
    if (!open) { setPin(''); setReason(''); setErr(null); setBusy(false); }
  }, [open]);

  const submit = async () => {
    setErr(null);
    if (requireReason && !reason.trim()) { setErr('A reason is required'); return; }
    if (!pin) { setErr('PIN is required'); return; }
    try {
      setBusy(true);
      await verify.mutateAsync(pin);
      await onVerified(reason.trim());
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Invalid PIN');
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || verify.isPending || !pin || (requireReason && !reason.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-amber-600" />
            {title ?? 'Confirm your PIN'}
          </DialogTitle>
          <DialogDescription>
            {description ?? 'Enter a reason and your PIN to confirm this action.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-1 py-2">
          {requireReason ? (
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                <MessageSquareWarning className="h-3 w-3" /> {reasonLabel ?? 'Reason'}
              </Label>
              <textarea
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPlaceholder ?? 'e.g. Customer changed their mind, wrong item ordered…'}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm resize-none h-20"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              <KeyRound className="h-3 w-3" /> Your PIN (4–8 digits)
            </Label>
            <Input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••"
              maxLength={8}
              autoFocus={!requireReason}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          </div>
        </div>

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            <X className="h-4 w-4 mr-1" /> Cancel
          </Button>
          <Button onClick={submit} disabled={blocked} style={{ background: '#f59e0b' }}>
            {busy || verify.isPending ? 'Verifying…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
