/**
 * Shared kit for the Lakeview business simulation (M3+): boots the real Nest
 * modules on a disposable database, builds the company, and exposes the
 * independent L3 extraction helpers the oracle compares against.
 */
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { MANAGER_PERMISSIONS } from '@erp/shared';
import { scopedPrisma } from '../scoped-prisma';
import { ensureAccountCategories, makeAccountFactory } from '../integration/_accounts';
import { KernelModule } from '../../src/kernel/kernel.module';
import { DocumentsModule } from '../../src/modules/documents/documents.module';
import { CoreModule } from '../../src/modules/core/core.module';
import { InventoryModule } from '../../src/modules/inventory/inventory.module';
import { AccountingModule } from '../../src/modules/accounting/accounting.module';
import { ProcurementModule } from '../../src/modules/procurement/procurement.module';
import { InvoicingModule } from '../../src/modules/invoicing/invoicing.module';
import { PosModule } from '../../src/modules/pos/pos.module';
import { PrismaService } from '../../src/kernel/prisma/prisma.service';
import { TenantContextService } from '../../src/kernel/tenancy/tenant-context.service';
import { BUSINESS_POLICY } from './policy';
import { D } from './oracle';

export const simEnabled = () =>
  process.env.SIM_RUN === '1' && !!process.env.DATABASE_URL && /^\/pos_stage1_\d+$/.test(new URL(process.env.DATABASE_URL).pathname);

export const PIN = '4321';
export const VAT = BUSINESS_POLICY.tax.standardRatePercent;
export const CASHIER = ['pos:read', 'pos:checkout', 'pos:discount', 'pos:credit', 'pos:refund', 'cash_session:open', 'cash_session:read', 'cash_session:close'];
export const WAITER = ['pos:read', 'pos:checkout'];
export const STOREKEEPER = ['inventory:read', 'inventory_doc:create', 'inventory_count:submit', 'purchase_order:read'];
export const AUDITOR = ['pos:read', 'pos:reports', 'accounting:read', 'inventory:read'];

export const STOCK: Record<string, { name: string; unitCost: number; qty: number }> = {
  BEANS_G: { name: 'Coffee beans (g)', unitCost: 60, qty: 20_000 },
  MILK_ML: { name: 'Fresh milk (ml)', unitCost: 4, qty: 40_000 },
  CUP_M: { name: 'Cup medium', unitCost: 300, qty: 500 },
  LID_M: { name: 'Lid medium', unitCost: 100, qty: 500 },
  BUN: { name: 'Burger bun', unitCost: 800, qty: 150 },
  CHICKEN: { name: 'Chicken fillet', unitCost: 6_000, qty: 150 },
  WATER_500: { name: 'Water 500ml', unitCost: 1_200, qty: 300 },
  BEER: { name: 'Nile Special 500ml', unitCost: 4_500, qty: 120 },
};
export const MENU: Record<string, { name: string; price: number; recipe: Record<string, number> }> = {
  ESPRESSO: { name: 'Espresso', price: 6_000, recipe: { BEANS_G: 18 } },
  CAPP_M: { name: 'Cappuccino M', price: 10_000, recipe: { BEANS_G: 18, MILK_ML: 200, CUP_M: 1, LID_M: 1 } },
  BURGER: { name: 'Chicken burger', price: 28_000, recipe: { BUN: 1, CHICKEN: 1 } },
};
export const DIRECT: Record<string, { price: number; vat: boolean }> = { WATER_500: { price: 2_500, vat: false }, BEER: { price: 7_000, vat: true } };

export interface Sim {
  organizationId: string;
  raw: PrismaClient;
  db: PrismaClient;
  moduleRef: TestingModule;
  tenant: TenantContextService;
  get<T>(cls: new (...a: any[]) => T): T;
  acc: Record<string, string>;
  users: Record<string, string>;
  perms: Record<string, string[]>;
  prod: Record<string, string>;
  menu: Record<string, string>;
  tax: Record<string, string>;
  loc: Record<string, string>;
  registers: Record<string, string>;
  as<T>(who: string, fn: () => Promise<T>): Promise<T>;
  balance(accountKey: string): Promise<ReturnType<typeof D>>;
  onHand(sku: string, locKey?: string): Promise<ReturnType<typeof D>>;
  trialBalance(): Promise<{ debit: string; credit: string }>;
  unbalancedEntries(): Promise<number>;
  duplicatePostingKeys(): Promise<number>;
  invoicesWithoutPosting(): Promise<number>;
  close(): Promise<void>;
}

