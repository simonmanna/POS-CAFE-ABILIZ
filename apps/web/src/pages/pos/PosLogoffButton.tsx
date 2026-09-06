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
      className="pos-tbl-pill !bg-rose-500/20 !border-rose-400/50 hover:!bg-rose-500/30"
    >
      <LogOut className="h-3.5 w-3.5 text-rose-200" />
      <span className="text-rose-100">Log off</span>
    </button>
  );
};

export default PosLogoffButton;
