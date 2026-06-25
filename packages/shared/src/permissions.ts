/**
 * RBAC permission catalog. Format: `resource:action` (ADR Phase 0 auth).
 * Shared so the API guards and the Web permission-aware menus agree.
 */

export const PERMISSIONS = {
  organization: {
    create: 'organization:create',
    read: 'organization:read',
    update: 'organization:update',
    delete: 'organization:delete',
  },
  user: {
    create: 'user:create',
    read: 'user:read',
    update: 'user:update',
    delete: 'user:delete',
  },
  role: {
    create: 'role:create',
    read: 'role:read',
    update: 'role:update',
    delete: 'role:delete',
  },
  partner: {
    create: 'partner:create',
    read: 'partner:read',
    update: 'partner:update',
    delete: 'partner:delete',
  },
  partnerCategory: {
    create: 'partner_category:create',
    read: 'partner_category:read',
    update: 'partner_category:update',
    delete: 'partner_category:delete',
  },
  product: {
    create: 'product:create',
    read: 'product:read',
    update: 'product:update',
    delete: 'product:delete',
  },
  productCategory: {
    create: 'product_category:create',
    read: 'product_category:read',
    update: 'product_category:update',
    delete: 'product_category:delete',
  },
  uom: {
    create: 'uom:create',
    read: 'uom:read',
    update: 'uom:update',
    delete: 'uom:delete',
  },
  tax: {
    create: 'tax:create',
    read: 'tax:read',
    update: 'tax:update',
    delete: 'tax:delete',
  },
  currency: {
    create: 'currency:create',
    read: 'currency:read',
    update: 'currency:update',
    delete: 'currency:delete',
  },
  fiscalPeriod: {
    create: 'fiscal_period:create',
    read: 'fiscal_period:read',
    update: 'fiscal_period:update',
    delete: 'fiscal_period:delete',
  },
  setting: {
    read: 'setting:read',
    update: 'setting:update',
  },
  auditLog: {
    read: 'audit_log:read',
  },

  // ---- Accounting (Phase 2) ----
  account: {
    create: 'account:create',
    read: 'account:read',
    update: 'account:update',
    delete: 'account:delete',
  },
  journal: {
    create: 'journal:create',
    read: 'journal:read',
    update: 'journal:update',
    delete: 'journal:delete',
  },
  journalEntry: {
    read: 'journal_entry:read',
    create: 'journal_entry:create',
    post: 'journal_entry:post',
    reverse: 'journal_entry:reverse',
  },
  accountMapping: {
    read: 'account_mapping:read',
    update: 'account_mapping:update',
  },
  bankAccount: {
    create: 'bank_account:create',
    read: 'bank_account:read',
    update: 'bank_account:update',
    delete: 'bank_account:delete',
  },
  treasury: {
    read: 'treasury:read',
    transfer: 'treasury:transfer',
  },

  // ---- Invoicing / AR (Phase 3) ----
  invoice: {
    read: 'invoice:read',
    create: 'invoice:create',
    update: 'invoice:update',
    post: 'invoice:post',
    cancel: 'invoice:cancel',
    delete: 'invoice:delete',
  },
  creditNote: {
    read: 'credit_note:read',
    create: 'credit_note:create',
    post: 'credit_note:post',
  },
  expense: {
    read: 'expense:read',
    create: 'expense:create',
    update: 'expense:update',
    post: 'expense:post',
    cancel: 'expense:cancel',
  },
  payment: {
    read: 'payment:read',
    create: 'payment:create',
    allocate: 'payment:allocate',
    void: 'payment:void',
  },
  report: {
    accounting: 'report:accounting',
    ar: 'report:ar',
  },

  // ---- Inventory (Phase 4) ----
  inventoryLocation: {
    create: 'inventory_location:create',
    read: 'inventory_location:read',
    update: 'inventory_location:update',
    delete: 'inventory_location:delete',
  },
  inventory: {
    read: 'inventory:read',
    move: 'inventory:move',
  },

  // ---- M5: Cash registers / sessions (foundation) ----
  cashRegister: {
    create: 'cash_register:create',
    read: 'cash_register:read',
    update: 'cash_register:update',
    delete: 'cash_register:delete',
  },
  cashSession: {
    open: 'cash_session:open',
    read: 'cash_session:read',
    close: 'cash_session:close',
  },
  // ---- Phase F: Branch permissions (also includes the F.5 vertical module perms)
  branch: {
    create: 'branch:create',
    read: 'branch:read',
    update: 'branch:update',
    delete: 'branch:delete',
    // Allows an admin to see / switch the user's home branch.
    assignUser: 'branch:assign_user',
  },
  // ---- POS Tables Management (ADR-012 / Phase T1) ----
  tables: {
    view: 'tables:view',
    create: 'tables:create',
    edit: 'tables:edit',
    delete: 'tables:delete',
    transfer: 'tables:transfer',
    merge: 'tables:merge',
    split: 'tables:split',
    clean: 'tables:clean',
    reserve: 'tables:reserve',
  },
  // ---- Phase F.5: Vertical permissions (consumed by the verticals/* modules) ----
  pos: {
    read: 'pos:read',
    checkout: 'pos:checkout',
    refund: 'pos:refund',
    openSession: 'pos:open_session',
    closeSession: 'pos:close_session',
    hold: 'pos:hold',                 // park/recall a sale
    discount: 'pos:discount',         // apply > 0% discount without override
    void: 'pos:void',                 // void a line or a sale
    override: 'pos:override',         // approve a manager override (PIN)
    reports: 'pos:reports',           // X/Z + sales analytics
  },
  school: {
    read: 'school:read',
    enroll: 'school:enroll',
    issueTermFees: 'school:issue_term_fees',
    recordPayment: 'school:record_payment',
    manageSchedule: 'school:manage_schedule',
  },
  notifications: {
    read: 'notifications:read',
    write: 'notifications:write',
  },
  procurement: {
    purchaseRequest: {
      create: 'purchase_request:create',
      read: 'purchase_request:read',
      update: 'purchase_request:update',
      delete: 'purchase_request:delete',
      approve: 'purchase_request:approve',
      submit: 'purchase_request:submit',
    },
    purchaseOrder: {
      create: 'purchase_order:create',
      read: 'purchase_order:read',
      update: 'purchase_order:update',
      delete: 'purchase_order:delete',
      approve: 'purchase_order:approve',
      send: 'purchase_order:send',
      cancel: 'purchase_order:cancel',
    },
    goodsReceipt: {
      create: 'goods_receipt:create',
      read: 'goods_receipt:read',
      post: 'goods_receipt:post',
      cancel: 'goods_receipt:cancel',
    },
    threeWayMatch: {
      read: 'three_way_match:read',
      approve: 'three_way_match:approve',
      override: 'three_way_match:override',
    },
  },
  debitNote: {
    create: 'debit_note:create',
    read: 'debit_note:read',
    post: 'debit_note:post',
    cancel: 'debit_note:cancel',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
    delete: 'files:delete',
  },
  webhooks: {
    read: 'webhooks:read',
    write: 'webhooks:write',
    delete: 'webhooks:delete',
  },
  approvals: {
    read: 'approvals:read',
    decide: 'approvals:decide',
  },
  // ---- Frontend-facing management permissions (dot-notation) ----
  partners: {
    view: 'partners.view',
    create: 'partners.create',
    edit: 'partners.edit',
    delete: 'partners.delete',
  },
  products: {
    view: 'products.view',
    create: 'products.create',
    edit: 'products.edit',
    delete: 'products.delete',
  },
  menu: {
    view: 'menu.view',
    create: 'menu.create',
    edit: 'menu.edit',
    delete: 'menu.delete',
  },
  menuCategories: {
    view: 'menu_categories.view',
    create: 'menu_categories.create',
    edit: 'menu_categories.edit',
    delete: 'menu_categories.delete',
  },
  // NB: a top-level `organization` block already exists above (organization:*)
  // for the kernel-level organization entity; we do NOT redeclare it here.
} as const;

type PermissionLeaf<T> = T extends string ? T : T extends object ? PermissionLeaf<T[keyof T]> : never;
export type Permission = PermissionLeaf<typeof PERMISSIONS>;

/** Flattened list of every permission string (used for seeding the admin role). */
function flattenPermissions(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (input && typeof input === 'object') {
    return Object.values(input as Record<string, unknown>).flatMap(flattenPermissions);
  }
  return [];
}
export const ALL_PERMISSIONS: string[] = flattenPermissions(PERMISSIONS);