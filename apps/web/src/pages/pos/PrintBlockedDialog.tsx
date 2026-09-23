import React from 'react';
import { Printer, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  /** What the cashier tried to print: "Bill", "KOT", … */
  kind: string;
  /** Names of the cart lines still sitting at quantity 0. */
  names: string;
  onClose: () => void;
}

/**
 * Printed at the door of every pre-payment print action (Bill / KOT / Add Bill):
 * a line parked at quantity 0 is an unfinished edit, so nothing may go to the
 * printer until it is given a real quantity or voided. The dialog only tells —
 * the print is refused, the cart is left exactly as it was.
 */
export const PrintBlockedDialog: React.FC<Props> = ({ open, kind, names, onClose }) => (
  <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
    <DialogContent className="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Printer className="h-4 w-4 text-rose-600" />
          Cannot print {kind}
        </DialogTitle>
        <DialogDescription>
          An item on this order has no quantity, so there is nothing valid to print. Set a quantity (or void the line) and try again.
        </DialogDescription>
      </DialogHeader>
      {names ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          Set a quantity for: {names}
        </div>
      ) : null}
      <DialogFooter>
        <Button onClick={onClose} style={{ background: '#16a34a' }}>
          <X className="h-4 w-4 mr-1" /> OK
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
