/**
 * User Switcher — quick POS user switch from the topbar.
 *
 * Shows current user + "Switch User" and "Logout" buttons.
 * "Switch User" opens the PIN login screen for a different cashier.
 */
import React, { useState } from 'react';
import { LogOut, Repeat } from 'lucide-react';
import { usePosAuthStore } from '@/features/pos/pos-auth.store';
import PosLoginScreen from './PosLoginScreen';

interface Props {
  onUserChanged: () => void;
}

export const UserSwitcher: React.FC<Props> = ({ onUserChanged }) => {
  const user = usePosAuthStore((s) => s.user);
  const logout = usePosAuthStore((s) => s.logout);
  const [switching, setSwitching] = useState(false);

  if (!user) return null;

  const initials = ((user.firstName?.[0] || '') + (user.lastName?.[0] || '')).toUpperCase() || '?';

  const handleSwitch = () => {
    logout();
    setSwitching(true);
  };

  const handleLogout = () => {
    logout();
    onUserChanged();
  };

  return (
    <>
      {/* User badge — shown inline in topbar */}
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/10 border border-white/15">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-[10px] font-extrabold text-white">
          {initials}
        </div>
        <span className="text-xs font-semibold text-white">{user.firstName}</span>
        <button
          onClick={handleSwitch}
          className="ml-1 p-0.5 rounded hover:bg-white/15 text-slate-300 hover:text-white"
          title="Switch user"
        >
          <Repeat className="h-3 w-3" />
        </button>
        <button
          onClick={handleLogout}
          className="p-0.5 rounded hover:bg-white/15 text-slate-300 hover:text-white"
          title="Logout from POS"
        >
          <LogOut className="h-3 w-3" />
        </button>
      </div>

      {/* Full-screen PIN login when switching */}
      {switching && <PosLoginScreen onLoggedIn={() => { setSwitching(false); onUserChanged(); }} />}
    </>
  );
};
