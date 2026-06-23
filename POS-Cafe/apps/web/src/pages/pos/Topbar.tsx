// Top bar — shift status, held orders, search, fullscreen, table selector,
// POS user switcher.
import React from 'react';
import { Coffee, Search, Maximize2, Minimize2, LogOut, BarChart3, Power, PowerOff, User as UserIcon, LayoutGrid } from 'lucide-react';
import type { CashSession } from './types';
import { UserSwitcher } from './UserSwitcher';

interface Props {
  search: string;
  onSearch: (v: string) => void;
  onOpenReports: () => void;
  onOpenShift: () => void;
  onCloseShift: () => void;
  onOpenTableSelector?: () => void;
  activeTableLabel?: string | null;
  staffName?: string;
  staffRole?: string;
  session: CashSession | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onLogout: () => void;
  onUserChanged: () => void;
  /** Optional content rendered to the LEFT of the staff pill (e.g. the
   *  P11 OfflineIndicator that shows online/offline + queued-sales count). */
  rightExtras?: React.ReactNode;
  posMode?: 'tables' | 'counter';
  onChangeMode?: (mode: 'tables' | 'counter') => void;
}

const initials = (name?: string) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
};

export const Topbar: React.FC<Props> = ({
  search, onSearch, onOpenReports, onOpenShift, onCloseShift,
  onOpenTableSelector, activeTableLabel,
  staffName, staffRole, session, fullscreen, onToggleFullscreen, onLogout, onUserChanged, rightExtras,
  posMode, onChangeMode,
}) => {
  const shiftOpen = !!session && session.status === 'open';
  return (
    <div className="pos-topbar-pro">
      <div className="pos-brand-pro">
        <Coffee className="h-5 w-5" />
        <span>Cafe POS</span>
      </div>

      {/* Shift indicator pill */}
      <button
        type="button"
        className="pos-tbl-pill"
        onClick={shiftOpen ? onCloseShift : onOpenShift}
        title={shiftOpen ? 'Close current shift' : 'Open shift to start selling'}
        style={{
          background: shiftOpen ? 'rgba(34, 197, 94, .25)' : 'rgba(239, 68, 68, .25)',
          borderColor: shiftOpen ? 'rgba(34, 197, 94, .5)' : 'rgba(239, 68, 68, .5)',
        }}
      >
        {shiftOpen ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
        {shiftOpen ? (
          <>
            <span>Shift open</span>
            <span className="pos-active-dot" />
          </>
        ) : (
          <span>Shift closed</span>
        )}
      </button>

      {/* POS Mode: Tables vs Counter */}
      {onChangeMode ? (
        <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
          {([
            { mode: 'tables' as const, label: 'Tables', icon: LayoutGrid },
            { mode: 'counter' as const, label: 'Counter', icon: Coffee },
          ]).map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChangeMode(mode)}
              title={label}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold tracking-wide transition-all ${
                posMode === mode
                  ? 'bg-white shadow-sm text-indigo-700'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Table selector (ADR-012) */}
      {onOpenTableSelector ? (
        <button
          type="button"
          className="pos-tbl-pill"
          onClick={onOpenTableSelector}
          title="Choose a table"
          style={{
            background: activeTableLabel ? 'rgba(14, 165, 233, .25)' : undefined,
            borderColor: activeTableLabel ? 'rgba(14, 165, 233, .6)' : undefined,
          }}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          <span>{activeTableLabel ?? 'No table'}</span>
          {activeTableLabel ? <span className="pos-active-dot" /> : null}
        </button>
      ) : null}

      {/* Reports */}
      <button type="button" className="pos-tbl-pill" onClick={onOpenReports} title="X / Z reports + sales analytics">
        <BarChart3 className="h-3.5 w-3.5" />
        <span>Reports</span>
      </button>

      {/* Search */}
      <div className="pos-searchbar-pro ml-2">
        <Search className="pos-search-icon h-4 w-4" />
        <input
          type="text"
          placeholder="Search menu or scan barcode…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          autoFocus
        />
        <span className="pos-search-kbd">/</span>
      </div>

      <div className="flex-1" />

      {/* Optional extras (P11 offline indicator, etc.) */}
      {rightExtras}

      {/* POS User Switcher — PIN‑logged cashier */}
      <UserSwitcher onUserChanged={onUserChanged} />

      {/* Staff badge */}
      <div className="pos-staff-pill">
        <UserIcon className="h-3.5 w-3.5" />
        <span className="pos-staff-avatar">{initials(staffName)}</span>
        <span>{staffName || 'Guest'}</span>
        {staffRole ? <span className="opacity-70">· {staffRole}</span> : null}
      </div>

      <button
        type="button"
        className="pos-icon-btn ml-2"
        onClick={onToggleFullscreen}
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button type="button" className="pos-icon-btn ml-1" onClick={onLogout} title="Sign out">
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
};