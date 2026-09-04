/**
 * Developer-configurable module features.
 *
 * The org's `settings.features` map (edited on /settings/developer) decides
 * which optional modules are switched on. Each entry here binds a feature key
 * to the sidebar section(s) it gates, so turning a module off in Developer
 * Settings removes its parent nav group from the left sidebar.
 *
 * Absent key == enabled: existing organizations were never asked, so an empty
 * map must keep every module visible rather than blanking the navigation.
 */
export interface ModuleFeature {
  key: string;
  label: string;
  description: string;
  /** Titles of the NAV_SECTIONS this feature gates. */
  sections: string[];
}

export const MODULE_FEATURES: ModuleFeature[] = [
  { key: 'crm', label: 'CRM', description: 'Customers, leads, opportunities, and pipeline tracking', sections: ['CRM'] },
  { key: 'rental', label: 'Rentals', description: 'Hire-out agreements, rental units, returns, and settlement', sections: ['Rentals'] },
  { key: 'manufacturing', label: 'Manufacturing / Bakery', description: 'BOMs, production orders, work orders, and MRP', sections: ['Manufacturing/Bakery'] },
  { key: 'repair', label: 'Repair & Maintenance', description: 'Repair jobs, work tickets, and maintenance scheduling', sections: ['Repair & Maintenance'] },
  { key: 'communication', label: 'Communication', description: 'Unified inbox, channels, and messaging automation', sections: ['Communication'] },
  { key: 'assets', label: 'Fixed Assets', description: 'Fixed asset register, categories, and depreciation', sections: ['Fixed Assets'] },
  { key: 'taskBoard', label: 'Task Management', description: 'Kanban-style task management and workflow tracking', sections: ['Task Management'] },
  { key: 'accounting', label: 'Accounting', description: 'Chart of accounts, journals, and the posting engine', sections: ['Accounting'] },
  { key: 'expense', label: 'Expenses', description: 'Petty cash, opex tracking, approvals, and reimbursements', sections: ['Expenses'] },
];

/** Section title -> feature key that gates it. */
const SECTION_FEATURE_KEY: Record<string, string> = Object.fromEntries(
  MODULE_FEATURES.flatMap((f) => f.sections.map((s) => [s, f.key] as const)),
);

/** A feature is on unless it has been explicitly switched off. */
export const featureEnabled = (
  features: Record<string, boolean> | undefined,
  key: string,
): boolean => features?.[key] !== false;

/** Sections with no feature key mapped are always visible. */
export const sectionEnabled = (
  features: Record<string, boolean> | undefined,
  title?: string,
): boolean => {
  if (!title) return true;
  const key = SECTION_FEATURE_KEY[title];
  return !key || featureEnabled(features, key);
};
