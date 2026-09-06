/**
 * PHASE 14 — Isolated audit org provisioner.
 * Creates a brand-new organization "POS-AUDIT-<ts>" with:
 *   - 4 users (admin/manager/supervisor/cashier) with bcrypt PINs
 *   - Roles mirroring the production seed (Cashier/Waiter/Supervisor/Kitchen/Admin)
 *   - Full COA (categories via shared seed list, accounts, mappings, journals)
 *   - Warehouse + stock, register + drawer account, payment methods
 *     (cash, MTN, Airtel, bank, card), tax rate, deterministic products
 *   - Walk-in customer
 * Writes audit/org-<id>.json with every id needed by the drivers.
 *
 * READ-WRITE but ISOLATED: touches only rows under its own new organizationId.
 * Existing orgs are never modified. Idempotent per run (new org each run).
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const bcrypt = require(path.join(process.cwd(), 'apps', 'api', 'node_modules', 'bcryptjs'));
const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));
const { ACCOUNT_CATEGORY_SEED } = require(path.join(process.cwd(), 'packages', 'shared', 'dist', 'cjs', 'accounting', 'account-category.js'));

const CONN = 'postgresql://cafe-pos:cafe-pos@localhost:5432/cafe-pos';
const OUT_DIR = path.join(process.cwd(), 'audit');

const CASHIER_PERMS = ['pos:read', 'pos:checkout', 'pos:hold', 'pos:discount', 'pos:void', 'pos:kds', 'cash_session:open', 'cash_session:read', 'cash_session:close', 'tables:view', 'tables:transfer', 'tables:edit', 'partner:read', 'partners.view', 'products.view', 'menu.view'];
const WAITER_PERMS = ['pos:read', 'pos:checkout', 'pos:hold', 'pos:kds', 'tables:view', 'tables:transfer', 'tables:merge', 'tables:split', 'tables:edit', 'partner:read', 'partners.view', 'products.view', 'menu.view', 'menu_categories.view'];
const SUPERVISOR_PERMS = ['inventory_count:read', 'inventory_count:submit', 'inventory:read', 'inventory:move', 'inventory_location:read', 'inventory_doc:read', 'inventory_doc:create', 'inventory_doc:approve', 'product:read', 'products.view', 'partner:read', 'pos:read', 'pos:reports', 'pos:kds'];
const KITCHEN_PERMS = ['pos:read', 'pos:kds'];
const ALL_PERMS = [
  ...new Set([
    ...CASHIER_PERMS, ...WAITER_PERMS, ...SUPERVISOR_PERMS, ...KITCHEN_PERMS,
    'pos:refund', 'pos:override', 'pos:write_off', 'pos:reports', 'pos:close_session', 'pos:reopen',
    'cash_session:approve_variance', 'cash_session:reopen', 'cash_session:reconcile', 'cash_session:cash_out',
    'partner:create', 'partner:update', 'product:create', 'product:update', 'setting:update',
  ]),
];

async function main() {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const orgId = randomUUID();
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const ids = { orgId, users: {}, roles: {}, accounts: {}, productCategories: {}, products: {}, tax: {}, paymentMethods: {}, register: {}, warehouse: {}, walkin: {}, pin: { admin: '2468', manager: '1357', supervisor: '9573', cashier: '8642' }, passwords: { admin: 'Audit@123', manager: 'Audit@123', supervisor: 'Audit@123', cashier: 'Audit@123' } };

  try {
    await c.query('BEGIN');
    // Currency (global) — idempotent
    await c.query(`INSERT INTO "Currency" (id, code, name, symbol, "updatedAt") VALUES ($1,'UGX','Ugandan Shilling','USh',NOW()) ON CONFLICT (code) DO NOTHING`, [randomUUID()]);
    // Org
    await c.query(`INSERT INTO "Organization" (id, code, name, "currencyCode", "createdAt", "updatedAt") VALUES ($1,$2,$3,'UGX', NOW(), NOW())`, [orgId, `AUDIT-${stamp}`, `POS-AUDIT-${stamp}`]);

    // Account categories (global, system-seeded — same list the app seeds)
    const cat = {};
    for (const d of ACCOUNT_CATEGORY_SEED) {
      const r = await c.query(
        `INSERT INTO "AccountCategory" (id, key, name, description, classification, "normalBalance", "reportSection", "cashFlowClass", "isContra", "isCashEquivalent", "allowReconciliation", "allowManualPosting", "allowBudgeting", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [randomUUID(), d.key, d.name, d.description ?? null, d.classification, d.normalBalance, d.reportSection, d.cashFlowClass ?? 'operating', d.isContra ?? false, d.isCashEquivalent ?? false, d.allowReconciliation ?? false, d.allowManualPosting ?? true, d.allowBudgeting ?? false],
      );
      cat[d.key] = r.rows[0].id;
    }

    // Accounts (COA mirror of seed for the POS path)
    const mkAcct = async (code, name, catKey) => {
      const nb = ACCOUNT_CATEGORY_SEED.find((d) => d.key === catKey).normalBalance;
      const r = await c.query(`INSERT INTO "Account" (id, "organizationId", code, name, "categoryId", "normalBalance", "isActive", "allowManualPosting", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,true,true,NOW(),NOW()) RETURNING id`,
        [randomUUID(), orgId, code, name, cat[catKey], nb]);
      return r.rows[0].id;
    };
    ids.accounts.ar = await mkAcct('1300', 'Accounts Receivable', 'receivable');
    ids.accounts.revenue = await mkAcct('4100', 'Sales Revenue', 'revenue');
    ids.accounts.tax = await mkAcct('2300', 'Output VAT', 'tax');
    ids.accounts.cogs = await mkAcct('5100', 'Cost of Goods Sold', 'cost_of_goods_sold');
    ids.accounts.stockVal = await mkAcct('1400', 'Inventory Valuation', 'inventory');
    ids.accounts.rounding = await mkAcct('9999', 'Rounding Difference', 'other_expense');
    ids.accounts.mmMtn = await mkAcct('2110', 'MTN Mobile Money', 'mobile_money');
    ids.accounts.mmAirtel = await mkAcct('2120', 'Airtel Money', 'mobile_money');
    ids.accounts.bank = await mkAcct('1200', 'Bank', 'bank');
    ids.accounts.card = await mkAcct('1210', 'Card Clearing', 'bank');
    ids.accounts.storeCredit = await mkAcct('2350', 'Store Credit Liability', 'current_liability');
    ids.accounts.expense = await mkAcct('5200', 'Operating Expense', 'operating_expense');
    ids.accounts.shortOver = await mkAcct('5300', 'Cash Short/Over', 'operating_expense');

    // Journals
    for (const [code, name, type] of [['SALES', 'Sales', 'sales'], ['CASH', 'Cash', 'cash'], ['BANK', 'Bank', 'bank'], ['INV', 'Inventory', 'general'], ['GEN', 'General', 'general'], ['ADJ', 'Adjustment', 'adjustment'], ['PURCH', 'Purchases', 'purchase']]) {
      await c.query(`INSERT INTO "Journal" (id, "organizationId", code, name, "journalType", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`, [randomUUID(), orgId, code, name, type]);
    }

    // Mappings (keys the POS path resolves)
    for (const [key, accId] of [
      ['accounts_receivable', ids.accounts.ar], ['sales_revenue', ids.accounts.revenue], ['default_cash', ids.accounts.expense === null ? null : ids.accounts.shortOver === null ? null : null],
    ]) { /* placeholder — replaced below */ }
    const map = async (key, accountId) => c.query(`INSERT INTO "AccountMapping" (id, "organizationId", key, "accountId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,NOW(),NOW())`, [randomUUID(), orgId, key, accountId]);
    await map('accounts_receivable', ids.accounts.ar);
    await map('sales_revenue', ids.accounts.revenue);
    // Drawer account is register-scoped; default_cash points at the drawer created below.
    ids.accounts.drawer = await mkAcct('1101', 'Audit Drawer', 'cash');
    await map('default_cash', ids.accounts.drawer);
    await map('output_tax', ids.accounts.tax);
    await map('cogs', ids.accounts.cogs);
    await map('stock_valuation', ids.accounts.stockVal);
    await map('mobile_money', ids.accounts.mmMtn); // first MM; per-tender account overrides below
    await map('default_bank', ids.accounts.bank);
    await map('card_clearing', ids.accounts.card);
    await map('store_credit', ids.accounts.storeCredit);
    await map('rounding', ids.accounts.rounding);
    await map('default_expense', ids.accounts.expense);
    await map('cash_short_over', ids.accounts.shortOver);

    // Users + roles
    const mkUser = async (email, first, pin, password) => {
      const pinHash = bcrypt.hashSync(pin, 10);
      const passwordHash = bcrypt.hashSync(password, 10);
      const r = await c.query(`INSERT INTO "User" (id, "organizationId", email, "firstName", "lastName", "passwordHash", "pinHash", "isActive", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,'Audit',$5,$6,true,NOW(),NOW()) RETURNING id`,
        [randomUUID(), orgId, email, first, passwordHash, pinHash]);
      return r.rows[0].id;
    };
    ids.users.admin = await mkUser(`audit-admin-${stamp}@pos.test`, 'Admin', ids.pin.admin, ids.passwords.admin);
    ids.users.manager = await mkUser(`audit-manager-${stamp}@pos.test`, 'Manager', ids.pin.manager, ids.passwords.manager);
    ids.users.supervisor = await mkUser(`audit-sup-${stamp}@pos.test`, 'Supervisor', ids.pin.supervisor, ids.passwords.supervisor);
    ids.users.cashier = await mkUser(`audit-cashier-${stamp}@pos.test`, 'Cashier', ids.pin.cashier, ids.passwords.cashier);

    const mkRole = async (name, perms) => {
      const list = [...new Set(perms)];
      const r = await c.query(`INSERT INTO "Role" (id, "organizationId", name, description, permissions, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING id`,
        [randomUUID(), orgId, name, `Audit ${name}`, list]);
      return r.rows[0].id;
    };
    ids.roles.admin = await mkRole('Administrator', ALL_PERMS);
    ids.roles.manager = await mkRole('Manager', ['pos:read', 'pos:checkout', 'pos:override', 'pos:refund', 'pos:write_off', 'pos:discount', 'pos:reports', 'pos:close_session', 'cash_session:open', 'cash_session:read', 'cash_session:close', 'cash_session:approve_variance', 'cash_session:cash_out', 'partner:read', 'tables:view', 'tables:edit', 'tables:transfer']);
    ids.roles.cashier = await mkRole('Cashier', CASHIER_PERMS);
    ids.roles.waiter = await mkRole('Waiter', WAITER_PERMS);
    ids.roles.supervisor = await mkRole('Supervisor', SUPERVISOR_PERMS);
    ids.roles.kitchen = await mkRole('Kitchen', KITCHEN_PERMS);

    for (const [user, role] of [['admin', 'admin'], ['manager', 'manager'], ['cashier', 'cashier'], ['supervisor', 'supervisor']]) {
      await c.query(`INSERT INTO "_UserRoles" ("A", "B") VALUES ($2,$1)`, [ids.users[user], ids.roles[role]]);
    }

    // Product category + products
    const pc = await c.query(`INSERT INTO "ProductCategory" (id, "organizationId", name, "createdAt", "updatedAt") VALUES ($1,$2,'Audit Goods',NOW(),NOW()) RETURNING id`, [randomUUID(), orgId]);
    ids.productCategories.main = pc.rows[0].id;
    const mkProduct = async (code, name, salesPrice, costPrice, opts = {}) => {
      const r = await c.query(
        `INSERT INTO "Product" (id, "organizationId", code, name, "productType", "salesPrice", "costPrice", "categoryId", "trackInventory", "costingMethod", "stockPolicy", "taxId", "isActive", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,NOW(),NOW()) RETURNING id`,
        [randomUUID(), orgId, code, name, opts.type ?? 'stockable', salesPrice, costPrice, ids.productCategories.main, opts.track ?? true, 'AVCO', 'silent', opts.taxId ?? null],
      );
      ids.products[code] = r.rows[0].id;
      return ids.products[code];
    };
    // Tax: 18% inclusive (matches production P-LATTE-L semantics)
    const tax = await c.query(`INSERT INTO "Tax" (id, "organizationId", code, name, rate, "isInclusive", type, "isActive", "createdAt", "updatedAt") VALUES ($1,$2,'AUD-VAT18','Audit VAT 18%',18.0,true,'vat',true,NOW(),NOW()) RETURNING id`,
      [randomUUID(), orgId]);
    ids.tax.vat18 = tax.rows[0].id;

    await mkProduct('AUD-TEA', 'Audit Tea', 3000, 1500, { taxId: null });
    await mkProduct('AUD-COFFEE', 'Audit Coffee (taxed)', 5000, 2000, { taxId: ids.tax.vat18 });
    await mkProduct('AUD-CAKE', 'Audit Cake', 8000, 4000);
    await mkProduct('AUD-ZERO', 'Audit Zero Stock', 2000, 1000); // no stock seeded
    await mkProduct('AUD-LOW', 'Audit Low Stock', 6000, 3000);
    await mkProduct('AUD-SVC', 'Audit Service', 10000, 0, { type: 'service', track: false });

    // Warehouse + opening stock (audit-initial stock ledger rows — the seed gap noted in F-D)
    const wh = await c.query(`INSERT INTO "InventoryLocation" (id, "organizationId", code, name, type, "isActive", "createdAt", "updatedAt") VALUES ($1,$2,'AUD-WH','Audit Warehouse','warehouse',true,NOW(),NOW()) RETURNING id`, [randomUUID(), orgId]);
    ids.warehouse.id = wh.rows[0].id;
    const seedStock = async (code, qty, cost) => {
      const productId = ids.products[code];
      const si = await c.query(`INSERT INTO "StockItem" (id, "organizationId", "productId", "variantKey", "locationId", quantity, "runningAverageCost", "createdAt", "updatedAt") VALUES ($1,$2,$3,'',$4,$5,$6,NOW(),NOW()) ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), orgId, productId, ids.warehouse.id, qty, cost]);
      await c.query(`INSERT INTO "InventoryLedger" (id, "organizationId", "ledgerCode", "productId", "locationId", type, "qtyBefore", "quantityChange", "balanceAfter", "unitCost", "totalValue", "createdAt")
        VALUES ($1,$2,$3,$4,$5,'opening_balance',0,$6,$6,$7,$8,NOW())`,
        [randomUUID(), orgId, `AUD-OB-${code}`, productId, ids.warehouse.id, qty, cost, cost * qty]);
      return si.rows[0]?.id;
    };
    await seedStock('AUD-TEA', 100, 1500);
    await seedStock('AUD-COFFEE', 100, 2000);
    await seedStock('AUD-CAKE', 50, 4000);
    await seedStock('AUD-LOW', 2, 3000); // deliberately low → negative-stock test

    // Register (drawer account) + payment methods
    const reg = await c.query(`INSERT INTO "CashRegister" (id, "organizationId", code, name, "defaultAccountId", "isActive", "createdAt", "updatedAt") VALUES ($1,$2,'AUD-REG1','Audit Till 1',$3,true,NOW(),NOW()) RETURNING id`,
      [randomUUID(), orgId, ids.accounts.drawer]);
    ids.register.id = reg.rows[0].id;

    const mkMethod = async (code, label, kind, accountId, provider = null) => {
      const r = await c.query(
        `INSERT INTO "PosPaymentMethod" (id, "organizationId", code, label, kind, provider, "accountId", "sortOrder", "isActive", "requiresReference", "trackInShift", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,false,true,NOW(),NOW()) RETURNING id`,
        [randomUUID(), orgId, code, label, kind, provider, accountId, 0],
      );
      ids.paymentMethods[code] = r.rows[0].id;
    };
    await mkMethod('cash', 'Cash', 'cash', null);
    await mkMethod('momo_mtn', 'MTN MoMo', 'mobile_money', ids.accounts.mmMtn, 'MTN');
    await mkMethod('momo_airtel', 'Airtel Money', 'mobile_money', ids.accounts.mmAirtel, 'Airtel');
    await mkMethod('bank_main', 'Bank', 'bank', ids.accounts.bank);
    await mkMethod('card_main', 'Card', 'card', ids.accounts.card);

    // Walk-in customer
    const wi = await c.query(`INSERT INTO "Partner" (id, "organizationId", code, name, "isCustomer", "creditLimit", "creditHold", "createdAt", "updatedAt") VALUES ($1,$2,'WALKIN','Walk-in Customer',true,0,false,NOW(),NOW()) RETURNING id`,
      [randomUUID(), orgId]);
    ids.walkin.id = wi.rows[0].id;
    // Credit customer (limit 100,000)
    const cc = await c.query(`INSERT INTO "Partner" (id, "organizationId", code, name, "isCustomer", "creditLimit", "creditHold", "createdAt", "updatedAt") VALUES ($1,$2,'AUD-CREDIT','Audit Credit Cust',true,100000,false,NOW(),NOW()) RETURNING id`,
      [randomUUID(), orgId]);
    ids.creditCustomer = cc.rows[0].id;

    await c.query('COMMIT');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `org-${stamp}.json`), JSON.stringify(ids, null, 2));
    console.log(JSON.stringify({ ok: true, orgId, stamp, orgFile: `audit/org-${stamp}.json`, users: { admin: ids.users.admin, cashier: ids.users.cashier, manager: ids.users.manager } }));
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('PROVISION FAILED: ' + e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}
main();