export async function bootSim(tag: string): Promise<Sim> {
  const organizationId = randomUUID();
  const raw = new PrismaClient();
  await raw.$connect();
  const db = scopedPrisma(raw, () => organizationId);
  const moduleRef = await Test.createTestingModule({
    imports: [KernelModule, DocumentsModule, CoreModule, InventoryModule, AccountingModule, ProcurementModule, InvoicingModule, PosModule],
  }).overrideProvider(PrismaService).useValue({ client: db, raw: db }).compile();
  await moduleRef.init();
  const tenant = moduleRef.get(TenantContextService);
  const sim: Sim = {
    organizationId, raw, db, moduleRef, tenant,
    get: (cls) => moduleRef.get(cls, { strict: false }),
    acc: {}, users: {}, perms: {}, prod: {}, menu: {}, tax: {}, loc: {}, registers: {},
    as: (who, fn) => tenant.run({ organizationId, userId: sim.users[who], permissions: sim.perms[who] } as any, fn),
    balance: async (key) => {
      const r: any[] = await raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit" - l."baseCredit"),0)::text b FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."journalEntryId" WHERE l."organizationId" = $1 AND l."accountId" = $2 AND e.status IN ('posted','reversed')`, organizationId, sim.acc[key] ?? key);
      return D(r[0].b);
    },
    onHand: async (sku, locKey = 'ACA') => D((await db.stockItem.findFirst({ where: { organizationId, productId: sim.prod[sku], locationId: sim.loc[locKey], variantKey: '' } }))?.quantity ?? 0),
    trialBalance: async () => {
      const r: any[] = await raw.$queryRawUnsafe(`SELECT COALESCE(SUM(l."baseDebit"),0)::text d, COALESCE(SUM(l."baseCredit"),0)::text c FROM "JournalLine" l JOIN "JournalEntry" e ON e.id=l."journalEntryId" WHERE l."organizationId"=$1 AND e.status IN ('posted','reversed')`, organizationId);
      return { debit: r[0].d, credit: r[0].c };
    },
    unbalancedEntries: async () => ((await raw.$queryRawUnsafe(`SELECT e.id FROM "JournalEntry" e JOIN "JournalLine" l ON l."journalEntryId"=e.id WHERE e."organizationId"=$1 GROUP BY e.id HAVING SUM(l."baseDebit") <> SUM(l."baseCredit")`, organizationId)) as any[]).length,
    duplicatePostingKeys: async () => ((await raw.$queryRawUnsafe(`SELECT "postingKey" FROM "JournalEntry" WHERE "organizationId"=$1 AND "postingKey" IS NOT NULL GROUP BY "postingKey" HAVING COUNT(*)>1`, organizationId)) as any[]).length,
    invoicesWithoutPosting: async () => ((await raw.$queryRawUnsafe(`SELECT i.id FROM "Invoice" i WHERE i."organizationId"=$1 AND i.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceId"=i.id AND e."sourceType"='pos_invoice')`, organizationId)) as any[]).length,
    close: async () => { await moduleRef.close(); await raw.$disconnect(); },
  };
  await buildLakeview(sim, tag);
  return sim;
}

