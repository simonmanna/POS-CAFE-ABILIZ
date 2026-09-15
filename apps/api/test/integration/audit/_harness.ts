import { purge } from '../_purge';
/**
 * Shared bootstrap for the inventory audit specs.
 *
 * AUDIT ARTEFACT — these specs exist to prove or disprove the hypotheses in the
 * Inventory + POS audit. A failing assertion here is a FINDING, not a broken
 * test. Nothing in `src/` is modified by this suite.
 */
import { PrismaClient } from '@prisma/client';
import { ensureAccountCategories, makeAccountFactory } from '../_accounts';

export interface AuditOrg {
  organizationId: string;
  mainLocationId: string;
  altLocationId: string;
  accounts: Record<string, string>;
}

/**
 * Create an isolated organization with the chart of accounts, journals and
 * account mappings the stock engine needs to post. Mirrors the setup in
 * `inventory-engine.spec.ts` so behaviour is comparable across suites.
 */
export async function createAuditOrg(prisma: PrismaClient, tag: string): Promise<AuditOrg> {
  const org = await prisma.organization.create({
    data: { code: `AUD-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: `Audit ${tag}`, currencyCode: 'UGX' },
  });
  const organizationId = org.id;

  const mk = makeAccountFactory(prisma, await ensureAccountCategories(prisma));
  const stockValuation = await mk(organizationId, `${tag}-1400`, 'Stock Valuation', 'inventory');
  const cogs = await mk(organizationId, `${tag}-5100`, 'COGS', 'cost_of_goods_sold');
  const grni = await mk(organizationId, `${tag}-2150`, 'GRNI', 'current_liability');
  const adjExpense = await mk(organizationId, `${tag}-5900`, 'Stock Adj Expense', 'operating_expense');
  const adjIncome = await mk(organizationId, `${tag}-4900`, 'Stock Adj Income', 'other_income');
  const ppv = await mk(organizationId, `${tag}-5320`, 'Purchase Price Variance', 'operating_expense');
  const wht = await mk(organizationId, `${tag}-2160`, 'Withholding Tax Payable', 'current_liability');
  const payable = await mk(organizationId, `${tag}-2100`, 'Accounts Payable', 'payable');
  const receivable = await mk(organizationId, `${tag}-1200`, 'Accounts Receivable', 'receivable');
  const revenue = await mk(organizationId, `${tag}-4000`, 'Sales Revenue', 'revenue');
  const taxAcct = await mk(organizationId, `${tag}-2200`, 'Tax Payable', 'tax');
  const cash = await mk(organizationId, `${tag}-1000`, 'Cash', 'cash');
  const bank = await mk(organizationId, `${tag}-1200B`, 'Bank', 'bank');

  for (const [code, name] of [
    ['INV', 'Inventory'],
    ['ADJ', 'Adjustments'],
    ['SALES', 'Sales'],
    ['PURCH', 'Purchases'],
    ['BANK', 'Bank'],
    ['CASH', 'Cash'],
    ['GEN', 'General'],
  ] as const) {
    await prisma.journal.create({ data: { organizationId, code, name, journalType: 'general' } });
  }

  const accounts: Record<string, string> = {
    stock_valuation: stockValuation.id,
    cogs: cogs.id,
    grni_accrued: grni.id,
    stock_adjustment_expense: adjExpense.id,
    stock_adjustment_income: adjIncome.id,
    purchase_price_variance: ppv.id,
    withholding_payable: wht.id,
    default_expense: adjExpense.id,
    accounts_payable: payable.id,
    accounts_receivable: receivable.id,
    sales_revenue: revenue.id,
    tax_payable: taxAcct.id,
    cash: cash.id,
    default_cash: cash.id,
    bank: bank.id,
    default_bank: bank.id,
  };
  for (const [key, accountId] of Object.entries(accounts)) {
    await prisma.accountMapping.create({ data: { organizationId, key, accountId } });
  }

  const mainLocationId = (
    await prisma.inventoryLocation.create({
      data: { organizationId, code: 'MAIN', name: 'Main Store', type: 'warehouse', isActive: true },
    })
  ).id;
  const altLocationId = (
    await prisma.inventoryLocation.create({
      data: { organizationId, code: 'ALT', name: 'Second Store', type: 'warehouse', isActive: true },
    })
  ).id;

  // Production policy requires an explicit POS stock location when an
  // organization has more than one warehouse.
  await prisma.setting.create({
    data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: mainLocationId as any },
  });

  return { organizationId, mainLocationId, altLocationId, accounts };
}

/**
 * Delete an audit org. Order matters: several inventory tables hold RESTRICT
 * FKs on InventoryLocation and on InvoiceItem.
 */
export async function dropAuditOrg(prisma: PrismaClient, organizationId?: string) {
  if (!organizationId) return;
  const p = prisma as any;
  const tables = [
    'invoiceItemRecipeIngredient',
    'inventoryLedger',
    'inventorySerial',
    'inventoryBatch',
    'stockItem',
    'inventoryCountLine',
    'inventoryCountSession',
    'stockAdjustmentItem',
    'stockAdjustment',
    'stockTransferReceipt',
    'stockTransferItem',
    'stockTransfer',
    'landedCostAllocation',
    'landedCostCharge',
    'landedCost',
    'stockOutItem',
    'stockOut',
    'wasteItem',
    'wasteRecord',
    'stockReservation',
    'inventoryException',
    'stockPostingJob',
    'paymentAllocation',
    'payment',
    'posRefund',
    'invoiceItem',
    'invoice',
    'orderItem',
    'order',
    'documentLine',
    'document',
    'purchaseOrderLine',
    'purchaseOrder',
    'vendorBillReceiptMatch',
    'goodsReceiptLine',
    'goodsReceiptNote',
    'vendorBillLink',
    'menuProduct',
    'menuItem',
    'journalLine',
    'journalEntry',
    'fiscalPeriod',
    'auditLog',
    'eventOutbox',
    'approvalRequest',
    'accountMapping',
    'setting',
    'account',
    'journal',
    'productVariant',
    'product',
    'partner',
    'inventoryLocation',
  ];
  for (const t of tables) {
    try {
      if (p[t]?.deleteMany) await purge(p, (tx) => tx[t].deleteMany({ where: { organizationId } }));
    } catch {
      /* table not org-scoped or already empty — audit teardown is best-effort */
    }
  }
  try {
    await prisma.organization.delete({ where: { id: organizationId } });
  } catch {
    /* leftover FK: leave the row, the code is unique per run */
  }
}

/** Signed sum of every ledger row for a product, optionally at one location. */
export async function ledgerSum(
  prisma: PrismaClient,
  organizationId: string,
  productId: string,
  locationId?: string,
) {
  const agg = await prisma.inventoryLedger.aggregate({
    where: { organizationId, productId, ...(locationId ? { locationId } : {}) },
    _sum: { quantityChange: true },
  });
  return Number(agg._sum.quantityChange ?? 0);
}

/** Cached quant for a (product, variant, location). */
export async function onHand(
  prisma: PrismaClient,
  organizationId: string,
  productId: string,
  locationId: string,
  variantId?: string | null,
) {
  const si = await prisma.stockItem.findFirst({
    where: { organizationId, productId, variantKey: variantId ?? '', locationId },
  });
  return Number(si?.quantity ?? 0);
}

/** Net movement (debits − credits) on one GL account. */
export async function accountBalance(prisma: PrismaClient, organizationId: string, accountId: string) {
  const agg = await prisma.journalLine.aggregate({
    where: { organizationId, accountId },
    _sum: { debit: true, credit: true },
  });
  return Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0);
}

/** Ledger quantity grouped by StockMoveType — the classification view. */
export async function movementsByType(prisma: PrismaClient, organizationId: string, productId: string) {
  const rows = await prisma.inventoryLedger.groupBy({
    by: ['type'],
    where: { organizationId, productId },
    _sum: { quantityChange: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type as string] = Number(r._sum.quantityChange ?? 0);
  return out;
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
