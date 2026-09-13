import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS, MANAGER_PERMISSIONS } from '@erp/shared';

/**
 * Cash-management role policy (release gate). The seed and the migration that
 * provisions existing organizations must grant exactly these capabilities.
 */
describe('cash-management role policy', () => {
  const seed = readFileSync(join(__dirname, '../../../prisma/seed.ts'), 'utf8');
  const list = (name: string) => {
    const start = seed.indexOf(`const ${name} = [`);
    if (start < 0) throw new Error(`${name} not found in seed`);
    const body = seed.slice(start, seed.indexOf('];', start));
    return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  const MONEY_CONTROLS = [
    'expense:create', 'expense:post', 'expense:cancel', 'expense:approve',
    'treasury:transfer', 'cash_session:force_close', 'cash_session:correct',
    'cash_session:approve_variance', 'cash_session:reconcile', 'payment:void',
  ];

  it('every manager permission exists in the catalog', () => {
    const all = new Set(ALL_PERMISSIONS);
    expect(MANAGER_PERMISSIONS.filter((p) => !all.has(p))).toEqual([]);
  });

  it('waiters hold no money controls', () => {
    expect(list('waiterPerms').filter((p) => MONEY_CONTROLS.includes(p) || p.startsWith('cash_session:'))).toEqual([]);
  });

  it('cashiers can sell and run their own shift, but approve nothing and move no treasury money', () => {
    const cashier = list('cashierPerms');
    expect(cashier).toEqual(expect.arrayContaining(['pos:checkout', 'cash_session:open', 'cash_session:close']));
    expect(cashier.filter((p) => MONEY_CONTROLS.includes(p))).toEqual([]);
  });

  it('managers hold every money control', () => {
    expect([...MANAGER_PERMISSIONS]).toEqual(expect.arrayContaining(MONEY_CONTROLS));
  });

  it('the provisioning migration grants the same manager list as the seed', () => {
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/20260914000200_manager_role/migration.sql'), 'utf8');
    const first = /ARRAY\[([^\]]*)\]/.exec(sql)![1];
    expect([...first.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()).toEqual([...MANAGER_PERMISSIONS].sort());
  });
});
