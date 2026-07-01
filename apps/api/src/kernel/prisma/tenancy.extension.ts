import { Prisma } from '@prisma/client';
import type { TenantContextService } from '../tenancy/tenant-context.service';

/**
 * Models that carry a (non-null) organizationId and must be auto-scoped.
 * NOTE: Setting has a nullable organizationId and is handled manually in
 * SettingsService, so it is intentionally excluded here.
 */
const ORG_SCOPED = new Set<string>([
  'User',
  'Role',
  'RefreshToken',
  'AuditLog',
  'Partner',
  'PartnerCategory',
  'Contact',
  'Address',
  'Product',
  'ProductCategory',
  'UnitOfMeasure',
  'Tax',
  'FiscalPeriod',
  'Branch',
  // Phase 2 — accounting
  'Account',
  'Journal',
  'JournalEntry',
  'JournalLine',
  'AccountMapping',
  'BankAccount',
  // Phase 3 — documents / AR
  'Document',
  'DocumentLine',
  'Payment',
  'PaymentAllocation',
  // Phase 4 — inventory
  'InventoryLocation',
  'StockItem',
  'InventoryBatch',
  'InventoryLedger',
  // F.8 — inventory masters + stock document wrappers
  'Brand',
  'ProductVariant',
  'StockOut',
  'StockOutItem',
  'WasteRecord',
  'WasteItem',
  'StockAdjustment',
  'StockAdjustmentItem',
  'StockTransfer',
  'StockTransferItem',
  // Inventory count sessions (opening/closing physical counts)
  'InventoryCountSession',
  'InventoryCountLine',
  // M5 — cash sessions (CashRegister is config, sessions/movements are transactional)
  'CashRegister',
  'CashSession',
  'CashMovement',
  // D1-2 — idempotency cache (org-scoped transactional; no soft delete)
  'IdempotencyRecord',
  // D3 — reporting snapshots (no soft delete; rebuilt periodically)
  'ReportTrialBalanceSnapshot',
  'ReportPnLSnapshot',
  'ReportBalanceSheetSnapshot',
  'ReportApAgingSnapshot',
  'ReportTieoutSnapshot',
  // D4-3 — transactional outbox (no soft delete; rows are shipped and kept)
  'EventOutbox',
  // F.5 — Notifications, files, approvals, recurring, webhooks, feature flags
  'Notification',
  'NotificationPreference',
  'File',
  'OneTimeToken',
  'ApprovalRequest',
  'ApprovalDecision',
  'ApprovalPolicy',
  'RecurringDocument',
  'RecurringDocumentRun',
  'WebhookEndpoint',
  'WebhookDelivery',
  'FeatureFlag',
  'SavedReport',
  'SavedReportRun',
  'OrganizationModule',
  // F.6 — Procurement chain (transactional lines use status, not soft delete)
  'PurchaseRequest',
  'PurchaseRequestLine',
  'PurchaseOrder',
  'PurchaseOrderLine',
  'GoodsReceiptNote',
  'GoodsReceiptLine',
  'VendorBillLink',
  'ThreeWayMatch',
  // F.6 — Debit notes
  'DebitNote',
  'DebitNoteLine',
  // F.6 — Push notification subscriptions
  'PushSubscription',
  // F.6 — Append-only audit trail (no soft delete, no UPDATE/DELETE)
  'DomainEventLog',
  // F.7 — CRM pipeline
  'Deal',
  'Activity',
  // POS Phase A — held orders
  'PosHold',
  'PosHoldLine',
  // POS Phase D — Modifiers + Combos (P4)
  'ModifierGroup',
  'Modifier',
  'ProductModifierGroup',
  'MenuItemModifierGroup',
  'Combo',
  'ComboItem',
  // POS Phase D — Variants + Accompaniments
  'MenuItemVariant',
  'AccompanimentGroup',
  'AccompanimentOption',
  'MenuItemAccompanimentGroup',
  // POS Phase D — KDS (P5)
  'KitchenTicket',
  // POS Phase E — Loyalty + Store Credit + Customer Tabs (P7)
  'LoyaltyProgram',
  'LoyaltyLedger',
  'StoreCredit',
  'StoreCreditLedger',
  'CustomerTab',
  'CustomerTabLedger',
  // POS — Menu Management (categories, items, ingredient links)
  'MenuCategory',
  'MenuItem',
  'MenuProduct',
  // POS Phase F — Digital Menu (Phase 1 MVP)
  'MenuQrSession',
  'OnlineOrder',
  // POS Phase T1 — Tables Management (ADR-012)
  'PosTable',
  'PosTableOrder',
  'PosTableReservation',
  // POS Order → Invoice → Receipt domain (DDD split)
  'Order',
  'OrderItem',
  'OrderItemModifier',
  'Receipt',
  'ReceiptItem',
  // POS R2 — Invoice pulled out of Document
  'Invoice',
  'InvoiceItem',
  'InvoiceItemModifier',
  // POS — Split bills (dine-in bill splitting)
  'SplitBill',
  'SplitBillItem',
  // Standalone expenses (petty-cash / operating expenses)
  'Expense',
  'ExpenseCategory',
  'ExpensePayment',
]);

