import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  ALL_PERMISSIONS,
  type AccountType,
  type JournalType,
  type ProductType,
} from '@erp/shared';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // --- Global currencies ----------------------------------------------------
  const currencies = [
    { code: 'USD', symbol: '$', name: 'US Dollar', decimalPlaces: 2 },
    { code: 'EUR', symbol: 'EUR', name: 'Euro', decimalPlaces: 2 },
    { code: 'UGX', symbol: 'USh', name: 'Ugandan Shilling', decimalPlaces: 0 },
  ];
  for (const c of currencies) {
    await prisma.currency.upsert({ where: { code: c.code }, update: c, create: c });
  }

  // --- Global permission catalog -------------------------------------------
  for (const key of ALL_PERMISSIONS) {
    const [resource, action] = key.split(':');
    await prisma.permission.upsert({
      where: { key },
      update: { resource, action },
      create: { key, resource, action },
    });
  }

  // --- Organization (tenant) -----------------------------------------------
  const org = await prisma.organization.upsert({
    where: { code: 'DEMO' },
    update: {},
    create: { code: 'DEMO', name: 'Demo Organization', currencyCode: 'USD', timezone: 'UTC' },
  });

  // --- Administrator role (all permissions) --------------------------------
  const adminRole = await prisma.role.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Administrator' } },
    update: { permissions: ALL_PERMISSIONS },
    create: {
      organizationId: org.id,
      name: 'Administrator',
      description: 'Full platform access',
      isSystem: true,
      permissions: ALL_PERMISSIONS,
    },
  });

  // --- Admin user -----------------------------------------------------------
  const passwordHash = await bcrypt.hash('Admin@123', 10);
  await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: 'admin@demo.test' } },
    update: { roles: { set: [{ id: adminRole.id }] } },
    create: {
      organizationId: org.id,
      email: 'admin@demo.test',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      roles: { connect: [{ id: adminRole.id }] },
    },
  });

  // --- Units of measure -----------------------------------------------------
  const uoms = [
    { code: 'UNIT', name: 'Piece', category: 'unit', ratio: 1, isBase: true },
    { code: 'KG', name: 'Kilogram', category: 'weight', ratio: 1, isBase: true },
    { code: 'G', name: 'Gram', category: 'weight', ratio: 0.001, isBase: false },
    { code: 'L', name: 'Liter', category: 'volume', ratio: 1, isBase: true },
    { code: 'HR', name: 'Hour', category: 'time', ratio: 1, isBase: true },
  ];
  for (const u of uoms) {
    await prisma.unitOfMeasure.upsert({
      where: { organizationId_code: { organizationId: org.id, code: u.code } },
      update: u,
      create: { organizationId: org.id, ...u },
    });
  }

  // --- Tax ------------------------------------------------------------------
  await prisma.tax.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'VAT 18%' } },
    update: {},
    create: { organizationId: org.id, name: 'VAT 18%', code: 'VAT18', type: 'vat', rate: 18 },
  });

  // --- Categories -----------------------------------------------------------
  const productCategory = await prisma.productCategory.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'General' } },
    update: {},
    create: { organizationId: org.id, name: 'General' },
  });
  const partnerCategory = await prisma.partnerCategory.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'General' } },
    update: {},
    create: { organizationId: org.id, name: 'General' },
  });

  // --- Sample partners ------------------------------------------------------
  const partners = [
    { code: 'CUST-001', name: 'Acme Retail Ltd', isCustomer: true, isCompany: true, email: 'orders@acme.test' },
    { code: 'SUPP-001', name: 'Global Supplies Co', isSupplier: true, isCompany: true, email: 'sales@globalsupplies.test' },
  ];
  for (const p of partners) {
    await prisma.partner.upsert({
      where: { organizationId_code: { organizationId: org.id, code: p.code } },
      update: {},
      create: { organizationId: org.id, categoryId: partnerCategory.id, ...p },
    });
  }

  // --- Sample products ------------------------------------------------------
  const baseUom = await prisma.unitOfMeasure.findFirst({
    where: { organizationId: org.id, code: 'UNIT' },
  });
  const products: { code: string; name: string; productType: ProductType; salesPrice: number; costPrice: number }[] = [
    { code: 'PRD-001', name: 'Generic Widget', productType: 'stockable', salesPrice: 10, costPrice: 6 },
    { code: 'SRV-001', name: 'Consulting Hour', productType: 'service', salesPrice: 50, costPrice: 0 },
  ];
  for (const p of products) {
    await prisma.product.upsert({
      where: { organizationId_code: { organizationId: org.id, code: p.code } },
      update: {},
      create: { organizationId: org.id, categoryId: productCategory.id, uomId: baseUom?.id, ...p },
    });
  }

  // --- Fiscal period (current year) ----------------------------------------
  const year = new Date().getFullYear();
  await prisma.fiscalPeriod.upsert({
    where: { organizationId_name: { organizationId: org.id, name: `FY${year}` } },
    update: {},
    create: {
      organizationId: org.id,
      name: `FY${year}`,
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31)),
      status: 'open',
    },
  });

  // --- Branch ---------------------------------------------------------------
  await prisma.branch.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'MAIN' } },
    update: {},
    create: { organizationId: org.id, code: 'MAIN', name: 'Head Office' },
  });

  // --- Chart of accounts (Phase 2) -----------------------------------------
  const accountDefs: { code: string; name: string; accountType: AccountType; isGroup?: boolean }[] = [
    { code: '1000', name: 'Assets', accountType: 'asset', isGroup: true },
    { code: '1100', name: 'Cash', accountType: 'cash' },
    { code: '1200', name: 'Bank', accountType: 'bank' },
    { code: '1300', name: 'Accounts Receivable', accountType: 'receivable' },
    { code: '1400', name: 'Inventory', accountType: 'asset' },
    { code: '1450', name: 'Input VAT Receivable', accountType: 'asset' },
    { code: '2000', name: 'Liabilities', accountType: 'liability', isGroup: true },
    { code: '2100', name: 'Accounts Payable', accountType: 'payable' },
    { code: '2200', name: 'Tax Payable', accountType: 'tax' },
    { code: '3000', name: 'Equity', accountType: 'equity', isGroup: true },
    { code: '3100', name: 'Retained Earnings', accountType: 'equity' },
    { code: '4000', name: 'Revenue', accountType: 'revenue', isGroup: true },
    { code: '4100', name: 'Sales Revenue', accountType: 'revenue' },
    { code: '5000', name: 'Expenses', accountType: 'expense', isGroup: true },
    { code: '5100', name: 'Cost of Goods Sold', accountType: 'cost_of_goods_sold' },
    { code: '5200', name: 'Operating Expenses', accountType: 'expense' },
  ];
  const accountIds: Record<string, string> = {};
  for (const a of accountDefs) {
    const account = await prisma.account.upsert({
      where: { organizationId_code: { organizationId: org.id, code: a.code } },
      update: { name: a.name, accountType: a.accountType, isGroup: a.isGroup ?? false },
      create: {
        organizationId: org.id,
        code: a.code,
        name: a.name,
        accountType: a.accountType,
        isGroup: a.isGroup ?? false,
      },
    });
    accountIds[a.code] = account.id;
  }

  // --- Journals -------------------------------------------------------------
  const journalDefs: {
    code: string;
    name: string;
    journalType: JournalType;
    defaultDebitAccountId?: string;
  }[] = [
    { code: 'GEN', name: 'General Journal', journalType: 'general' },
    { code: 'SALES', name: 'Sales Journal', journalType: 'sales' },
    { code: 'PURCH', name: 'Purchase Journal', journalType: 'purchase' },
    { code: 'CASH', name: 'Cash Journal', journalType: 'cash', defaultDebitAccountId: accountIds['1100'] },
    { code: 'BANK', name: 'Bank Journal', journalType: 'bank', defaultDebitAccountId: accountIds['1200'] },
  ];
  for (const j of journalDefs) {
    await prisma.journal.upsert({
      where: { organizationId_code: { organizationId: org.id, code: j.code } },
      update: { name: j.name, journalType: j.journalType },
      create: { organizationId: org.id, ...j },
    });
  }

  // --- Account determination mappings --------------------------------------
  const mappings: Record<string, string> = {
    accounts_receivable: accountIds['1300'],
    accounts_payable: accountIds['2100'],
    sales_revenue: accountIds['4100'],
    tax_payable: accountIds['2200'],
    tax_receivable: accountIds['1450'],
    default_cash: accountIds['1100'],
    default_bank: accountIds['1200'],
    default_expense: accountIds['5200'],
    retained_earnings: accountIds['3100'],
  };
  for (const [key, accountId] of Object.entries(mappings)) {
    await prisma.accountMapping.upsert({
      where: { organizationId_key: { organizationId: org.id, key } },
      update: { accountId },
      create: { organizationId: org.id, key, accountId },
    });
  }

  // --- Link master data to accounts ----------------------------------------
  await prisma.productCategory.update({
    where: { id: productCategory.id },
    data: { incomeAccountId: accountIds['4100'], expenseAccountId: accountIds['5100'] },
  });
  await prisma.tax.updateMany({
    where: { organizationId: org.id, name: 'VAT 18%' },
    data: { accountId: accountIds['2200'] },
  });

  // --- Inventory (Phase 4) --------------------------------------------------
  const warehouse = await prisma.inventoryLocation.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'MAIN' } },
    update: {},
    create: { organizationId: org.id, code: 'MAIN', name: 'Main Warehouse', type: 'warehouse' },
  });

  const widget = await prisma.product.findFirst({
    where: { organizationId: org.id, code: 'PRD-001' },
  });
  if (widget) {
    await prisma.product.update({
      where: { id: widget.id },
      data: { trackInventory: true, minQuantity: 10 },
    });

    const openingQty = 100;
    await prisma.stockItem.upsert({
      where: { organizationId_productId_locationId: { organizationId: org.id, productId: widget.id, locationId: warehouse.id } },
      update: {},
      create: { organizationId: org.id, productId: widget.id, locationId: warehouse.id, quantity: openingQty },
    });

    await prisma.inventoryLedger.create({
      data: {
        organizationId: org.id,
        ledgerCode: 'STK/OPENING',
        productId: widget.id,
        locationId: warehouse.id,
        type: 'opening_balance',
        quantityChange: openingQty,
        balanceAfter: openingQty,
        unitCost: 6,
        totalValue: 600,
        notes: 'Opening balance from seed',
      },
    });
  }

  console.log('Seed complete (incl. chart of accounts, journals, account mappings, inventory).');
  console.log('Login -> organization: "DEMO", email: "admin@demo.test", password: "Admin@123"');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
