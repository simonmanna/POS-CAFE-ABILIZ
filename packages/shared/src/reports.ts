/**
 * Report catalog — the single source of truth for every report the product can
 * show, so visibility can be configured per role instead of being hard-wired to
 * one coarse permission (`pos:reports`, `report:accounting`, …).
 *
 * Two layers decide whether somebody sees a report:
 *
 *   1. The baseline permission (`permission` below). Still enforced by the API
 *      on the underlying data endpoints — configuration can never hand out a
 *      report the role has no permission for.
 *   2. The per-role visibility config (Setting key `reports.visibility`). When a
 *      role has no entry, every report whose baseline permission it holds is
 *      visible — i.e. the behaviour before this feature existed.
 *
 * A report is either a whole page (`route`) or a tab inside one (`route` + the
 * tab id encoded in the report id). The ids are stable strings: they are
 * persisted in the Setting row, so rename labels freely but never ids.
 */

export type ReportGroup =
  | 'POS Reports'
  | 'Report Center'
  | 'Sales'
  | 'Accounting'
  | 'Money'
  | 'Inventory'
  | 'Expenses'
  | 'Human Resource'
  | 'Manufacturing'
  | 'Repair'
  | 'Rentals';

export interface ReportDescriptor {
  /** Stable key persisted in the visibility config. Never rename. */
  id: string;
  label: string;
  group: ReportGroup;
  /** Baseline permission the API enforces for the report's data. */
  permission: string;
  /** Page the report lives on. Tabs share their page's route. */
  route: string;
  /** Tab id within the page, when the report is a tab rather than a page. */
  tab?: string;
  description?: string;
}

const posTab = (tab: string, label: string): ReportDescriptor => ({
  id: `pos.${tab}`,
  label,
  group: 'POS Reports',
  permission: 'pos:reports',
  route: '/pos/reports',
  tab,
});

const centerTab = (tab: string, label: string): ReportDescriptor => ({
  id: `center.${tab}`,
  label,
  group: 'Report Center',
  permission: 'report:accounting',
  route: '/reports',
  tab,
});

