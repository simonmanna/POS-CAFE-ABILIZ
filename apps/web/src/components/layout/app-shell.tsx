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
  LogOut,
  Menu,
  ShoppingCart,
  Truck,
  FilePlus2,
  Coffee,
  Tag,
  BarChart3,
  UserCog,
  Shield,
  ShieldCheck,
  ClipboardList,
  ClipboardCheck,
  PanelLeftClose,
  PanelLeft,
  BookOpen,
  BookText,
  ScrollText,
  Smartphone,
  MapPin,
  Layers,
  Link2,
  Landmark,
  HardDrive,
  Ruler,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  History,
  CalendarDays,
  CalendarHeart,
  Briefcase,
  FileClock,
  Wallet,
  Percent,
  Lock,
  Factory,
  Handshake,
  Wrench,
  Timer,
  Boxes,
  ChefHat,
  UtensilsCrossed,
  CalendarClock,
  ChevronDown,
} from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { GlobalSearch } from '@/components/global-search';
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
  /** Per-item feature gate, resolved the same way as section flags. */
  flag?: 'VITE_ENABLE_BEVERAGE' | 'VITE_ENABLE_ASSETS' | 'VITE_ENABLE_TASKS' | 'VITE_ENABLE_MANUFACTURING' | 'VITE_ENABLE_RENTAL' | 'VITE_ENABLE_REPAIR' | 'VITE_ENABLE_HR' | 'VITE_ENABLE_ORDERS';
}

interface NavSection {
  title?: string;
  items: NavItem[];
  /**
   * Opt-in section, mirroring the API's ENABLE_* module gates. This is the
   * second layer only — the API decides what actually runs. Hiding a section
   * here without gating the module server-side would leave its routes, crons
   * and boot hooks live.
   */
  flag?: 'VITE_ENABLE_BEVERAGE' | 'VITE_ENABLE_ASSETS' | 'VITE_ENABLE_TASKS' | 'VITE_ENABLE_MANUFACTURING' | 'VITE_ENABLE_RENTAL' | 'VITE_ENABLE_REPAIR' | 'VITE_ENABLE_HR' | 'VITE_ENABLE_ORDERS';
}

const flagEnabled = (flag?: string): boolean =>
  !flag || (import.meta.env as Record<string, string | undefined>)[flag] === 'true';

