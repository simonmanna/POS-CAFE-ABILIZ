/* Read-only audit harness: invokes current service methods with in-memory doubles.
 * No HTTP, database, credentials, sales, or production configuration are used.
 * Run from repository root: node docs/audit/2026-09-03-reproductions.cjs
 * Assertions capture OBSERVED DEFECTS, not desired behavior or release approval.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
process.env.TS_NODE_PROJECT = path.join(root, 'apps/api/tsconfig.json');
require(path.join(root, 'apps/api/node_modules/ts-node/register/transpile-only'));
const { PosOrdersService } = require(path.join(root, 'apps/api/src/modules/pos/order/pos-orders.service.ts'));
const { PosService } = require(path.join(root, 'apps/api/src/modules/pos/pos.service.ts'));
const { PosInvoiceService } = require(path.join(root, 'apps/api/src/modules/pos/billing/pos-invoice.service.ts'));
const { IdempotencyService } = require(path.join(root, 'apps/api/src/kernel/idempotency/idempotency.service.ts'));
const output = [];
const record = (name, observation) => output.push({ name, observation });
const noop = async () => {};

async function main() {
  const orders = Object.create(PosOrdersService.prototype);
  orders.tenant = { organizationId: 'audit-org', userId: 'audit-user' };
  orders.resolveSkus = async () => new Map();
  orders.prisma = { client: { product: { findFirst: async () => ({ station: 'kitchen' }) } } };
  orders.modifiers = { expandCombosForCheckout: async () => [
    { productId: 'sandwich', quantity: 6, comboPrice: 100 },
    { productId: 'drink', quantity: 3 },
  ] };
  const combo = await orders.resolveLines([{ comboId: 'meal', description: 'Meal', quantity: 3, unitPrice: 100 }]);
  assert.deepEqual(combo.map(x => x.quantity), [3, 3]);
  record('Combo component quantity discarded', { expected: [6, 3], actual: combo.map(x => x.quantity) });

  const a = orders.lineKey({ menuItemId: 'latte', variantName: 'large', note: 'oat', modifiers: ['oat'] });
  const b = orders.lineKey({ menuItemId: 'latte', variantName: 'large', note: 'dairy', modifiers: ['dairy'] });
  assert.equal(a, b);
  record('Different kitchen customizations have identical lifecycle keys', { oat: a, dairy: b });

  const pos = Object.create(PosService.prototype);
  assert.equal(pos.resolvePaymentMode([{ method: 'bank', amount: 100 }]), 'cash');
  record('Bank-only tender classified as cash', pos.resolvePaymentMode([{ method: 'bank', amount: 100 }]));

  let tickets = 0;
  const kitchen = Object.create(PosOrdersService.prototype);
  kitchen.tenant = orders.tenant;
  kitchen.prisma = { client: {
    order: { findFirst: async () => ({ id: 'o', orderNumber: 'O', status: 'in_progress' }) },
    orderItem: {
      findMany: async () => [{ id: 'i', productId: 'p', quantity: 1, kitchenPrintedQty: 0, modifiers: [] }],
      update: noop,
    },
  } };
  kitchen.stationForOrderItem = async () => 'kitchen';
  kitchen.prepTimeForItem = async () => null;
  kitchen.kds = { createTicketsForSale: async () => [`ticket-${++tickets}`] };
  kitchen.audit = { record: noop };
  kitchen.receipts = { printKotPaper: async () => ({ backend: 'mock', kotNumber: 1 }) };
  await Promise.all([kitchen.fireKitchen('o'), kitchen.fireKitchen('o')]);
  assert.equal(tickets, 2);
  record('Concurrent kitchen sends both dispatch the same pending quantity', { requests: 2, tickets });

  const billing = Object.create(PosInvoiceService.prototype);
  billing.tenant = orders.tenant;
  const updates = [];
  const invoice = {
    id: 'inv', invoiceNumber: 'AUDIT', partnerId: 'c', status: 'paid', paymentMode: 'cash',
    totalAmount: 100, amountResidual: 0, amountRefunded: 0,
    items: [{ id: 'i', quantity: 1, refundedQty: 0, subtotal: 10, taxAmount: 0, total: 10 }],
  };
  const tx = {
    $queryRawUnsafe: noop,
    invoice: { findFirst: async () => invoice, update: noop },
    invoiceItem: { update: async x => updates.push(x) },
    inventoryLocation: { findFirst: async () => null },
  };
  billing.prisma = {
    client: { $transaction: cb => cb(tx) },
    raw: { setting: { findFirst: async () => null } },
  };
  billing.determination = { mapped: async () => 'revenue' };
  billing.refundCounterAccount = async () => 'cash';
  billing.posting = { post: noop };
  billing.createReceipt = noop;
  billing.audit = { record: noop };
  billing.events = { publish: () => {} };
  const refund = await billing.partialRefund('inv', [{ lineId: 'i', quantity: 1 }, { lineId: 'i', quantity: 1 }], 'audit', {});
  assert.equal(refund.amount, '20');
  assert.deepEqual(updates.map(x => String(x.data.refundedQty)), ['1', '1']);
  record('Duplicate refund line accepted twice but cumulative quantity remains one', { refundAmount: refund.amount, quantityWrites: updates.map(x => String(x.data.refundedQty)) });

  let saved = null;
  let committedBusinessOperations = 0;
  let failCompletion = true;
  const idem = Object.create(IdempotencyService.prototype);
  idem.tenant = orders.tenant;
  idem.logger = { warn: () => {} };
  idem.prisma = { client: { idempotencyRecord: {
    findUnique: async () => saved,
    create: async ({ data }) => { saved = { ...data }; },
    update: async ({ data }) => { if (failCompletion) { failCompletion = false; throw new Error('completion write interrupted'); } saved = { ...saved, ...data }; },
    delete: async () => { saved = null; },
  } } };
  const request = { key: 'audit-key', requestHash: 'same-body', runHandler: async () => ({ statusCode: 200, body: { operation: ++committedBusinessOperations } }) };
  await assert.rejects(idem.executeWithKey(request), /completion write interrupted/);
  await idem.executeWithKey(request);
  assert.equal(committedBusinessOperations, 2);
  record('Idempotency completion-write failure allows committed handler to run twice', { committedBusinessOperations });

  const settle = Object.create(PosService.prototype);
  settle.tenant = orders.tenant;
  settle.logger = { error: () => {} };
  settle.prisma = { client: { splitBill: { count: async () => 0 } } };
  let automaticRefunds = 0;
  settle.billing = {
    generateInvoice: async () => ({ id: 'already-paid', invoiceNumber: 'PAID' }),
    receivePayment: async () => { throw new Error('Invoice is already fully paid'); },
    refund: async () => { automaticRefunds++; },
  };
  await assert.rejects(settle.settleResolvedOrder({ id: 'order' }, { tenders: [{ method: 'cash', amount: 100 }] }), /already fully paid/);
  assert.equal(automaticRefunds, 1);
  record('Already-paid payment rejection triggers an automatic refund', { automaticRefunds });
  console.log(JSON.stringify({ scope: 'Current service code with in-memory doubles; no live transactions', findings: output }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
