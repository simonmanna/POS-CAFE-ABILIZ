/* eslint-disable @typescript-eslint/no-explicit-any */
import { PosOrdersService } from './pos-orders.service';

/**
 * F10 — the kitchen-lifecycle line signature must distinguish lines that differ
 * in ANY customization (milk / notes / sides / course), so an unsent "oat latte"
 * can never inherit a sent "dairy latte"'s printed quantity across an auto-save.
 * These exercise the pure signature helpers directly (no DB).
 */
describe('PosOrdersService — F10 line signature', () => {
  const svc = Object.create(PosOrdersService.prototype) as any;

  const base = { productId: null, menuItemId: 'm-latte', variantName: 'Large', description: 'Latte', quantity: 1, unitPrice: 5, taxId: null, discountPercent: 0, note: null, taxInclusive: false, accompanimentNames: [], accompanimentOptionIds: [], station: 'cafe', course: null, modifiers: [] as any[] };

  it('two lines of the same product with different modifiers get different signatures', () => {
    const oat = svc.resolvedSignature({ ...base, modifiers: [{ modifierId: 'oat', name: 'Oat milk', priceDelta: 0 }] });
    const dairy = svc.resolvedSignature({ ...base, modifiers: [{ modifierId: 'dairy', name: 'Dairy milk', priceDelta: 0 }] });
    expect(oat).not.toEqual(dairy);
  });

  it('note, course and accompaniment selection each change the signature', () => {
    const plain = svc.resolvedSignature(base);
    expect(svc.resolvedSignature({ ...base, note: 'no sugar' })).not.toEqual(plain);
    expect(svc.resolvedSignature({ ...base, course: 2 })).not.toEqual(plain);
    expect(svc.resolvedSignature({ ...base, accompanimentOptionIds: ['fries'] })).not.toEqual(plain);
  });

  it('a persisted row and an identical incoming line share a signature (so lifecycle carries)', () => {
    const line = { ...base, modifiers: [{ modifierId: 'oat', name: 'Oat', priceDelta: 0 }], accompanimentOptionIds: ['fries'], note: 'hot' };
    const row = { productId: null, menuItemId: 'm-latte', variantName: 'Large', description: 'Latte', note: 'hot', course: null, accompanimentOptionIds: ['fries'], modifiers: [{ modifierId: 'oat' }] };
    expect(svc.rowSignature(row)).toEqual(svc.resolvedSignature(line));
  });

  it('modifier order does not matter (set semantics)', () => {
    const a = svc.resolvedSignature({ ...base, modifiers: [{ modifierId: 'x' }, { modifierId: 'y' }] });
    const b = svc.resolvedSignature({ ...base, modifiers: [{ modifierId: 'y' }, { modifierId: 'x' }] });
    expect(a).toEqual(b);
  });
});
