import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { notify } from '@/lib/notify';
import { apiErrorMessage } from '@/lib/api-error';

const PIN_RE = /^\d{4,8}$/;

/**
 * Manager-side POS PIN dialog: set a first PIN, reset a forgotten one, or
 * remove it. Shared by the Staff screen and the HR System Access panel, which
 * hit different routes but the same server-side path (UsersService.setPin).
 *
 * The PIN is typed twice because nobody sees it again: the server returns
 * only "PIN set", never the PIN or its hash.
 */
export function SetPinDialog({
  open,
  onOpenChange,
  personName,
  hasPin,
  pending,
  onSave,
  onClear,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  personName: string;
  hasPin: boolean;
  pending: boolean;
  onSave: (pin: string) => Promise<unknown>;
  onClear: () => Promise<unknown>;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (!open) {
      setPin('');
      setConfirm('');
    }
  }, [open]);

  const valid = PIN_RE.test(pin);
  const matches = pin === confirm;
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{hasPin ? 'Reset' : 'Set'} POS PIN for {personName}</DialogTitle>
          <DialogDescription>
            {hasPin
              ? 'The old PIN stops working immediately. Any PIN lockout is cleared.'
              : 'They sign in to the POS with this PIN. Give it to them in person.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid || !matches) return;
            try {
              await onSave(pin);
              notify.success(hasPin ? 'PIN reset' : 'PIN set');
              onOpenChange(false);
            } catch (err) {
              notify.error(apiErrorMessage(err, 'Could not save the PIN'));
            }
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="new-pin">New PIN</Label>
            <Input
              id="new-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => setPin(digits(e.target.value))}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">4–8 digits.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-pin">Confirm PIN</Label>
            <Input
              id="confirm-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(digits(e.target.value))}
            />
            {confirm.length > 0 && !matches && (
              <p className="text-xs text-rose-700">PINs do not match.</p>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            {hasPin ? (
              <Button
                type="button"
                variant="outline"
                className="text-rose-700"
                disabled={pending}
                onClick={async () => {
                  try {
                    await onClear();
                    notify.success('PIN removed');
                    onOpenChange(false);
                  } catch (err) {
                    notify.error(apiErrorMessage(err, 'Could not remove the PIN'));
                  }
                }}
              >
                Remove PIN
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !valid || !matches}>
                {hasPin ? 'Reset PIN' : 'Set PIN'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