/** Models with a `deletedAt` column → soft-delete filtering on reads/writes. */
const SOFT_DELETE = new Set<string>([
  'User',
  'Role',
  'Partner',
  'PartnerCategory',
  'Contact',
  'Address',
  'Product',
  'ProductCategory',
  'UnitOfMeasure',
  'Tax',
  'FiscalPeriod',
  'Branch',
  // F.8 — inventory masters carry deletedAt
  'Brand',
  'ProductVariant',
  // Phase 2 config/master (transactional records use status, not soft delete)
  'Account',
  'Journal',
  'AccountMapping',
  'BankAccount',
  // Phase 4 — inventory (locations are config; quants/batches/ledger are not soft-deleted)
  'InventoryLocation',
  // Count session header carries deletedAt (lines cascade with the session)
  'InventoryCountSession',
  // M5 — cash register is config; sessions/movements use status, not soft-delete
  'CashRegister',
  // F.5 — Webhook endpoints are config; deliveries are immutable.
  'WebhookEndpoint',
  // F.6 — Procurement config (transactional records use status, not soft delete)
  'PurchaseRequest',
  'PurchaseOrder',
  'GoodsReceiptNote',
  // F.6 — Debit notes (config; lines are transactional)
  'DebitNote',
  // F.7 — Deals are config (transactional records use status)
  'Deal',
  // Standalone expenses — Expense + ExpenseCategory carry deletedAt
  // (ExpensePayment uses a status column, not soft delete).
  'Expense',
  'ExpenseCategory',
  // POS — Menu Configuration (variants, accompaniments, modifiers)
  'MenuItemVariant',
  'AccompanimentGroup',
  'AccompanimentOption',
  'ModifierGroup',
  'Modifier',
  'ProductModifierGroup',
  'MenuItemModifierGroup',
  'MenuItemAccompanimentGroup',
]);

const WHERE_OPS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

export function isOrgScoped(model: string): boolean {
  return ORG_SCOPED.has(model);
}

/**
 * Pure transform that injects organizationId (and a soft-delete filter) into a
 * Prisma operation's args. Exported for unit testing; the extension below wraps
 * it. Returns the (mutated) args.
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  organizationId: string,
): Record<string, unknown> {
  const orgScoped = ORG_SCOPED.has(model);
  const softDelete = SOFT_DELETE.has(model);
  const a = (args ?? {}) as Record<string, unknown>;
  if (!orgScoped && !softDelete) return a;

  if (operation === 'create') {
    const data = (a.data ?? {}) as Record<string, unknown>;
    if (orgScoped && data.organizationId === undefined) data.organizationId = organizationId;
    a.data = data;
  } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
    if (orgScoped) {
      if (Array.isArray(a.data)) {
        a.data = a.data.map((d: Record<string, unknown>) => ({ organizationId, ...d }));
      } else if (a.data) {
        a.data = { organizationId, ...(a.data as Record<string, unknown>) };
      }
    }
  } else if (WHERE_OPS.has(operation)) {
    const where = (a.where ?? {}) as Record<string, unknown>;
    if (orgScoped) where.organizationId = organizationId;
    if (softDelete && operation !== 'upsert' && where.deletedAt === undefined) {
      where.deletedAt = null;
    }
    a.where = where;
  }

  return a;
}

/**
 * Central tenancy + soft-delete enforcement (ADR-004). Reads the current
 * organizationId from AsyncLocalStorage at query time, so a single extended
 * client serves every request.
 */
export function tenancyExtension(tenant: TenantContextService) {
  return Prisma.defineExtension({
    name: 'tenancy-soft-delete',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!model || (!ORG_SCOPED.has(model) && !SOFT_DELETE.has(model))) {
            return query(args);
          }
          const scoped = scopeArgs(model, operation, args, tenant.organizationId);
          return query(scoped);
        },
      },
    },
  });
}
