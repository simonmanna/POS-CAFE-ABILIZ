/**
 * POS Logoff pill — sits beside the Online/Offline indicator in the Topbar.
 *
 * Ends the current POS PIN session WITHOUT closing the shift or logging out
 * of the app: the cart auto-saves to the table/draft so the order can be
 * resumed later (Orders panel / table), and the terminal returns to the
 * staff PIN login screen where another waiter can sign in.
 */
import React from 'react';
import { LogOut } from 'lucide-react';
import { usePosAuthStore } from '@/features/pos/pos-auth.store';

interface Props {
  /** Called after the POS user is cleared — terminals refresh their state. */
  onLoggedOff?: () => void;
}

export const PosLogoffButton: React.FC<Props> = ({ onLoggedOff }) => {
  const user = usePosAuthStore((s) => s.user);
  if (!user) return null;

  const handleLogoff = () => {
    usePosAuthStore.getState().logout();
    onLoggedOff?.();
  };

  return (
    <button
      type="button"
      onClick={handleLogoff}
      title="Log off this POS session — orders are saved and can be resumed later. Another staff member can sign in."
      className="pos-nav-btn pos-nav-btn--logoff"
    >
      <LogOut className="h-4 w-4" />
      <span>Log off</span>
    </button>
  );
};

export default PosLogoffButton;
