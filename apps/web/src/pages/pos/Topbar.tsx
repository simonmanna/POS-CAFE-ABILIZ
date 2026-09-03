import React from 'react';
import {
  Search,
  Maximize2,
  Minimize2,
  LogOut,
  BarChart3,
  PowerOff,
  User as UserIcon,
  LayoutGrid,
  ClipboardList,
  PowerCircle,
  PanelLeft,
  PanelLeftClose,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { useSidebarStore } from '@/lib/sidebar.store';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  onOpenHeldOrders?: () => void;
  /** Odoo-style Orders panel opener + live count for the nav badge. */
  onOpenOrders?: () => void;
  ordersCount?: number;
  /** Dine-in: show the table-selector button; takeaway/delivery: hide it. */
  orderType?: 'dine-in' | 'takeaway' | 'delivery';
  /** Extra nodes pinned to the right cluster (e.g. the offline indicator). */
  rightExtras?: React.ReactNode;
  /** Logged-in app-level user (first/last/email/role) for the profile menu. */
  user?: { firstName?: string | null; lastName?: string | null; email?: string | null; role?: string | null } | null;
}

const initials = (name?: string) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
};

export const Topbar: React.FC<Props> = ({
  search,
  onSearch,
  onOpenReports,
  onOpenShift,
  onCloseShift,
  onOpenTableSelector,
  activeTableLabel,
  staffName,
  staffRole,
  session,
  fullscreen,
  onToggleFullscreen,
  onLogout,
  onUserChanged,
  onOpenHeldOrders,
  onOpenOrders,
  ordersCount = 0,
  orderType,
  rightExtras,
  user,
}) => {
  const shiftOpen = !!session && session.status === 'open';
  const collapsed = useSidebarStore((s) => s.collapsed);

  // App-level branch switcher (mirrors the app-shell header).
  const { currentBranchId, setCurrentBranch } = useAuthStore();
  const { data: branchData } = useQuery<{ data: { id: string; code: string; name: string }[] }>({
    queryKey: ['branches-switch'],
    queryFn: async () => (await api.get('/branches', { params: { pageSize: 200 } })).data,
    enabled: !!user,
  });
  const branches = branchData?.data ?? [];
  const onSelectBranch = async (value: string) => {
    const id = value === '__all__' ? null : value;
    setCurrentBranch(id);
    try {
      await api.patch('/organizations/me/branch', { defaultBranchId: id });
    } catch {
      notify.error('Failed to switch branch');
    }
  };

  return (
    <div className="pos-topbar-pro">

      {/* Sidebar expand/collapse (shared with AppShell via store) */}
      <button
        type="button"
        className="pos-icon-btn"
        onClick={() => useSidebarStore.getState().toggle()}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      {/* Shift indicator pill */}
      <button
        type="button"
        className={`pos-nav-btn ${shiftOpen ? 'pos-nav-btn--open' : 'pos-nav-btn--closed'}`}
        onClick={shiftOpen ? onCloseShift : onOpenShift}
        title={shiftOpen ? 'Close current shift' : 'Open shift to start selling'}
      >
        {shiftOpen ? <PowerCircle className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
        {shiftOpen ? (
          <>
            <span>Shift Close</span>
            <span className="pos-active-dot" />
          </>
        ) : (
          <span>Open Shift</span>
        )}
      </button>

      {/* Orders (Odoo-style multi-order panel) */}
      {onOpenOrders && (
        <button
          type="button"
          className="pos-nav-btn"
          onClick={onOpenOrders}
          title="Open orders — resume any order"
        >
          <ClipboardList className="h-4 w-4" />
          <span>Orders</span>
          {ordersCount > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-white/90 text-slate-900 text-[11px] font-bold leading-none">
              {ordersCount}
            </span>
          ) : null}
        </button>
      )}

      {/* Held Orders (legacy) */}
      {onOpenHeldOrders && (
        <button
          type="button"
          className="pos-nav-btn"
          onClick={onOpenHeldOrders}
          title="View held orders"
        >
          <ClipboardList className="h-4 w-4" />
          <span>Held Orders</span>
        </button>
      )}

      {/* Table selector (dine-in only) */}
      {onOpenTableSelector && orderType === 'dine-in' && (
        <>
        <button
          type="button"
          className={`pos-nav-btn ${activeTableLabel ? 'pos-nav-btn--open' : ''}`}
          onClick={onOpenTableSelector}
          title="Choose a table"
        >
          <LayoutGrid className="h-4 w-4" />
          <span>{'Tables'}</span>
          {activeTableLabel ? <span className="pos-active-dot" /> : null}
        </button>
        <span>{activeTableLabel}</span>
                  </>
      )}

      {/* Reports */}
      <button type="button" className="pos-nav-btn" onClick={onOpenReports} title="X / Z reports + sales analytics">
        <BarChart3 className="h-4 w-4" />
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

      {/* Right-cluster extras (e.g. offline indicator) */}
      {rightExtras ? <div className="flex items-center mr-1">{rightExtras}</div> : null}

      {/* App-level user profile menu (mirrors the app-shell header) */}
      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full px-1.5 py-1 outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-semibold text-white"
                aria-hidden="true"
              >
                {(user.firstName?.[0] ?? '').toUpperCase()}
                {(user.lastName?.[0] ?? '').toUpperCase()}
              </span>
              <span className="hidden text-sm font-medium text-white sm:inline">
                {user.firstName}
              </span>
              <ChevronDown className="hidden h-4 w-4 text-white/80 sm:inline" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-foreground">
                {user.firstName} {user.lastName}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {user.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Active Branch
              </label>
              <Select value={currentBranchId ?? '__all__'} onValueChange={onSelectBranch}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All branches</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} className="cursor-pointer text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Sign Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Keep the compact logout icon as a fallback when no app-level user is present */}
      {!user && (
        <>
          {/* Staff badge (POS-only user, no app account) */}
          <div className="pos-staff-pill">
            <UserIcon className="h-3.5 w-3.5" />
            <span className="pos-staff-avatar">{initials(staffName)}</span>
            <span>{staffName || 'Guest'}</span>
            {staffRole ? <span className="opacity-70">· {staffRole}</span> : null}
          </div>
          <UserSwitcher onUserChanged={onUserChanged} />
        </>
      )}

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