export const REPORT_CATALOG: readonly ReportDescriptor[] = [
  // ---- POS Reports page (/pos/reports) — one entry per tab ----
  posTab('sales', 'Sales Report'),
  posTab('items', 'Items Report'),
  posTab('item-sales', 'Item Sales'),
  posTab('items-by-group', 'Items by Group'),
  posTab('items-by-server', 'Item Sales by Server'),
  posTab('orders', 'Order Reports'),
  posTab('cashier', 'Cashier Reports'),
  posTab('cashier-summary', 'Cashier Shift Summary'),
  posTab('waiter', 'Waiter Report'),
  posTab('daily', 'Daily Sales'),
  posTab('weekly', 'Weekly Sales'),
  posTab('monthly', 'Monthly Sales'),
  posTab('hourly', 'Sales by Hour'),
  posTab('top', 'Top Items'),
  posTab('x', 'X-Report'),
  posTab('z', 'Z-Report'),

  // ---- Report Center (/reports) — one entry per tab ----
  centerTab('sales', 'Sales Report'),
  centerTab('items', 'Item Sales'),
  centerTab('expenses', 'Expenses'),
  centerTab('purchases', 'Purchases'),
  centerTab('cf-summary', 'Cash Flow Summary'),
  centerTab('cf-detailed', 'Cash Flow Detailed'),

  // ---- Whole-page reports ----
  {
    id: 'pos.kds',
    label: 'Kitchen Reports',
    group: 'POS Reports',
    permission: 'pos:reports',
    route: '/pos/kds-reports',
    description: 'Kitchen performance and ticket timings.',
  },
  {
    id: 'pos.tables',
    label: 'Table Reports',
    group: 'POS Reports',
    permission: 'pos:reports',
    route: '/tables/reports',
  },
  {
    id: 'sales.ar-aging',
    label: 'Accounts Receivable Aging',
    group: 'Sales',
    permission: 'report:ar',
    route: '/ar-aging',
  },
  {
    id: 'accounting.report-center',
    label: 'Report Center',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/reports',
    description: 'The unified report hub page itself.',
  },
  {
    id: 'accounting.trial-balance',
    label: 'Trial Balance',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/trial-balance',
  },
  {
    id: 'accounting.general-ledger',
    label: 'General Ledger',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/general-ledger',
  },
  {
    id: 'accounting.detailed',
    label: 'Detailed Accounting Report',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/accounting-detailed-report',
  },
  {
    id: 'accounting.profit-and-loss',
    label: 'Profit & Loss',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/profit-and-loss',
  },
  {
    id: 'accounting.balance-sheet',
    label: 'Balance Sheet',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/balance-sheet',
  },
  {
    id: 'accounting.cash-flow-statement',
    label: 'Cash Flow Statement',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/cash-flow',
  },
  {
    id: 'accounting.tieout',
    label: 'Tie-Out',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/tieout',
  },
  {
    id: 'accounting.pos-gl-recon',
    label: 'POS → GL Reconciliation',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/pos-gl-reconciliation',
  },
  {
    id: 'accounting.inventory-valuation',
    label: 'Inventory Valuation',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/inventory-valuation',
  },
  {
    id: 'accounting.inventory-gl-tieout',
    label: 'Inventory ↔ GL Tie-Out',
    group: 'Accounting',
    permission: 'report:accounting',
    route: '/inventory-gl-tieout',
  },
  {
    id: 'money.reports',
    label: 'Money Reports',
    group: 'Money',
    permission: 'account:read',
    route: '/cash-flow/report',
  },
  {
    id: 'inventory.reports',
    label: 'Inventory Reports',
    group: 'Inventory',
    permission: 'inventory:read',
    route: '/inventory/reports',
  },
  {
    id: 'expenses.reports',
    label: 'Expense Reports',
    group: 'Expenses',
    permission: 'expense:read',
    route: '/expenses/reports',
  },
  {
    id: 'hr.reports',
    label: 'HR Reports',
    group: 'Human Resource',
    permission: 'hr:report',
    route: '/hr/reports',
  },
  {
    id: 'manufacturing.reports',
    label: 'Production Reports',
    group: 'Manufacturing',
    permission: 'production:report',
    route: '/manufacturing/reports',
  },
  {
    id: 'repair.reports',
    label: 'Repair Reports',
    group: 'Repair',
    permission: 'repair:read',
    route: '/repair/reports',
  },
  {
    id: 'rental.reports',
    label: 'Rental Reports',
    group: 'Rentals',
    permission: 'rental:read',
    route: '/rental/reports',
  },
];

export const REPORT_IDS: readonly string[] = REPORT_CATALOG.map((r) => r.id);

const REPORT_BY_ID = new Map(REPORT_CATALOG.map((r) => [r.id, r]));

export function getReport(id: string): ReportDescriptor | undefined {
  return REPORT_BY_ID.get(id);
}

export function isReportId(id: string): boolean {
  return REPORT_BY_ID.has(id);
}

/** Groups in catalog order, for rendering the admin matrix. */
export const REPORT_GROUPS: readonly ReportGroup[] = REPORT_CATALOG.reduce<ReportGroup[]>(
  (acc, r) => (acc.includes(r.group) ? acc : [...acc, r.group]),
  [],
);

/**
 * Reports a role sees when nothing has been configured for it: everything its
 * permissions already allow. Keeps upgrades a no-op until an admin opts in.
 */
export function defaultReportsForPermissions(permissions: readonly string[]): string[] {
  const held = new Set(permissions);
  return REPORT_CATALOG.filter((r) => held.has(r.permission)).map((r) => r.id);
}

/** Setting key the per-role visibility config is stored under (org scope). */
export const REPORT_VISIBILITY_SETTING_KEY = 'reports.visibility';

/** Shape stored under {@link REPORT_VISIBILITY_SETTING_KEY}. */
export interface ReportVisibilityConfig {
  version: 1;
  /** roleId -> explicitly allowed report ids. Absent role = permission default. */
  roles: Record<string, string[]>;
}
