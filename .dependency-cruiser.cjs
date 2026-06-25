/**
 * Architecture-boundary enforcement (ADR-011 + ADR-001).
 *
 * Rules:
 *   - `kernel` is the root: no module/* imports.
 *   - `core` depends only on `kernel`.
 *   - `accounting` depends on `core` + `kernel` (NOT invoicing/inventory/procurement/vertical).
 *   - `invoicing` depends on `accounting` + `core` + `kernel` (NOT inventory/procurement/vertical).
 *   - `inventory` depends on `core` + `kernel` (NOT invoicing/procurement/vertical).
 *   - `procurement` depends on `core` + `accounting` + `inventory` + `invoicing` + `kernel` (NOT vertical).
 *   - Verticals (`pos/`, `school/`, future) may depend on
 *     accounting/invoicing/inventory/core/kernel, but NEVER on another vertical.
 *
 * Run via: pnpm lint:arch  →  depcruise apps/api/src --config .dependency-cruiser.cjs
 */
/** @type {import('dependency-cruiser').IConfiguration} */

// Each vertical lives at `apps/api/src/modules/<vertical>/`. Add new verticals
// here as they are scaffolded.
const VERTICALS = ['pos', 'school'];
const verticalAlt = VERTICALS.join('|');
const verticalGroup = `(?:${verticalAlt})`;
const NON_VERTICAL = 'core|accounting|invoicing|inventory|procurement|kernel|auth|settings|audit|tenancy|prisma|events|sequence|workflow|module-loader|common';

module.exports = {
  forbidden: [
    // ─── Kernel is the root ──────────────────────────────────────────────
    {
      name: 'kernel-must-not-import-modules',
      severity: 'error',
      comment: 'Kernel may not import any feature module.',
      from: { path: '^apps/api/src/kernel' },
      to: { path: '^apps/api/src/modules' },
    },

    // ─── Core layer ──────────────────────────────────────────────────────
    {
      name: 'core-must-not-import-accounting',
      severity: 'error',
      comment: 'Core may not import accounting.',
      from: { path: '^apps/api/src/modules/core' },
      to: { path: '^apps/api/src/modules/accounting' },
    },
    {
      name: 'core-must-not-import-invoicing',
      severity: 'error',
      comment: 'Core may not import invoicing.',
      from: { path: '^apps/api/src/modules/core' },
      to: { path: '^apps/api/src/modules/invoicing' },
    },
    {
      name: 'core-must-not-import-inventory',
      severity: 'error',
      comment: 'Core may not import inventory.',
      from: { path: '^apps/api/src/modules/core' },
      to: { path: '^apps/api/src/modules/inventory' },
    },
    {
      name: 'core-must-not-import-procurement',
      severity: 'error',
      comment: 'Core may not import procurement.',
      from: { path: '^apps/api/src/modules/core' },
      to: { path: '^apps/api/src/modules/procurement' },
    },
    {
      name: 'core-must-not-import-vertical',
      severity: 'error',
      comment: 'Core may not import verticals.',
      from: { path: '^apps/api/src/modules/core' },
      to: { path: `^apps/api/src/modules/(?!${NON_VERTICAL}|${verticalAlt}/)` },
    },

    // ─── Accounting layer ────────────────────────────────────────────────
    {
      name: 'accounting-must-not-import-invoicing',
      severity: 'error',
      comment: 'Accounting may not import invoicing (downward only).',
      from: { path: '^apps/api/src/modules/accounting' },
      to: { path: '^apps/api/src/modules/invoicing' },
    },
    {
      name: 'accounting-must-not-import-inventory',
      severity: 'error',
      comment: 'Accounting may not import inventory (downward only).',
      from: { path: '^apps/api/src/modules/accounting' },
      to: { path: '^apps/api/src/modules/inventory' },
    },
    {
      name: 'accounting-must-not-import-procurement',
      severity: 'error',
      comment: 'Accounting may not import procurement.',
      from: { path: '^apps/api/src/modules/accounting' },
      to: { path: '^apps/api/src/modules/procurement' },
    },
    {
      name: 'accounting-must-not-import-vertical',
      severity: 'error',
      comment: 'Accounting may not import verticals.',
      from: { path: '^apps/api/src/modules/accounting' },
      to: { path: `^apps/api/src/modules/(?!${NON_VERTICAL}|${verticalAlt}/)` },
    },

    // ─── Invoicing layer ─────────────────────────────────────────────────
    {
      name: 'invoicing-must-not-import-procurement',
      severity: 'error',
      comment: 'Invoicing may not import procurement (avoid cycle: procurement depends on invoicing for vendor_bill, not vice versa).',
      from: { path: '^apps/api/src/modules/invoicing' },
      to: { path: '^apps/api/src/modules/procurement' },
    },
    {
      name: 'invoicing-must-not-import-vertical',
      severity: 'error',
      comment: 'Invoicing may not import verticals.',
      from: { path: '^apps/api/src/modules/invoicing' },
      to: { path: `^apps/api/src/modules/(?!${NON_VERTICAL}|${verticalAlt}/)` },
    },

    // ─── Inventory layer ─────────────────────────────────────────────────
    {
      name: 'inventory-must-not-import-invoicing',
      severity: 'error',
      comment: 'Inventory may not import invoicing.',
      from: { path: '^apps/api/src/modules/inventory' },
      to: { path: '^apps/api/src/modules/invoicing' },
    },
    {
      name: 'inventory-must-not-import-procurement',
      severity: 'error',
      comment: 'Inventory may not import procurement.',
      from: { path: '^apps/api/src/modules/inventory' },
      to: { path: '^apps/api/src/modules/procurement' },
    },
    {
      name: 'inventory-must-not-import-vertical',
      severity: 'error',
      comment: 'Inventory may not import verticals.',
      from: { path: '^apps/api/src/modules/inventory' },
      to: { path: `^apps/api/src/modules/(?!${NON_VERTICAL}|${verticalAlt}/)` },
    },

    // ─── Vertical-to-vertical isolation ─────────────────────────────────
    // A vertical may not import code from a DIFFERENT vertical. Intra-vertical
    // and core-layer imports are fine. We check each (fromVertical → otherVertical)
    // pair explicitly so depcruise doesn't need cross-segment backreferences.
    ...VERTICALS.flatMap((fromV) =>
      VERTICALS.filter((toV) => toV !== fromV).map((toV) => ({
        name: `vertical-${fromV}-may-not-reach-vertical-${toV}`,
        severity: 'error',
        comment: `Vertical '${fromV}' may not import from vertical '${toV}'. Use the event bus or shared core types.`,
        from: { path: `^apps/api/src/modules/${fromV}/` },
        to: { path: `^apps/api/src/modules/${toV}/` },
      })),
    ),

    // ─── No deep imports into a peer's internals ─────────────────────────
    {
      name: 'no-not-internal',
      severity: 'warn',
      comment: "Avoid deep imports past a module's public surface; expose what you need through the module barrel.",
      from: { path: '^apps/api/src' },
      to: { path: '\\.not-internal(/|$)' },
    },

    // ─── No orphan modules ───────────────────────────────────────────────
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Every file must be reachable from AppModule (type-only files excluded).',
      from: { path: '^apps/api/src', orphan: true, pathNot: '\\.(spec|dto|types|interface|d)\\.ts$' },
      to: { path: '^apps/api/src' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
