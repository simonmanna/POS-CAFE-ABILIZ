import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const auth: any = { state: { organization: { id: 'org-a' }, user: { id: 'cashier-a' } }, listeners: new Set<() => void>() };
  auth.getState = () => auth.state;
  auth.subscribe = (fn: () => void) => { auth.listeners.add(fn); return () => auth.listeners.delete(fn); };
  const pos = { getState: () => ({ user: null }), subscribe: () => () => {} };
  return { auth, pos, post: vi.fn() };
});
vi.mock('@/stores/auth.store', () => ({ useAuthStore: mocks.auth }));
vi.mock('@/features/pos/pos-auth.store', () => ({ usePosAuthStore: mocks.pos }));
vi.mock('@/lib/api', () => ({ api: { post: mocks.post }, getApiBaseUrl: () => '' }));

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  get length() { return this.data.size; }
}

beforeEach(() => {
  vi.resetModules(); mocks.post.mockReset(); mocks.auth.listeners.clear();
  mocks.auth.state = { organization: { id: 'org-a' }, user: { id: 'cashier-a' } };
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
});

describe('POS write-ahead recovery', () => {
  it('restores fixed discounts, variants and accompaniments without changing the next save payload', async () => {
    const { serverLineToCart, draftRestore, draftPricing, cartLinePayload } = await import('../../apps/web/src/features/pos/cart-payload');
    const { useCartStore } = await import('../../apps/web/src/features/pos/cart.store');
    const view = { transactionDiscountType: 'fixed_amount', transactionDiscountAmount: 3, discountReason: 'Order promotion', customer: { id: 'customer', code: 'C01', name: 'Customer' } };
    const line = serverLineToCart({ id: 'line', menuItemId: 'tea', description: 'Tea', quantity: '2', unitPrice: '18', discountType: 'fixed_amount', discountAmount: '4', discountReason: 'Line promotion', variantId: 'large', variantName: 'Large', accompanimentOptionIds: ['milk'], accompanimentNames: ['Milk'], accompanimentPriceImpact: 2, modifiers: [{ modifierId: 'extra', name: 'Extra', priceDelta: '1' }], course: 2 });
    useCartStore.getState().load([line], draftRestore(view));
    expect(draftPricing(useCartStore.getState())).toMatchObject({ transactionDiscountAmount: 3, discountReason: 'Order promotion' });
    expect(useCartStore.getState().customer).toEqual(view.customer);
    await useCartStore.persist.rehydrate();
    expect(useCartStore.getState().customer).toEqual(view.customer);
    expect(cartLinePayload(useCartStore.getState().lines[0])).toMatchObject({ unitPrice: 15, discountType: 'fixed_amount', discountAmount: 4, discountReason: 'Line promotion', variantId: 'large', accompanimentOptionIds: ['milk'], course: 2 });
  });

  it('unlocks a definitely rejected background payment without discarding its cart or evidence', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    const { useCartStore } = await import('../../apps/web/src/features/pos/cart.store');
    useCartStore.getState().addLine({ name: 'Tea', productId: 'tea', quantity: 1, unitPrice: 10 } as any);
    const key = useCartStore.getState().idempotencyKey;
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    await expect(q.submitSaleOperation('/pos/checkout', { tenders: [{ method: 'cash', amount: 10 }] }, key)).rejects.toThrow();
    mocks.post.mockRejectedValueOnce({ response: { status: 400, data: { safeToRetry: true, message: 'Tender rejected before billing' } } });
    await q.replayAll();
    await expect(q.recoverSaleOperation(key)).rejects.toThrow('Tender rejected');
    expect(useCartStore.getState().operationPending).toBe(false);
    expect(useCartStore.getState().idempotencyKey).not.toBe(key);
    expect(useCartStore.getState().lines[0].name).toBe('Tea');
    expect(await q.listFailed()).toHaveLength(1);
  });

  it('does not persist drawer approval credentials for offline replay', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    await expect(q.enqueueCashMovement({ movementType: 'pay_out', amount: 10, managerPin: 'secret' })).rejects.toThrow('online');
    expect(await q.listPending()).toHaveLength(0);
  });

  it('retains a drawer operation key through a lost response without retaining its PIN', async () => {
    const { submitCashOperation } = await import('../../apps/web/src/features/pos/cash-operation');
    const body = { sessionId: 'drawer', movementType: 'pay_out', amount: 5, reason: 'Expense', managerPin: '1234' };
    mocks.post.mockRejectedValueOnce(new Error('lost response'));
    await expect(submitCashOperation('/cash-sessions/movement', body)).rejects.toThrow('lost response');
    const saved = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join('');
    expect(saved).not.toContain('1234');
    mocks.post.mockResolvedValueOnce({ data: { id: 'original-movement' } });
    await submitCashOperation('/cash-sessions/movement', { ...body, managerPin: '5678' });
    expect(mocks.post.mock.calls[1][2]).toEqual(mocks.post.mock.calls[0][2]);
  });

  it('keeps an invoice collection key until the cashier acknowledges background completion', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    const endpoint = '/pos/invoices/invoice-one/payments';
    const body = { cashSessionId: 'drawer', allowPartial: true, tenders: [{ method: 'cash', amount: 10 }] };
    mocks.post.mockRejectedValueOnce(new Error('response lost'));
    await expect(q.submitEntitySaleOperation(endpoint, body)).rejects.toThrow();
    mocks.post.mockResolvedValueOnce({ data: { invoiceId: 'invoice-one', settlementStatus: 'partially_settled' } });
    await q.replayAll();
    const result = await q.recoverEntitySaleOperation(endpoint);
    expect(result.settlementStatus).toBe('partially_settled');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(q.pendingEntityOperationKey(endpoint)).toBeNull();
  });

  it('never overwrites the first envelope under concurrent enqueue attempts', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    const [a, b] = await Promise.all([q.enqueueSale({ amount: 10 }, { idempotencyKey: 'one' }), q.enqueueSale({ amount: 20 }, { idempotencyKey: 'one' })]);
    expect(a.payload).toEqual(b.payload);
    expect((await q.listPending())[0].payload).toEqual(a.payload);
  });

  it('preserves the first payload and timestamp after timeout, including background replay', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    const { useCartStore } = await import('../../apps/web/src/features/pos/cart.store');
    useCartStore.setState({ idempotencyKey: 'same-sale' });
    const body = { lines: [{ productId: 'coffee', quantity: 2 }], tenders: [{ method: 'mobile_money', amount: 20, accountId: 'airtel' }] };
    mocks.post.mockRejectedValueOnce(new Error('response lost'));
    await expect(q.submitSaleOperation('/pos/checkout', body, 'same-sale')).rejects.toThrow('response lost');
    const pending = (await q.listPending())[0];
    expect(pending.payload.occurredAt).toBeTruthy();
    expect(useCartStore.getState().operationPending).toBe(true);
    await expect(q.submitSaleOperation('/pos/checkout', { ...body, tenders: [{ method: 'cash', amount: 20 }] }, 'same-sale')).rejects.toThrow('pending payment');
    mocks.post.mockResolvedValue({ data: { invoiceId: 'one-invoice', total: 20 } });
    await q.replayAll();
    expect(mocks.post.mock.calls[1][1]).toEqual(pending.payload);
    expect(mocks.post.mock.calls[1][2].headers['Idempotency-Key']).toBe('same-sale');
    expect(await q.listPending()).toHaveLength(0);
    const recovered = await q.recoverSaleOperation('same-sale');
    expect(recovered.invoiceId).toBe('one-invoice');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(useCartStore.getState().operationPending).toBe(false);
  });

  it('does not replay another organization’s operation', async () => {
    const q = await import('../../apps/web/src/features/pos/offline-queue');
    await q.enqueueSale({ tenders: [{ method: 'cash', amount: 10 }] }, { idempotencyKey: 'foreign-sale' });
    mocks.auth.state = { organization: { id: 'org-b' }, user: { id: 'cashier-b' } };
    await q.replayAll();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(await q.listPending()).toHaveLength(1);
  });

  it('locks a pending cart and persists no manager credential', async () => {
    const { useCartStore } = await import('../../apps/web/src/features/pos/cart.store');
    useCartStore.getState().addLine({ name: 'Tea', productId: 'tea', quantity: 1, unitPrice: 10 } as any);
    const line = useCartStore.getState().lines[0];
    useCartStore.setState({ overridePin: 'password:secret', operationPending: true });
    useCartStore.getState().setQuantity(line.lineId, 4);
    useCartStore.getState().clear();
    expect(useCartStore.getState().lines[0].quantity).toBe(1);
    const saved = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join('');
    expect(saved).not.toContain('password:secret');
    expect(saved).toContain('Tea');
  });

  it('keeps operator carts separate when staff switch accounts', async () => {
    const { useCartStore } = await import('../../apps/web/src/features/pos/cart.store');
    useCartStore.getState().addLine({ name: 'Coffee', productId: 'coffee', quantity: 1, unitPrice: 20 } as any);
    useCartStore.getState().setCashSession('drawer-a');
    mocks.auth.state = { organization: { id: 'org-a' }, user: { id: 'cashier-b' } };
    mocks.auth.listeners.forEach((fn: any) => fn());
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(useCartStore.getState().cashSessionId).toBeUndefined();
    mocks.auth.state = { organization: { id: 'org-a' }, user: { id: 'cashier-a' } };
    mocks.auth.listeners.forEach((fn: any) => fn());
    await useCartStore.persist.rehydrate();
    expect(useCartStore.getState().lines[0].name).toBe('Coffee');
  });
});