const NAV_SECTIONS: NavSection[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    title: 'POS',
    items: [
      { to: '/pos/terminal', label: 'POS Terminal', icon: Coffee, permission: PERMISSIONS.pos.checkout },
      { to: '/pos/kds', label: 'Kitchen Display', icon: ChefHat, permission: PERMISSIONS.pos.kds },
      { to: '/pos/kitchen-stations', label: 'Kitchen Stations', icon: UtensilsCrossed, permission: PERMISSIONS.pos.override },
      { to: '/pos/kds-reports', label: 'Kitchen Reports', icon: BarChart3, permission: PERMISSIONS.pos.reports },
      { to: '/pos/cash-registers', label: 'Cash Registers', icon: Banknote, permission: PERMISSIONS.cashSession.read },
      { to: '/pos/receipts', label: 'POS Receipts', icon: ScrollText, permission: PERMISSIONS.pos.read },
      { to: '/pos/reports', label: 'POS Reports', icon: BarChart3, permission: PERMISSIONS.pos.reports },
    ],
  },
  {
    title: 'Master Data',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, permission: PERMISSIONS.partners.view },
      { to: '/suppliers', label: 'Suppliers', icon: Building2, permission: PERMISSIONS.partners.view },
      { to: '/products', label: 'Products', icon: Package, permission: PERMISSIONS.products.view },
      { to: '/uom', label: 'Units of Measure', icon: Ruler, permission: PERMISSIONS.uom.read },
      { to: '/menu', label: 'Menu', icon: Coffee, permission: PERMISSIONS.menu.view },
      { to: '/tables', label: 'Tables', icon: Coffee, permission: PERMISSIONS.menu.view },
      { to: '/menu/modifiers', label: 'Modifiers', icon: Tag, permission: PERMISSIONS.menu.view },
      { to: '/menu/combos', label: 'Combos', icon: Package, permission: PERMISSIONS.menu.view },
      { to: '/menu/accompaniments', label: 'Accompaniments', icon: Tag, permission: PERMISSIONS.menu.view },
    ],
  },
  {
    title: 'Sales',
    items: [
      { to: '/invoices', label: 'Sales/Invoices', icon: Receipt, permission: PERMISSIONS.invoice.read },
      { to: '/orders', label: 'Orders', icon: ClipboardList },
      { to: '/credit-notes', label: 'Credit Notes', icon: FileMinus, permission: PERMISSIONS.creditNote.read },
      { to: '/payments', label: 'Receipts', icon: HandCoins, permission: PERMISSIONS.payment.read },
      { to: '/ar-aging', label: 'Accounts Receivable', icon: Clock, permission: PERMISSIONS.report.ar },
    ],
  },
  {
    title: 'CRM',
    items: [
      { to: '/crm', label: 'CRM Dashboard', icon: LayoutDashboard, permission: PERMISSIONS.crm.dashboardRead },
      { to: '/crm/deals', label: 'Deals', icon: Handshake, permission: PERMISSIONS.crm.dealRead },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { to: '/inventory', label: 'Stock Levels', icon: Package, permission: 'inventory:read' },
      { to: '/inventory/ledger', label: 'Stock Ledger', icon: ScrollText, permission: 'inventory:read' },
      { to: '/inventory/count', label: 'Stock Count', icon: ClipboardList, permission: 'inventory_count:read' },
      { to: '/inventory/adjustments', label: 'Stock Adjustments', icon: Scale, permission: 'inventory:move' },
      { to: '/inventory/transfers', label: 'Stock Transfers', icon: Truck, permission: 'inventory:move' },
      { to: '/inventory/locations', label: 'Locations', icon: MapPin, permission: PERMISSIONS.inventoryLocation.read },
    ],
  },
  {
    title: 'Beverage Control',
    flag: 'VITE_ENABLE_BEVERAGE',
    items: [
      { to: '/beverage', label: 'Alcohol Dashboard', icon: BarChart3, permission: PERMISSIONS.beverage.read },
      { to: '/beverage/count', label: 'Bottle Count', icon: Scale, permission: PERMISSIONS.beverage.count },
    ],
  },
  {
    title: 'Rentals',
    flag: 'VITE_ENABLE_RENTAL',
    items: [
      { to: '/rental', label: 'Dashboard', icon: CalendarDays, permission: PERMISSIONS.rental.read },
      { to: '/rental/agreements', label: 'Agreements', icon: FileText, permission: PERMISSIONS.rental.read },
      { to: '/rental/units', label: 'Rental Units', icon: Boxes, permission: PERMISSIONS.rental.read },
      { to: '/rental/catalog', label: 'Rates & Packages', icon: Package, permission: PERMISSIONS.rental.read },
      { to: '/rental/returns', label: 'Returns', icon: ClipboardCheck, permission: PERMISSIONS.rental.read },
      { to: '/rental/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.rental.read },
    ],
  },
  {
    title: 'Repair & Maintenance',
    flag: 'VITE_ENABLE_REPAIR',
    items: [
      { to: '/repair', label: 'Dashboard', icon: Wrench, permission: PERMISSIONS.repair.read },
      { to: '/repair/orders', label: 'Repair Orders', icon: FileText, permission: PERMISSIONS.repair.read },
      { to: '/repair/jobs', label: 'Work Orders', icon: ClipboardCheck, permission: PERMISSIONS.repair.read },
      { to: '/repair/technicians', label: 'Technicians', icon: Users, permission: PERMISSIONS.repair.read },
      { to: '/repair/labour', label: 'Labour Catalog', icon: Timer, permission: PERMISSIONS.repair.read },
      { to: '/repair/warranties', label: 'Warranties', icon: ShieldCheck, permission: PERMISSIONS.repair.read },
      { to: '/repair/contracts', label: 'Service Contracts', icon: Handshake, permission: PERMISSIONS.repair.read },
      { to: '/repair/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.repair.read },
    ],
  },
  {
    title: 'Workforce (HR)',
    flag: 'VITE_ENABLE_HR',
    items: [
      { to: '/hr', label: 'Dashboard', icon: LayoutDashboard, permission: PERMISSIONS.hr.read },
      { to: '/hr/employees', label: 'Employees', icon: Users, permission: PERMISSIONS.hr.employee },
      { to: '/hr/departments', label: 'Departments', icon: Building2, permission: PERMISSIONS.hr.employee },
      { to: '/hr/positions', label: 'Positions', icon: Briefcase, permission: PERMISSIONS.hr.employee },
      { to: '/hr/shifts', label: 'Shifts', icon: Clock, permission: PERMISSIONS.hr.attendance },
      { to: '/hr/attendance', label: 'Attendance', icon: ClipboardCheck, permission: PERMISSIONS.hr.attendance },
      { to: '/hr/timesheets', label: 'Timesheets', icon: FileClock, permission: PERMISSIONS.hr.timesheet },
      { to: '/hr/leave', label: 'Leave', icon: CalendarDays, permission: PERMISSIONS.hr.leave },
      { to: '/hr/holidays', label: 'Holidays', icon: CalendarHeart, permission: PERMISSIONS.hr.holiday },
      { to: '/hr/payroll', label: 'Payroll', icon: Wallet, permission: PERMISSIONS.hr.payroll },
      { to: '/hr/payslips', label: 'Payslips', icon: FileText, permission: PERMISSIONS.hr.payslip },
      { to: '/hr/advances-loans', label: 'Advances & Loans', icon: HandCoins, permission: PERMISSIONS.hr.payroll },
      { to: '/hr/payroll/settings', label: 'Payroll Settings', icon: SettingsIcon, permission: PERMISSIONS.hr.payroll },
      { to: '/hr/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.hr.report },
    ],
  },
  {
    title: 'Purchasing',
    items: [
      { to: '/procurement/purchase-orders', label: 'Purchases', icon: ShoppingCart, permission: 'purchase_order:read' },
      { to: '/procurement/goods-receipts', label: 'Goods Receipts', icon: Truck, permission: 'goods_receipt:read' },
      // { to: '/procurement/three-way-match', label: '3-Way Match', icon: Scale, permission: 'three_way_match:read' },
      { to: '/procurement/debit-notes', label: 'Debit Notes', icon: FilePlus2, permission: 'debit_note:read' },
      { to: '/supplier-payments', label: 'Supplier Payments', icon: Banknote, permission: 'payment:read' },
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
    title: 'Task Management',
    items: [
      { to: '/tasks', label: 'Task Board', icon: ClipboardList },
    ],
  },
  {
    title: 'Accounting',
    items: [
      { to: '/accounts/cash-accounts', label: 'Financial Accounts', icon: Banknote, permission: PERMISSIONS.account.read },
      { to: '/accounts', label: 'Chart of Accounts', icon: BookOpen, permission: PERMISSIONS.account.read },
      { to: '/accounts/categories', label: 'Account Categories', icon: Layers, permission: PERMISSIONS.accountCategory.read },
      { to: '/accounts/cash-registers', label: 'Cash Registers', icon: Smartphone, permission: 'cash_register:read' },
      { to: '/accounts/mappings', label: 'Account Mappings', icon: Link2, permission: PERMISSIONS.accountMapping.read },
      { to: '/accounts/posting-rules', label: 'Posting Rules', icon: FileText, permission: PERMISSIONS.inventoryPostingRule.read },
      { to: '/journals', label: 'Journals', icon: BookText, permission: PERMISSIONS.journal.read },
      { to: '/journal-entries', label: 'Journal Entries', icon: ScrollText, permission: PERMISSIONS.journalEntry.read },
      { to: '/trial-balance', label: 'Trial Balance', icon: Scale, permission: PERMISSIONS.report.accounting },
      { to: '/general-ledger', label: 'General Ledger', icon: ArrowUpDown, permission: PERMISSIONS.report.accounting },
      { to: '/profit-and-loss', label: 'Profit & Loss', icon: TrendingUp, permission: PERMISSIONS.report.accounting },
      { to: '/cash-flow', label: 'Cash Flow', icon: TrendingDown, permission: PERMISSIONS.report.accounting },
      { to: '/tieout', label: 'Tie-Out', icon: ShieldCheck, permission: PERMISSIONS.report.accounting },
      { to: '/audit-log', label: 'Audit Log', icon: History, permission: PERMISSIONS.auditLog.read },
      { to: '/fiscal-periods', label: 'Fiscal Periods', icon: CalendarDays, permission: PERMISSIONS.fiscalPeriod.read },
      { to: '/taxes', label: 'Tax Rates', icon: Percent, permission: PERMISSIONS.tax.read },
      { to: '/cost-centers', label: 'Cost Centers', icon: Users, permission: PERMISSIONS.costCenter.read },
      { to: '/currency', label: 'Currency', icon: Banknote, permission: PERMISSIONS.currency.read },
      { to: '/accounts/payment-terms', label: 'Payment Terms', icon: CalendarClock, permission: PERMISSIONS.account.read },
      { to: '/accounts/fiscal-positions', label: 'Fiscal Positions', icon: Landmark, permission: PERMISSIONS.account.read },
      { to: '/inventory-valuation', label: 'Inventory Val.', icon: Package, permission: PERMISSIONS.report.accounting },
      { to: '/year-end-close', label: 'Year-End Close', icon: Lock, permission: PERMISSIONS.fiscalPeriod.update },
      { to: '/balance-sheet', label: 'Balance Sheet', icon: Landmark, permission: PERMISSIONS.report.accounting },
      { to: '/reports', label: 'Report Center', icon: BarChart3, permission: PERMISSIONS.report.accounting },
    ],
  },
  {
    title: 'Fixed Assets',
    flag: 'VITE_ENABLE_ASSETS',
    items: [
      { to: '/fixed-assets', label: 'Dashboard', icon: LayoutDashboard, permission: PERMISSIONS.fixedAsset.read },
      { to: '/fixed-assets/register', label: 'Asset Register', icon: Building2, permission: PERMISSIONS.fixedAsset.read },
      { to: '/fixed-assets/categories', label: 'Categories', icon: Tag, permission: PERMISSIONS.assetCategory.read },
    ],
  },
  {
    title: 'Manufacturing',
    flag: 'VITE_ENABLE_MANUFACTURING',
    items: [
      { to: '/manufacturing', label: 'Production', icon: Factory },
      { to: '/manufacturing/orders', label: 'Orders', icon: ClipboardList },
      { to: '/manufacturing/boms', label: 'Recipes (BOM)', icon: ScrollText },
      { to: '/manufacturing/planning', label: 'Planning', icon: CalendarDays },
      { to: '/manufacturing/resources', label: 'Work Centres', icon: Boxes },
      { to: '/manufacturing/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    title: 'Bakery',
    flag: 'VITE_ENABLE_MANUFACTURING',
    items: [
      { to: '/manufacturing', label: 'Production', icon: Factory },
      { to: '/manufacturing/orders', label: 'Orders', icon: ClipboardList },
      { to: '/manufacturing/boms', label: 'Recipes (BOM)', icon: ScrollText },
      { to: '/manufacturing/planning', label: 'Planning', icon: CalendarDays },
      { to: '/manufacturing/resources', label: 'Work Centres', icon: Boxes },
      { to: '/manufacturing/reports', label: 'Reports', icon: BarChart3 },
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
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck, permission: 'approvals:read' },
      { to: '/approval-workflows', label: 'Approval Workflows', icon: Shield, permission: 'approvals:read' },
      { to: '/approval-policies', label: 'Approval Policies (legacy)', icon: Shield, permission: 'approvals:read' },
      { to: '/staff', label: 'Staff', icon: UserCog, permission: PERMISSIONS.user.read },
      { to: '/staff/roles', label: 'Roles & Permissions', icon: Shield, permission: PERMISSIONS.role.read },
      { to: '/settings/devices', label: 'Offline devices', icon: Smartphone, permission: PERMISSIONS.organization.read },
      { to: '/settings/backup', label: 'Backup', icon: HardDrive, permission: PERMISSIONS.backup.read },
      { to: '/settings/company', label: 'Company Settings', icon: Landmark, permission: PERMISSIONS.setting.read },
      { to: '/settings/developer', label: 'Developer Settings', icon: SettingsIcon, permission: PERMISSIONS.setting.read },
    ],
  },
];

// Flags are build-time constants under Vite, so this resolves once.
const VISIBLE_SECTIONS = NAV_SECTIONS.filter((s) => flagEnabled(s.flag));

// Collapsed (icon-only) sidebar keeps sections flat; accordion is only for expanded mode.
const SIDEBAR_EXPAND_STATE_KEY = 'poscafe.sidebar.expandedSections';

// Localized section titles for the accordion parent buttons.
const SECTION_TITLE_KEYS: Record<string, string> = {
  POS: 'nav.pos',
  'Master Data': 'nav.masterData',
  Sales: 'nav.sales',
  CRM: 'nav.crm',
  Inventory: 'nav.inventory',
  'Beverage Control': 'nav.beverageControl',
  Rentals: 'nav.rentals',
  'Repair & Maintenance': 'nav.repairMaintenance',
  'Human Resources': 'nav.workforce',
  Purchasing: 'nav.purchasing',
  Expenses: 'nav.expenses',
  Tasks: 'nav.tasks',
  'Task Management': 'nav.taskManagement',
  Accounting: 'nav.accounting',
  'Fixed Assets': 'nav.fixedAssets',
  Manufacturing: 'nav.manufacturing',
  Bakery: 'nav.bakery',
  System: 'nav.system',
};

const sectionTitle = (title: string | undefined, t: (k: string) => string) =>
  title ? (SECTION_TITLE_KEYS[title] ? t(SECTION_TITLE_KEYS[title]) : title) : '';

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { theme: sb } = useSidebarTheme();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const clear = useAuthStore((s) => s.clear);
  const org = useAuthStore((s) => s.organization);
  const setOrganization = useAuthStore((s) => s.setOrganization);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Accordion state: which titled sections are expanded (expanded sidebar only).
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_EXPAND_STATE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const persistExpanded = (next: Record<string, boolean>) => {
    setExpanded(next);
    try {
      localStorage.setItem(SIDEBAR_EXPAND_STATE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  };
  const toggleSection = (title: string) =>
    persistExpanded({ ...expanded, [title]: !expanded[title] });

  // Auto-expand the section containing the active route so it's never hidden.
  const [autoExpanded, setAutoExpanded] = useState(false);
  useEffect(() => {
    if (sidebarCollapsed || autoExpanded) return;
    const activeSection = VISIBLE_SECTIONS.find(
      (s) =>
        s.title &&
        s.items.some(
          (n) => n.to !== '/' && (location.pathname === n.to || location.pathname.startsWith(`${n.to}/`)),
        ),
    );
    if (activeSection?.title && !expanded[activeSection.title]) {
      persistExpanded({ ...expanded, [activeSection.title]: true });
    }
    setAutoExpanded(true);
  }, [location.pathname, sidebarCollapsed]);

  // Keep the org (incl. base currency) in sync with the server on boot.
  useEffect(() => {
    let cancelled = false;
    api
      .get('/organizations/me')
      .then((res) => {
        if (cancelled || !res.data?.id) return;
        const o = res.data;
        setOrganization({
          id: o.id,
          code: o.code,
          name: o.name,
          currencyCode: o.currencyCode,
          timezone: o.timezone,
        });
      })
      .catch(() => {
        /* token invalid — protected route handles it */
      });
    return () => {
      cancelled = true;
    };
  }, [setOrganization]);

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

  const allItems = VISIBLE_SECTIONS.flatMap((s) => s.items);
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
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-1">
        {VISIBLE_SECTIONS.map((section, idx) => {
          const items = section.items.filter(
                      (i) => flagEnabled(i.flag) && (!i.permission || hasPermission(i.permission)),
                    );
          if (items.length === 0) return null;
          const isOpen = !section.title || expanded[section.title];
          return (
            <div key={idx} className="space-y-0">
              {section.title && !collapsed ? (
                <button
                  type="button"
                  onClick={() => toggleSection(section.title as string)}
                  className="flex w-full items-center gap-1.5 rounded-md px-0.5 py-1.5 text-[15px] font-bold uppercase tracking-[0.04em] transition-colors hover:bg-white/10"
                  style={{ color: sb.sidebarActive, borderBottom: `1px solid ${sb.sidebarBorder}`, marginBottom: 2 }}
                  aria-expanded={isOpen}
                >
                  <ChevronDown
                    className={cn('h-3 w-3 shrink-0 transition-transform duration-150', !isOpen && '-rotate-90')}
                  />
                  <span className="flex-1 truncate text-left">{sectionTitle(section.title, t)}</span>
                </button>
              ) : section.title && collapsed ? (
                <div
                  className="mx-2 my-1 border-t"
                  style={{ borderColor: sb.sidebarBorder }}
                  aria-hidden
                />
              ) : null}
              {isOpen &&
                items.map((item) => {
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
            to="/settings/company"
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
        <header className="app-shell-header sticky top-0 z-30 flex h-11 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur print:hidden md:px-6">
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
            <ThemePicker />
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