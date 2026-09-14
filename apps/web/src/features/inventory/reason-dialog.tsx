import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';

interface ReasonDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  destructive?: boolean;
  placeholder?: string;
  onConfirm: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Asks for a mandatory written reason before an irreversible stock action
 * (posted reversal, force-approving over stock drift). The reason is stored on
 * the document and in the audit trail, so an empty one is never accepted.
 */
export function ReasonDialog({
  open, title, description, confirmLabel, pendingLabel, pending, destructive, placeholder, onConfirm, onOpenChange,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{description}</div></DialogDescription>}
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="reason-dialog-text">
            Reason <span className="text-destructive">*</span>
          </label>
          <Textarea
            id="reason-dialog-text"
            autoFocus
            rows={3}
            value={reason}
            placeholder={placeholder ?? 'Why is this needed? This is kept in the audit trail.'}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Back</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={!trimmed || pending}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? (pendingLabel ?? 'Working…') : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** True when the API refused because an adjustment's stock moved after it was created. */
export const isStockDriftError = (e: any): boolean =>
  e?.response?.status === 409 && e?.response?.data?.code === 'ADJUSTMENT_STOCK_DRIFT';
