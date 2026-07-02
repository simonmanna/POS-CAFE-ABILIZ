import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Building2,
  Users,
  Package,
  Receipt,
  FileMinus,
  HandCoins,
  FileText,
  Banknote,
  Clock,
  Scale,
  Settings as SettingsIcon,
  Moon,
  Sun,
  LogOut,
  Menu,
  Search,
  ShoppingCart,
  Truck,
  FilePlus2,
  Coffee,
  Tag,
  BarChart3,
  UserCog,
  Shield,
  ClipboardList,
  PanelLeftClose,
  PanelLeft,
  BookOpen,
  BookText,
  ScrollText,
  Smartphone,
} from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { useTheme } from '@/components/theme-provider';
import { GlobalSearch } from '@/components/global-search';
import { NotificationsBell } from '@/components/notifications-bell';
import { LanguageSwitcher } from '@/components/language-switcher';
import { PushBootstrap } from '@/components/push-bootstrap';
import { ThemePicker } from '@/components/theme-picker';
import { useTranslation } from 'react-i18next';
import { useSidebarTheme } from '@/lib/sidebar-theme';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: string;
  badge?: string;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    title: 'POS',
    items: [
      { to: '/pos/terminal', label: 'POS Terminal', icon: Coffee, permission: PERMISSIONS.pos.checkout },
      { to: '/pos/cash-registers', label: 'Cash Registers', icon: Banknote, permission: PERMISSIONS.cashSession.read },
      { to: '/pos/reports', label: 'POS Reports', icon: BarChart3, permission: PERMISSIONS.pos.reports },
    ],
  },
  {
    title: 'Master Data',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, permission: PERMISSIONS.partners.view },
      { to: '/suppliers', label: 'Suppliers', icon: Building2, permission: PERMISSIONS.partners.view },
      { to: '/products', label: 'Products', icon: Package, permission: PERMISSIONS.products.view },
      { to: '/menu', label: 'Menu', icon: Coffee, permission: PERMISSIONS.menu.view },
      { to: '/tables', label: 'Tables', icon: Coffee, permission: PERMISSIONS.menu.view },
      { to: '/menu/modifiers', label: 'Modifiers', icon: Tag, permission: PERMISSIONS.menu.view },
      { to: '/menu/accompaniments', label: 'Accompaniments', icon: Tag, permission: PERMISSIONS.menu.view },
    ],
  },
  {
    title: 'Sales',
    items: [
      { to: '/invoices', label: 'Sales/Invoices', icon: Receipt, permission: PERMISSIONS.invoice.read },
      { to: '/credit-notes', label: 'Credit Notes', icon: FileMinus, permission: PERMISSIONS.creditNote.read },
      { to: '/payments', label: 'Receipts', icon: HandCoins, permission: PERMISSIONS.payment.read },
      { to: '/ar-aging', label: 'AR Aging', icon: Clock, permission: PERMISSIONS.report.ar },
    ],
  },
  {
    title: 'Expenses',
    items: [
      { to: '/expenses', label: 'Expenses', icon: FileText, permission: PERMISSIONS.expense.read },
      { to: '/expenses/categories', label: 'Expense Categories', icon: Tag, permission: PERMISSIONS.expense.read },
      { to: '/expenses/reports', label: 'Expense Reports', icon: BarChart3, permission: PERMISSIONS.expense.read },
      { to: '/supplier-payments', label: 'Supplier Payments', icon: Banknote, permission: PERMISSIONS.payment.read },
    ],
  },
  {
    title: 'Accounting',
    items: [
      { to: '/accounts/cash-accounts', label: 'Financial Accounts', icon: Banknote, permission: PERMISSIONS.account.read },
      { to: '/accounts', label: 'Chart of Accounts', icon: BookOpen, permission: PERMISSIONS.account.read },
      { to: '/accounts/cash-registers', label: 'Cash Registers', icon: Smartphone, permission: 'cash_register:read' },
      { to: '/journals', label: 'Journals', icon: BookText, permission: PERMISSIONS.journal.read },
      { to: '/journal-entries', label: 'Journal Entries', icon: ScrollText, permission: PERMISSIONS.journalEntry.read },
      { to: '/trial-balance', label: 'Trial Balance', icon: Scale, permission: PERMISSIONS.report.accounting },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { to: '/inventory', label: 'Stock Levels', icon: Package, permission: 'inventory:read' },
      { to: '/inventory/ledger', label: 'Stock Ledger', icon: ScrollText, permission: 'inventory:read' },
      { to: '/inventory/count', label: 'Stock Count', icon: ClipboardList, permission: 'inventory_count:read' },
      { to: '/inventory/adjustments', label: 'Stock Adjustments', icon: Scale, permission: 'inventory:move' },
    ],
  },
  {
    title: 'Purchasing',
    items: [
      { to: '/procurement/purchase-orders', label: 'Purchase Orders', icon: ShoppingCart, permission: 'purchase_order:read' },
      { to: '/procurement/goods-receipts', label: 'Goods Receipts', icon: Truck, permission: 'goods_receipt:read' },
      // { to: '/procurement/three-way-match', label: '3-Way Match', icon: Scale, permission: 'three_way_match:read' },
      { to: '/procurement/debit-notes', label: 'Debit Notes', icon: FilePlus2, permission: 'debit_note:read' },
      { to: '/supplier-payments', label: 'Supplier Payments', icon: Banknote, permission: 'payment:read' },
    ],
  },
  // {
  //   title: 'Platform',
  //   items: [
  //     { to: '/approvals', label: 'Approvals', icon: ShieldCheck, permission: PERMISSIONS.auditLog.read },
  //     { to: '/recurring', label: 'Recurring', icon: Repeat },
  //     { to: '/webhooks', label: 'Webhooks', icon: Webhook },
  //     { to: '/files', label: 'Files', icon: Boxes },
  //     { to: '/modules', label: 'Modules', icon: Building2 },
  //   ],
  // },
  {
    title: 'System',
    items: [
      { to: '/staff', label: 'Staff', icon: UserCog, permission: PERMISSIONS.user.read },
      { to: '/staff/roles', label: 'Roles & Permissions', icon: Shield, permission: PERMISSIONS.role.read },
      { to: '/settings', label: 'Settings', icon: SettingsIcon, permission: PERMISSIONS.setting.read },
    ],
  },
];

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const { theme: sb } = useSidebarTheme();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const clear = useAuthStore((s) => s.clear);
  const org = useAuthStore((s) => s.organization);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Auto-collapse sidebar on POS terminal, restore on other pages.
  useEffect(() => {
    setSidebarCollapsed(location.pathname.startsWith('/pos/terminal'));
  }, [location.pathname]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close mobile drawer on navigation.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const allItems = NAV_SECTIONS.flatMap((s) => s.items);
  const current =
    allItems.find(
      (n) =>
        n.to !== '/' &&
        (location.pathname === n.to || location.pathname.startsWith(`${n.to}/`)),
    )?.label ?? (location.pathname === '/' ? 'Dashboard' : '');

  const logout = () => {
    clear();
    navigate('/login', { replace: true });
  };

  // ── Sidebar rendering: themed background, brand tile, themed nav items ──
  const renderNav = (onItemClick?: () => void, collapsed = false) => {
    return (
      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-1">
        {NAV_SECTIONS.map((section, idx) => {
          const items = section.items.filter(
            (i) => !i.permission || hasPermission(i.permission),
          );
          if (items.length === 0) return null;
          return (
            <div key={idx} className="space-y-0.5">
              {section.title && !collapsed && (
                <p
                  className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: sb.sidebarMuted }}
                >
                  {section.title}
                </p>
              )}
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onItemClick}
                    className={() =>
                      cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-all duration-150',
                        collapsed && 'justify-center px-2',
                      )
                    }
                    style={({ isActive }) => ({
                      color: isActive ? sb.sidebarActive : sb.sidebarText,
                      background: isActive ? sb.sidebarActiveBg : 'transparent',
                      fontWeight: isActive ? 600 : 400,
                    })}
                    onMouseEnter={(e) => {
                      const a = (e.currentTarget as HTMLElement);
                      if (!a.style.background || a.style.background === 'transparent' || a.style.background === '') {
                        a.style.background = sb.sidebarHover;
                      }
                    }}
                    onMouseLeave={(e) => {
                      const el = (e.currentTarget as HTMLElement);
                      el.style.background = '';
                    }}
                    title={collapsed ? item.label : undefined}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span
                            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full"
                            style={{ background: sb.sidebarActiveBar }}
                          />
                        )}
                        <Icon className="h-4 w-4 shrink-0" style={{ width: 16, height: 16 }} />
                        {!collapsed && <span className="flex-1 truncate tracking-[0.01em]">{item.label}</span>}
                        {item.badge && !collapsed && (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
                            style={{ background: sb.badgeBg, minWidth: 18, textAlign: 'center', lineHeight: 'tight' }}
                          >
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </nav>
    );
  };

  // ── Brand tile + section heading text inside the sidebar ──
  const sidebarInner = (collapsed = false) => {
    const toggle = () => setSidebarCollapsed((c) => !c);
    return (
      <div className="flex h-full flex-col" style={{ background: sb.sidebar }}>
        {/* Brand Header */}
        <div
          className="flex h-[58px] shrink-0 items-center gap-2 px-4"
          style={{ borderBottom: `1px solid ${sb.sidebarBorder}` }}
        >
          <div
            className="flex shrink-0 items-center justify-center rounded-xl"
            style={{
              width: 34,
              height: 34,
              background: sb.brandBg,
              border: '1px solid rgba(255,255,255,0.22)',
            }}
          >
            <Coffee style={{ width: 18, height: 18, color: '#fff' }} />
          </div>
          {!collapsed && (
            <div className="ml-1 flex flex-1 flex-col leading-none">
              <span style={{ color: '#fff', fontWeight: 700, fontSize: 16, letterSpacing: '-0.3px' }}>
                {org?.name ?? 'Cafe POS'}
              </span>
              <span
                style={{
                  color: sb.sidebarMuted,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginTop: 2,
                }}
              >
                Point of Sale
              </span>
            </div>
          )}
          <button
            onClick={toggle}
            className="ml-auto flex shrink-0 items-center justify-center rounded-lg p-1 transition-colors hover:bg-white/10"
            style={{ color: sb.sidebarMuted }}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        {renderNav(() => setMobileOpen(false), collapsed)}

        {/* Bottom section: settings + sign out, themed like the sidebar */}
        <div className="space-y-0.5 p-2" style={{ borderTop: `1px solid ${sb.sidebarBorder}` }}>
          <NavLink
            to="/settings"
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-all',
              collapsed && 'justify-center px-2',
            )}
            style={({ isActive }) => ({
              color: isActive ? sb.sidebarActive : sb.sidebarMuted,
              background: isActive ? sb.sidebarActiveBg : 'transparent',
            })}
            title={collapsed ? 'Settings' : undefined}
          >
            <SettingsIcon style={{ width: 15, height: 15 }} />
            {!collapsed && <span>Settings</span>}
          </NavLink>
          <button
            onClick={logout}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-all',
              collapsed && 'justify-center px-2',
            )}
            style={{ color: sb.sidebarMuted }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.15)';
              (e.currentTarget as HTMLElement).style.color = '#fca5a5';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.color = sb.sidebarMuted;
            }}
            title={collapsed ? 'Sign Out' : undefined}
          >
            <LogOut style={{ width: 15, height: 15 }} />
            {!collapsed && <span>Sign Out</span>}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col transition-all duration-200 md:flex print:hidden',
          sidebarCollapsed ? 'w-16' : 'w-60',
        )}
        style={{ background: sb.sidebar }}
      >
        {sidebarInner(sidebarCollapsed)}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col shadow-xl">
            {sidebarInner(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-11 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur print:hidden md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <PanelLeft className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="truncate text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{current}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 sm:inline-flex"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="h-4 w-4" />
              <span className="text-xs text-muted-foreground">Search</span>
              <kbd className="ml-2 hidden rounded border bg-muted px-1.5 text-[10px] font-medium lg:inline">
                ⌘K
              </kbd>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="sm:hidden"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
            >
              <Search className="h-5 w-5" />
            </Button>
            <NotificationsBell />
            <LanguageSwitcher />
            <ThemePicker />
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode">
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.firstName}
            </span>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOut className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">{t('auth.signOut')}</span>
            </Button>
          </div>
        </header>

        <main
          className={`flex-1 overflow-auto ${
            location.pathname.startsWith('/pos/terminal') ? 'p-1 md:p-1' : 'p-1 md:p-1'
          }`}
        >
          <Outlet />
        </main>
      </div>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <PushBootstrap />
    </div>
  );
}