async function buildLakeview(sim: Sim, tag: string) {
  const { db, organizationId, acc, users, perms, prod, menu, tax, loc, registers } = sim;
  await db.currency.upsert({ where: { code: 'UGX' }, update: { decimalPlaces: 0 }, create: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh', decimalPlaces: 0 } });
  await db.organization.create({ data: { id: organizationId, code: `LAKEVIEW-${tag}-${Date.now()}`, name: 'Lakeview Café & Grill Ltd', currencyCode: 'UGX', timezone: BUSINESS_POLICY.timezone } });

  const pin = await bcrypt.hash(PIN, 10);
  const roleOf = async (name: string, p: string[]) => db.role.create({ data: { organizationId, name, permissions: p } });
  const roles: Record<string, { id: string; p: string[] }> = {};
  for (const [name, p] of Object.entries({ manager: [...MANAGER_PERMISSIONS, 'inventory_doc:approve', 'inventory_count:submit'], cashier: CASHIER, waiter: WAITER, storekeeper: STOREKEEPER, auditor: AUDITOR })) {
    roles[name] = { id: (await roleOf(name, p)).id, p };
  }
  const mkUser = async (key: string, role: string, extra: Record<string, unknown> = {}) => {
    users[key] = (await db.user.create({ data: { organizationId, email: `${key}@lakeview.test`, firstName: key, passwordHash: 'x', pinHash: pin, roles: { connect: { id: roles[role].id } }, ...extra } as any })).id;
    perms[key] = roles[role].p;
  };
  await mkUser('manager', 'manager');
  await mkUser('manager2', 'manager');
  await mkUser('cashier', 'cashier');
  await mkUser('cashier2', 'cashier');
  await mkUser('waiter', 'waiter');
  await mkUser('waiter2', 'waiter');
  await mkUser('storekeeper', 'storekeeper');
  await mkUser('auditor', 'auditor');

  const mk = makeAccountFactory(db, await ensureAccountCategories(db));
  const plan: Record<string, any> = {
    drawer: 'cash', drawer2: 'cash', safe: 'cash', bank: 'bank', mtn: 'mobile_money', airtel: 'mobile_money', card: 'current_asset',
    ar: 'receivable', ap: 'payable', revenue: 'revenue', outputVat: 'tax', inputVat: 'tax', cogs: 'cost_of_goods_sold', inventory: 'inventory',
    transit: 'inventory', grni: 'current_liability', wht: 'current_liability', shortOver: 'operating_expense', expense: 'operating_expense',
    fees: 'operating_expense', waste: 'operating_expense', adjIncome: 'other_income', ppv: 'operating_expense', equity: 'equity',
    retained: 'equity', storeCredit: 'current_liability', rounding: 'operating_expense',
  };
  let n = 1000;
  for (const [k, cat] of Object.entries(plan)) acc[k] = (await mk(organizationId, String(n++), k, cat)).id;
  for (const [code, type] of [['SALES', 'sales'], ['CASH', 'cash'], ['BANK', 'bank'], ['GEN', 'general'], ['INV', 'general'], ['PURCH', 'purchase'], ['ADJ', 'adjustment'], ['CLOSING', 'general']] as const) {
    await db.journal.create({ data: { organizationId, code, name: code, journalType: type as any } });
  }
  const mappings: Record<string, string> = {
    accounts_receivable: acc.ar, accounts_payable: acc.ap, sales_revenue: acc.revenue, default_cash: acc.safe, default_bank: acc.bank,
    card_clearing: acc.card, mobile_money: acc.mtn, cash_short_over: acc.shortOver, withholding_payable: acc.wht,
    stock_valuation: acc.inventory, inventory: acc.inventory, stock_in_transit: acc.transit, cogs: acc.cogs, grni_accrued: acc.grni,
    default_expense: acc.expense, store_credit: acc.storeCredit, stock_adjustment_expense: acc.waste, stock_adjustment_income: acc.adjIncome,
    purchase_price_variance: acc.ppv, tax_payable: acc.outputVat, tax_receivable: acc.inputVat, retained_earnings: acc.retained, rounding: acc.rounding,
  };
  for (const [key, accountId] of Object.entries(mappings)) await db.accountMapping.create({ data: { organizationId, key, accountId } });
  await db.posPaymentMethod.createMany({ data: [
    { organizationId, code: 'cash', label: 'Cash', kind: 'cash', accountId: acc.drawer, trackInShift: false },
    { organizationId, code: 'mtn', label: 'MTN MoMo', kind: 'mobile_money', accountId: acc.mtn, trackInShift: true },
    { organizationId, code: 'airtel', label: 'Airtel Money', kind: 'mobile_money', accountId: acc.airtel, trackInShift: true },
    { organizationId, code: 'card', label: 'Card', kind: 'card', accountId: acc.card, trackInShift: false },
  ] as any });
  tax.vat = (await db.tax.create({ data: { organizationId, name: 'VAT 18%', rate: VAT, isInclusive: true, accountId: acc.outputVat } })).id;
  tax.exempt = (await db.tax.create({ data: { organizationId, name: 'Exempt', rate: 0, isInclusive: true, vatCategory: 'exempt' } })).id;

  loc.ACA = (await db.inventoryLocation.create({ data: { organizationId, code: 'ACA', name: 'Acacia Café store', type: 'warehouse', isActive: true } })).id;
  loc.CW = (await db.inventoryLocation.create({ data: { organizationId, code: 'CW', name: 'Central Warehouse', type: 'warehouse', isActive: true } })).id;
  await db.setting.create({ data: { organizationId, scopeType: 'organization', scopeId: '', key: 'pos.stockLocationId', value: loc.ACA as any } });
  registers.COUNTER = (await db.cashRegister.create({ data: { organizationId, code: 'ACA-COUNTER', name: 'Acacia counter', defaultAccountId: acc.drawer, locationId: loc.ACA } })).id;
  registers.BAR = (await db.cashRegister.create({ data: { organizationId, code: 'ACA-BAR', name: 'Acacia bar', defaultAccountId: acc.drawer2, locationId: loc.ACA } })).id;
  acc.walkin = (await db.partner.create({ data: { organizationId, code: 'WALKIN', name: 'Walk-in', isCustomer: true } })).id;
  acc.techHub = (await db.partner.create({ data: { organizationId, code: 'KTH', name: 'Kampala Tech Hub', isCustomer: true, creditLimit: 5_000_000 } as any })).id;
  acc.kakira = (await db.partner.create({ data: { organizationId, code: 'KAKIRA', name: 'Kakira Beans', isSupplier: true } })).id;
  acc.dairy = (await db.partner.create({ data: { organizationId, code: 'DAIRY', name: 'Fresh Dairy', isSupplier: true } })).id;

  for (const [sku, s] of Object.entries(STOCK)) {
    const direct = DIRECT[sku];
    prod[sku] = (await db.product.create({ data: { organizationId, code: sku, name: s.name, productType: 'stockable', trackInventory: true, costingMethod: 'AVCO', costPrice: s.unitCost,
      ...(direct ? { salesPrice: direct.price, taxId: direct.vat ? tax.vat : tax.exempt, taxInclusive: true } : { salesPrice: 0 }) } as any })).id;
  }
  for (const [code, m] of Object.entries(MENU)) {
    menu[code] = (await db.menuItem.create({ data: { organizationId, code, name: m.name, basePrice: m.price, taxId: tax.vat, isInventoryTracked: true,
      ingredients: { create: Object.entries(m.recipe).map(([sku, q]) => ({ organizationId, productId: prod[sku], quantity: q })) } } })).id;
  }
}

export function kampalaDate(d: Date | string) {
  return new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** mulberry32 — tiny deterministic PRNG so a seed reproduces the whole day. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export type Item = { kind: 'menu' | 'direct'; sku: string; qty: number };
export type Op = { n: number; kind: 'counter' | 'table' | 'refund'; till: 'COUNTER' | 'BAR'; items: Item[]; tender: 'cash' | 'mtn' | 'card' | 'mixed'; discount: number };

export function planDay(seed: number, count: number): Op[] {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const menu = Object.keys(MENU), direct = Object.keys(DIRECT);
  const ops: Op[] = [];
  for (let n = 0; n < count; n++) {
    const roll = r();
    const kind = roll < 0.7 ? 'counter' : roll < 0.95 ? 'table' : 'refund';
    const items: Item[] = Array.from({ length: 1 + Math.floor(r() * 3) }, () => (r() < 0.75 ? { kind: 'menu', sku: pick(menu), qty: 1 + Math.floor(r() * 2) } : { kind: 'direct', sku: pick(direct), qty: 1 + Math.floor(r() * 2) }));
    const t = r();
    ops.push({ n, kind, till: r() < 0.6 ? 'COUNTER' : 'BAR', items, tender: t < 0.35 ? 'cash' : t < 0.7 ? 'mtn' : t < 0.9 ? 'card' : 'mixed', discount: r() < 0.08 ? 10 : 0 });
  }
  return ops;
}

