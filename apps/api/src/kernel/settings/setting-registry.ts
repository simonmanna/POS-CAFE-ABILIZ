/**
 * Setting registry — the single source of truth for configurable settings.
 *
 * Each definition declares the value type, a code-side default, which scope
 * levels it may be set at, and whether it cascades. The resolver
 * (SettingResolverService) reads this to validate writes and to fall back to a
 * default when no override exists at any level. Historically keys were bare
 * string literals scattered across services; new code should reference
 * SETTING_KEYS / getSettingDefinition instead.
 *
 * Scope precedence (most specific first): product -> category -> warehouse ->
 * organization -> registry default.
 */

export type ScopeType = 'organization' | 'warehouse' | 'category' | 'product';

export const SCOPE_PRECEDENCE: ScopeType[] = ['product', 'category', 'warehouse', 'organization'];

export type SettingType = 'bool' | 'enum' | 'string' | 'number' | 'json';

export type SettingGroup = 'inventory' | 'accounting';

export interface SettingDefinition {
  key: string;
  group: SettingGroup;
  type: SettingType;
  /** Human label for the admin UI. */
  label: string;
  description?: string;
  /** Value returned when no override exists at any scope level. */
  default: unknown;
  /** Allowed values for `type: 'enum'`. */
  enumValues?: readonly string[];
  /** Whether the value may be overridden below the organization level. */
  cascades: boolean;
  /** Scope levels this key may be set at (org is always allowed). */
  scopeLevels: readonly ScopeType[];
}

const ALL_LEVELS: readonly ScopeType[] = ['organization', 'warehouse', 'category', 'product'];
const ORG_ONLY: readonly ScopeType[] = ['organization'];

/**
 * Registered settings. Legacy `inventory.default*` keys keep their exact names
 * so existing rows and the current /settings/inventory-defaults UI keep working;
 * they simply gain cascade behaviour through the resolver.
 */
export const SETTING_DEFINITIONS = {
  // ---- Inventory ----------------------------------------------------------
  // Only enforced settings are registered — a key appears here once code honours
  // it, so the admin UI never shows an inert toggle. Later phases add more.
  'inventory.allowNegativeStock': {
    key: 'inventory.allowNegativeStock',
    group: 'inventory',
    type: 'bool',
    label: 'Allow Negative Stock',
    // Owner rule: a sale must never be blocked. Default stays permissive; set to
    // false per product/category/warehouse to enforce Product.stockPolicy.
    description:
      'When off, stock-out enforcement follows the item stock policy. Default keeps sales unblocked.',
    default: true,
    cascades: true,
    scopeLevels: ALL_LEVELS,
  },
  'inventory.defaultPickingStrategy': {
    key: 'inventory.defaultPickingStrategy',
    group: 'inventory',
    type: 'enum',
    label: 'Removal Strategy',
    description:
      'Overrides the product removal strategy for the chosen scope at issue time. Product column is the fallback.',
    default: 'FEFO',
    enumValues: ['FEFO', 'FIFO', 'MANUAL', 'SERIAL'],
    cascades: true,
    scopeLevels: ALL_LEVELS,
  },
  // New-product inheritance defaults (applied on product create, organization
  // level only — runtime uses the product's own column).
  'inventory.defaultCostingMethod': {
    key: 'inventory.defaultCostingMethod',
    group: 'inventory',
    type: 'enum',
    label: 'Default Costing Method (new products)',
    default: 'AVCO',
    enumValues: ['AVCO', 'FIFO', 'STANDARD', 'SPECIFIC'],
    cascades: false,
    scopeLevels: ORG_ONLY,
  },
  'inventory.defaultBatchTracking': {
    key: 'inventory.defaultBatchTracking',
    group: 'inventory',
    type: 'bool',
    label: 'Default Batch Tracking (new products)',
    default: false,
    cascades: false,
    scopeLevels: ORG_ONLY,
  },
  'inventory.defaultExpiryTracking': {
    key: 'inventory.defaultExpiryTracking',
    group: 'inventory',
    type: 'bool',
    label: 'Default Expiry Tracking (new products)',
    default: false,
    cascades: false,
    scopeLevels: ORG_ONLY,
  },
  'inventory.defaultSerialTracking': {
    key: 'inventory.defaultSerialTracking',
    group: 'inventory',
    type: 'bool',
    label: 'Default Serial Tracking (new products)',
    default: false,
    cascades: false,
    scopeLevels: ORG_ONLY,
  },

  // ---- Accounting ---------------------------------------------------------
  // Populated in Phase 4 as each accounting toggle is wired.
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

/** Typed key constants to replace scattered string literals. */
export const SETTING_KEYS = Object.freeze(
  Object.fromEntries(Object.keys(SETTING_DEFINITIONS).map((k) => [k, k])),
) as { readonly [K in SettingKey]: K };

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return (SETTING_DEFINITIONS as Record<string, SettingDefinition>)[key];
}

export function settingsForGroup(group: SettingGroup): SettingDefinition[] {
  return Object.values(SETTING_DEFINITIONS as Record<string, SettingDefinition>).filter(
    (d) => d.group === group,
  );
}

/**
 * Validate and normalise a raw value against its definition. Throws Error with a
 * human message on mismatch. Returns the coerced value to store as JSON.
 */
export function coerceSettingValue(def: SettingDefinition, raw: unknown): unknown {
  switch (def.type) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`Setting '${def.key}' expects a boolean.`);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Setting '${def.key}' expects a number.`);
      return n;
    }
    case 'enum': {
      const s = String(raw);
      if (!def.enumValues?.includes(s)) {
        throw new Error(`Setting '${def.key}' must be one of: ${def.enumValues?.join(', ')}.`);
      }
      return s;
    }
    case 'string':
      return String(raw);
    case 'json':
      return raw;
    default:
      return raw;
  }
}

/** Assert a scope level is permitted for a key. Throws Error otherwise. */
export function assertScopeAllowed(def: SettingDefinition, scopeType: ScopeType): void {
  if (scopeType === 'organization') return;
  if (!def.cascades || !def.scopeLevels.includes(scopeType)) {
    throw new Error(`Setting '${def.key}' cannot be set at ${scopeType} level.`);
  }
}
