import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePosChangePassword } from '@/features/pos/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PosChangePasswordDialog({ open, onOpenChange }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const changePassword = usePosChangePassword();

  const reset = () => { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const mismatch = newPassword !== confirmPassword;
  const canSubmit = currentPassword.length >= 1 && newPassword.length >= 8 && !mismatch;

  const handleSubmit = async () => {
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      reset();
      onOpenChange(false);
    } catch {
      /* toast handled by interceptor */
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>Confirm with your current login password, then set a new one. Changing it signs other devices out.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Your login password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
            />
            {mismatch && confirmPassword.length > 0 && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || changePassword.isPending}>
            {changePassword.isPending ? 'Saving…' : 'Change Password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
