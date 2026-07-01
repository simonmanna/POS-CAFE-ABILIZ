// Top bar with table picker, type tabs, search, staff badge and logout.
import React from 'react';
import { Coffee, Utensils, Truck, LayoutGrid, Search, LogOut, Maximize2, Minimize2, X, Pause, Zap } from 'lucide-react';
import type { OrderType, Table } from './types';

interface Props {
  table: Table | null;
  orderType: OrderType;
  onTypeChange: (t: OrderType) => void;
  onOpenTablePicker: () => void;
  onClearTable: () => void;
  search: string;
  onSearch: (v: string) => void;
  staffName?: string;
  staffRole?: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onLogout: () => void;
  onOpenHeld?: () => void;
  onOpenCounter?: () => void;
  counterMode?: boolean;
  onExitCounter?: () => void;
  onHold?: (() => void) | null;
}

const TYPE_META: Record<OrderType, { label: string; icon: React.ReactNode }> = {
  DINE_IN: { label: 'Dine in', icon: <Utensils className="h-3.5 w-3.5" /> },
  TAKEAWAY: { label: 'Takeaway', icon: <Coffee className="h-3.5 w-3.5" /> },
  DELIVERY: { label: 'Delivery', icon: <Truck className="h-3.5 w-3.5" /> },
};

const initials = (name?: string) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
};

export const Topbar: React.FC<Props> = ({
  table, orderType, onTypeChange, onOpenTablePicker, onClearTable, search, onSearch,
  staffName, staffRole, fullscreen, onToggleFullscreen, onLogout,
  onOpenHeld, onOpenCounter, counterMode, onExitCounter, onHold,
}) => {
  return (
    <div className="pos-topbar-pro">
      {/* Brand */}
      <div className="pos-brand-pro">
        <Coffee className="h-5 w-5" />
        <span>Cafe POS</span>
      </div>

      {/* Table pill */}
      <button
        type="button"
        className="pos-tbl-pill ml-4"
        onClick={onOpenTablePicker}
        title="Change table"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        {table ? (
          <>
            <span>Table {table.number}{table.zone ? ` · ${table.zone}` : ''}</span>
            {table.mergedTables && table.mergedTables.length > 0 ? (
              <span className="bg-white/30 rounded px-1.5 py-0.5 text-[10px] font-bold">+{table.mergedTables.length}</span>
            ) : null}
            <span className="pos-active-dot" />
          </>
        ) : (
          <span>Select table</span>
        )}
      </button>
      {table && (
        <button
          type="button"
          className="pos-tbl-pill ml-1"
          onClick={onClearTable}
          title="Close current order"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Type tabs */}
      <div className="pos-type-tabs ml-3">
        {(Object.keys(TYPE_META) as OrderType[]).map((t) => (
          <button
            key={t}
            type="button"
            className={'pos-type-tab-pro' + (orderType === t ? ' active' : '')}
            onClick={() => onTypeChange(t)}
          >
            {TYPE_META[t].icon}
            {TYPE_META[t].label}
          </button>
        ))}
      </div>

      {/* Held orders */}
      <button
        type="button"
        className="pos-tbl-pill"
        onClick={onOpenHeld}
        title="Open held orders"
        style={{ background: counterMode ? 'rgba(245,158,11,.25)' : undefined, borderColor: counterMode ? 'rgba(245,158,11,.5)' : undefined }}
      >
        <Pause className="h-3.5 w-3.5" /> Held
      </button>
      {counterMode ? (
        <button
          type="button"
          className="pos-tbl-pill"
          onClick={onExitCounter}
          title="Exit counter mode"
          style={{ background: 'rgba(236,72,153,.25)', borderColor: 'rgba(236,72,153,.5)' }}
        >
          <Zap className="h-3.5 w-3.5" /> Counter
        </button>
      ) : (
        <button
          type="button"
          className="pos-tbl-pill"
          onClick={onOpenCounter}
          title="Start a quick counter order (no table)"
        >
          <Zap className="h-3.5 w-3.5" /> Counter
        </button>
      )}
      {/* Search */}
      <div className="pos-searchbar-pro ml-4">
        <Search className="pos-search-icon h-4 w-4" />
        <input
          type="text"
          placeholder="Search menu…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          autoFocus
        />
        <span className="pos-search-kbd">/</span>
      </div>

      {onHold ? (
        <button type="button" className="pos-tbl-pill" onClick={onHold} title="Hold / park this order" style={{ background: 'rgba(245,158,11,.25)', borderColor: 'rgba(245,158,11,.5)' }}>
          <Pause className="h-3.5 w-3.5" /> Hold
        </button>
      ) : null}
      <div className="flex-1" />

      {/* Staff badge */}
      <div className="pos-staff-pill">
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
      <button
        type="button"
        className="pos-icon-btn ml-1"
        onClick={onLogout}
        title="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
};
