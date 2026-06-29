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
    const sep = key.includes(':') ? ':' : '.';
    const idx = key.lastIndexOf(sep);
    const resource = idx >= 0 ? key.slice(0, idx) : key;
    const action = idx >= 0 ? key.slice(idx + 1) : key;
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
    // Client directive: 0% tax everywhere. Keep the row (products link to it via
    // taxId) but at rate 0, and force existing rows to 0 on every reseed.
    const tax = await prisma.tax.upsert({
      where: { organizationId_name: { organizationId: org.id, name: 'VAT 18%' } },
      update: { rate: 0, name: 'No Tax', code: 'NOTAX' },
      create: { organizationId: org.id, name: 'No Tax', code: 'NOTAX', type: 'vat', rate: 0 },
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
  const accountDefs: { code: string; name: string; accountType: AccountType; isGroup?: boolean; cashFlowCategory?: 'operating' | 'investing' | 'financing' }[] = [
    { code: '1000', name: 'Assets', accountType: 'asset', isGroup: true, cashFlowCategory: 'investing' },
    { code: '1100', name: 'Cash', accountType: 'cash', cashFlowCategory: 'operating' },
    { code: '1200', name: 'Bank', accountType: 'bank', cashFlowCategory: 'operating' },
    { code: '1300', name: 'Accounts Receivable', accountType: 'receivable', cashFlowCategory: 'operating' },
    { code: '1400', name: 'Inventory / Stock Valuation', accountType: 'asset', cashFlowCategory: 'operating' },
    { code: '1450', name: 'Input VAT Receivable', accountType: 'asset', cashFlowCategory: 'operating' },
    { code: '2000', name: 'Liabilities', accountType: 'liability', isGroup: true, cashFlowCategory: 'financing' },
    { code: '2100', name: 'Accounts Payable', accountType: 'payable', cashFlowCategory: 'operating' },
    { code: '2150', name: 'Goods Received Not Invoiced (GRNI)', accountType: 'liability', cashFlowCategory: 'operating' },
    { code: '2200', name: 'Tax Payable', accountType: 'tax', cashFlowCategory: 'operating' },
    { code: '3000', name: 'Equity', accountType: 'equity', isGroup: true, cashFlowCategory: 'financing' },
    { code: '3100', name: 'Retained Earnings', accountType: 'equity', cashFlowCategory: 'financing' },
    { code: '4000', name: 'Revenue', accountType: 'revenue', isGroup: true, cashFlowCategory: 'operating' },
    { code: '4100', name: 'Sales Revenue', accountType: 'revenue', cashFlowCategory: 'operating' },
    { code: '5000', name: 'Expenses', accountType: 'expense', isGroup: true, cashFlowCategory: 'operating' },
    { code: '5100', name: 'Cost of Goods Sold', accountType: 'cost_of_goods_sold', cashFlowCategory: 'operating' },
    { code: '5200', name: 'Operating Expenses', accountType: 'expense', cashFlowCategory: 'operating' },
    { code: '5300', name: 'Stock Adjustment Expense', accountType: 'expense', cashFlowCategory: 'operating' },
    { code: '4200', name: 'Stock Adjustment Income', accountType: 'revenue', cashFlowCategory: 'operating' },
  ];
  const accountIds: Record<string, string> = {};
  for (const a of accountDefs) {
    const account = await prisma.account.upsert({
      where: { organizationId_code: { organizationId: org.id, code: a.code } },
      update: { name: a.name, accountType: a.accountType, isGroup: a.isGroup ?? false, cashFlowCategory: a.cashFlowCategory ?? null },
      create: {
        organizationId: org.id,
        code: a.code,
        name: a.name,
        accountType: a.accountType,
        isGroup: a.isGroup ?? false,
        cashFlowCategory: a.cashFlowCategory ?? null,
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
    { code: 'INV', name: 'Inventory Journal', journalType: 'general' },
    { code: 'ADJ', name: 'Adjustment Journal', journalType: 'adjustment' },
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
    // M3 — inventory → GL
    stock_valuation: accountIds['1400'],
    cogs: accountIds['5100'],
    grni_accrued: accountIds['2150'],
    stock_adjustment_income: accountIds['4200'],
    stock_adjustment_expense: accountIds['5300'],
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
  await prisma.tax.update({
    where: { id: tax.id },
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
      update: { runningAverageCost: 6 },
      create: { organizationId: org.id, productId: widget.id, locationId: warehouse.id, quantity: openingQty, runningAverageCost: 6 },
    });

    await prisma.inventoryLedger.upsert({
      where: { organizationId_ledgerCode: { organizationId: org.id, ledgerCode: 'STK/OPENING' } },
      update: { quantityChange: openingQty, balanceAfter: openingQty, unitCost: 6, totalValue: 600 },
      create: {
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

    // --- Sunrise Cafe demo data ----------------------------------------------
    // Adds cafe-specific categories + 12 products + stock + a cash register
    // so a cashier opening /pos/terminal for the first time has a populated
    // catalog and can open a shift without setup work.
    await seedSunriseCafe(org.id, warehouse.id, tax.id, accountIds['1100']);

    // --- Demo staff, menu items, and tables ---------------------------------
    await seedStaffMenuAndTables(org.id, adminRole.id);

    console.log('Seed complete (incl. chart of accounts, journals, account mappings, inventory).');
    console.log('Login -> organization: "DEMO", email: "admin@demo.test", password: "Admin@123"');
  }

  /** Sunrise Cafe demo data — categories, products, stock, cash register. */
    async function seedSunriseCafe(orgId: string, warehouseId: string, taxId: string, cashAccountId: string): Promise<void> {
      const categoryDefs: Array<{ name: string }> = [
        { name: 'Drinks' },
        { name: 'Mains' },
        { name: 'Desserts' },
        { name: 'Pastries' },
      ];
      const categories = new Map<string, string>();
      for (const c of categoryDefs) {
        const row = await prisma.productCategory.upsert({
          where: { organizationId_name: { organizationId: orgId, name: c.name } },
          update: {},
          create: { organizationId: orgId, name: c.name },
        });
        categories.set(c.name, row.id);
      }

    // Product catalog — 12 cafe items. Code is the SKU the cashier scans.
      const productDefs: Array<{
        code: string; sku: string; name: string; price: number; cost: number;
        category: string; productType: 'stockable' | 'service'; trackInventory: boolean;
        stock: number; minStock: number; taxInclusive: boolean;
      }> = [
      // Drinks — P10: priced VAT-inclusive (typical for Ugandan cafes).
          { code: 'P-COFFEE-S', sku: 'COF-S', name: 'Small Espresso', price: 5000, cost: 1500, category: 'Drinks', productType: 'service', trackInventory: false, stock: 0, minStock: 0, taxInclusive: true },
          { code: 'P-COFFEE-M', sku: 'COF-M', name: 'Medium Cappuccino', price: 8000, cost: 2500, category: 'Drinks', productType: 'service', trackInventory: false, stock: 0, minStock: 0, taxInclusive: true },
          { code: 'P-LATTE-L', sku: 'LAT-L', name: 'Large Café Latte', price: 12000, cost: 3500, category: 'Drinks', productType: 'service', trackInventory: false, stock: 0, minStock: 0, taxInclusive: true },
          { code: 'P-MOCHA', sku: 'MOCH', name: 'Caramel Mocha', price: 14000, cost: 4000, category: 'Drinks', productType: 'service', trackInventory: false, stock: 0, minStock: 0, taxInclusive: true },
          { code: 'P-TEA', sku: 'TEA', name: 'English Breakfast Tea', price: 6000, cost: 1000, category: 'Drinks', productType: 'service', trackInventory: false, stock: 0, minStock: 0, taxInclusive: true },
          { code: 'P-SMOOTHIE', sku: 'SMTH', name: 'Mango Smoothie', price: 15000, cost: 5000, category: 'Drinks', productType: 'stockable', trackInventory: true, stock: 30, minStock: 10, taxInclusive: true },
          // Mains — VAT additive (price excludes tax; tax added at checkout).
          { code: 'P-SAND-CLUB', sku: 'SND-CLUB', name: 'Club Sandwich', price: 18000, cost: 6000, category: 'Mains', productType: 'stockable', trackInventory: true, stock: 20, minStock: 5, taxInclusive: false },
          { code: 'P-BURGER', sku: 'BRG', name: 'Beef Burger + Chips', price: 22000, cost: 8000, category: 'Mains', productType: 'stockable', trackInventory: true, stock: 15, minStock: 5, taxInclusive: false },
          { code: 'P-PIZZA-M', sku: 'PZA-M', name: 'Margherita Pizza (M)', price: 25000, cost: 9000, category: 'Mains', productType: 'stockable', trackInventory: true, stock: 12, minStock: 4, taxInclusive: false },
          // Pastries — VAT-inclusive (the cafe's preferred display style).
          { code: 'P-CROISSANT', sku: 'CRS', name: 'Butter Croissant', price: 6000, cost: 2000, category: 'Pastries', productType: 'stockable', trackInventory: true, stock: 24, minStock: 6, taxInclusive: true },
          { code: 'P-CINNABON', sku: 'CNN', name: 'Cinnamon Roll', price: 8000, cost: 2500, category: 'Pastries', productType: 'stockable', trackInventory: true, stock: 18, minStock: 5, taxInclusive: true },
          // Desserts — VAT additive.
          { code: 'P-CAKE', sku: 'CAKE', name: 'Chocolate Cake Slice', price: 12000, cost: 4000, category: 'Desserts', productType: 'stockable', trackInventory: true, stock: 16, minStock: 4, taxInclusive: false },
    ];

    for (const p of productDefs) {
      const product = await prisma.product.upsert({
        where: { organizationId_code: { organizationId: orgId, code: p.code } },
        update: {
          name: p.name,
          salesPrice: p.price,
          costPrice: p.cost,
          productType: p.productType as any,
          trackInventory: p.trackInventory,
          minQuantity: p.minStock,
          categoryId: categories.get(p.category) ?? null,
          taxId,
          sku: p.sku,
          isActive: true,
          // P10: re-upsert the tax-inclusive flag every time the seed runs.
          taxInclusive: p.taxInclusive,
        },
        create: {
          organizationId: orgId,
          code: p.code,
          sku: p.sku,
          name: p.name,
          salesPrice: p.price,
          costPrice: p.cost,
          productType: p.productType as any,
          trackInventory: p.trackInventory,
          minQuantity: p.minStock,
          categoryId: categories.get(p.category) ?? null,
          taxId,
          isActive: true,
        },
      });

      // Opening stock for stockable items.
      if (p.trackInventory && p.stock > 0) {
        await prisma.stockItem.upsert({
          where: {
            organizationId_productId_locationId: {
              organizationId: orgId, productId: product.id, locationId: warehouseId,
            },
          },
          update: { quantity: p.stock, runningAverageCost: p.cost },
          create: {
            organizationId: orgId,
            productId: product.id,
            locationId: warehouseId,
            quantity: p.stock,
            runningAverageCost: p.cost,
          },
        });
      }
    }

    // Cash register so a cashier can open a shift.
      await prisma.cashRegister.upsert({
        where: { organizationId_code: { organizationId: orgId, code: 'MAIN-REG' } },
        update: { name: 'Main Counter Register', isActive: true, defaultAccountId: cashAccountId },
        create: {
          organizationId: orgId,
          code: 'MAIN-REG',
          name: 'Main Counter Register',
          isActive: true,
          defaultAccountId: cashAccountId,
        },
      });

    console.log('Sunrise Cafe demo data seeded (4 categories, 12 products, stock, MAIN-REG cash register).');
    }

  /** Demo staff, PIN, menu items, and tables for POS testing. */
  async function seedStaffMenuAndTables(orgId: string, adminRoleId: string): Promise<void> {
    const branch = await prisma.branch.findFirst({
      where: { organizationId: orgId, code: 'MAIN' },
    });

    // --- Admin PIN -----------------------------------------------------------
    const adminPinHash = await bcrypt.hash('1234', 10);
    const admin = await prisma.user.findFirst({
      where: { organizationId: orgId, email: 'admin@demo.test' },
    });
    if (admin) {
      await prisma.user.update({
        where: { id: admin.id },
        data: { pinHash: adminPinHash, pinHashRounds: 10 },
      });
    }

    // --- Staff roles ---------------------------------------------------------
    const cashierRole = await prisma.role.upsert({
      where: { organizationId_name: { organizationId: orgId, name: 'Cashier' } },
      update: {},
      create: {
        organizationId: orgId,
        name: 'Cashier',
        description: 'Can operate the POS terminal',
        isSystem: true,
        permissions: [
          'pos:read', 'pos:checkout', 'pos:hold', 'pos:discount', 'pos:void',
          'cash_session:open', 'cash_session:read', 'cash_session:close',
          'tables:view', 'tables:transfer',
          'partner:read',
          'partners.view',
          'products.view',
          'menu.view',
        ],
      },
    });

    const waiterRole = await prisma.role.upsert({
      where: { organizationId_name: { organizationId: orgId, name: 'Waiter' } },
      update: {},
      create: {
        organizationId: orgId,
        name: 'Waiter',
        description: 'Can take orders and manage tables',
        isSystem: true,
        permissions: [
          'pos:read',
          'tables:view', 'tables:transfer', 'tables:merge', 'tables:split',
          'partner:read',
          'partners.view',
          'products.view',
          'menu.view',
          'menu_categories.view',
        ],
      },
    });

    // --- Staff users ---------------------------------------------------------
    const staffDefs: Array<{
      email: string; firstName: string; lastName: string; roleName: string;
      password: string; pin: string;
    }> = [
      { email: 'sarah@demo.test', firstName: 'Sarah', lastName: 'Cashier', roleName: 'Cashier', password: 'Demo@123', pin: '1111' },
      { email: 'john@demo.test', firstName: 'John', lastName: 'Waiter', roleName: 'Waiter', password: 'Demo@123', pin: '2222' },
    ];

    for (const s of staffDefs) {
      const pwHash = await bcrypt.hash(s.password, 10);
      const pinHash = await bcrypt.hash(s.pin, 10);
      const role = await prisma.role.findFirst({
        where: { organizationId: orgId, name: s.roleName },
      });
      await prisma.user.upsert({
        where: { organizationId_email: { organizationId: orgId, email: s.email } },
        update: {
          firstName: s.firstName, lastName: s.lastName,
          roles: { set: role ? [{ id: role.id }] : [] },
          pinHash, pinHashRounds: 10,
          defaultBranchId: branch?.id ?? null,
        },
        create: {
          organizationId: orgId,
          email: s.email,
          passwordHash: pwHash,
          firstName: s.firstName,
          lastName: s.lastName,
          roles: { connect: role ? [{ id: role.id }] : [] },
          pinHash, pinHashRounds: 10,
          defaultBranchId: branch?.id ?? null,
        },
      });
    }

    // --- Menu categories ---------------------------------------------------
    const menuCatDefs = [
      { name: 'Coffee', displayOrder: 1 },
      { name: 'Tea & Other Drinks', displayOrder: 2 },
      { name: 'Mains', displayOrder: 3 },
      { name: 'Pastries', displayOrder: 4 },
      { name: 'Desserts', displayOrder: 5 },
    ];
    const menuCats = new Map<string, string>();
    for (const mc of menuCatDefs) {
      let row = await prisma.menuCategory.findFirst({
        where: { organizationId: orgId, name: mc.name, parentId: null },
      });
      if (!row) {
        row = await prisma.menuCategory.create({
          data: { organizationId: orgId, name: mc.name, displayOrder: mc.displayOrder },
        });
      } else if (row.displayOrder !== mc.displayOrder) {
        row = await prisma.menuCategory.update({
          where: { id: row.id },
          data: { displayOrder: mc.displayOrder },
        });
      }
      menuCats.set(mc.name, row.id);
    }

    // --- Menu items (linked to existing products) --------------------------
    const productCodes = [
      { code: 'P-COFFEE-S', cat: 'Coffee', price: 5000 },
      { code: 'P-COFFEE-M', cat: 'Coffee', price: 8000 },
      { code: 'P-LATTE-L', cat: 'Coffee', price: 12000 },
      { code: 'P-MOCHA', cat: 'Coffee', price: 14000 },
      { code: 'P-TEA', cat: 'Tea & Other Drinks', price: 6000 },
      { code: 'P-SMOOTHIE', cat: 'Tea & Other Drinks', price: 15000 },
      { code: 'P-SAND-CLUB', cat: 'Mains', price: 18000 },
      { code: 'P-BURGER', cat: 'Mains', price: 22000 },
      { code: 'P-PIZZA-M', cat: 'Mains', price: 25000 },
      { code: 'P-CROISSANT', cat: 'Pastries', price: 6000 },
      { code: 'P-CINNABON', cat: 'Pastries', price: 8000 },
      { code: 'P-CAKE', cat: 'Desserts', price: 12000 },
    ];

    for (let i = 0; i < productCodes.length; i++) {
      const pc = productCodes[i];
      const product = await prisma.product.findFirst({
        where: { organizationId: orgId, code: pc.code },
      });
      if (!product) continue;

      const menuItem = await prisma.menuItem.upsert({
        where: { organizationId_code: { organizationId: orgId, code: pc.code } },
        update: {
          basePrice: pc.price,
          categoryId: menuCats.get(pc.cat) ?? null,
          isAvailable: true,
        },
        create: {
          organizationId: orgId,
          code: pc.code,
          name: product.name,
          basePrice: pc.price,
          categoryId: menuCats.get(pc.cat) ?? null,
          isAvailable: true,
          displayOrder: i,
        },
      });

      await prisma.menuProduct.upsert({
        where: { menuItemId_productId: { menuItemId: menuItem.id, productId: product.id } },
        update: { quantity: 1 },
        create: {
          organizationId: orgId,
          menuItemId: menuItem.id,
          productId: product.id,
          quantity: 1,
        },
      });
    }

    // --- POS tables ---------------------------------------------------------
    const tableDefs = [
      { name: 'Table 1', number: 1, seats: 2, zone: 'indoor' as const, posX: 40, posY: 40 },
      { name: 'Table 2', number: 2, seats: 2, zone: 'indoor' as const, posX: 180, posY: 40 },
      { name: 'Table 3', number: 3, seats: 4, zone: 'indoor' as const, posX: 40, posY: 180 },
      { name: 'Table 4', number: 4, seats: 4, zone: 'indoor' as const, posX: 180, posY: 180 },
      { name: 'Table 5', number: 5, seats: 6, zone: 'outdoor' as const, posX: 40, posY: 320 },
      { name: 'Table 6', number: 6, seats: 6, zone: 'outdoor' as const, posX: 180, posY: 320 },
      { name: 'Bar Counter', number: 7, seats: 3, zone: 'bar' as const, posX: 320, posY: 40 },
    ];
    for (const t of tableDefs) {
      await prisma.posTable.upsert({
        where: { organizationId_number: { organizationId: orgId, number: t.number } },
        update: { name: t.name, seats: t.seats, zone: t.zone, active: true, status: 'available' },
        create: {
          organizationId: orgId,
          name: t.name,
          number: t.number,
          seats: t.seats,
          zone: t.zone,
          active: true,
          status: 'available',
          shape: 'square',
          posX: t.posX,
          posY: t.posY,
          width: 120,
          height: 120,
        },
      });
    }

    console.log('Demo staff (Sarah cashier 1111, John waiter 2222), menu (12 items), and 7 tables seeded.');
    console.log('Admin PIN: 1234');
  }

    main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
