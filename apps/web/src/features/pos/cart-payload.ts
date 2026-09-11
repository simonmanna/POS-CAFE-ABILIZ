import type { CartLine } from './types';

/** Full persisted meaning of a line; use this for both save and quote. */
export function cartLinePayload(l: CartLine) {
  return {
    productId: l.productId, menuItemId: l.menuItemId, sku: l.sku, description: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice - (l.modifiers ?? []).reduce((s, m) => s + (m.modifierId ? Number(m.priceDelta) : 0), 0) - Number(l.accompanimentPriceImpact ?? 0),
    taxId: l.taxId, taxInclusive: l.taxInclusive,
    discountPercent: l.discountType === 'fixed_amount' ? 0 : l.discountPercent,
    discountType: l.discountType, discountAmount: l.discountAmount, discountReason: l.discountReason,
    note: l.note, modifiers: l.modifiers, comboId: l.comboId, variantId: l.variantId,
    accompanimentOptionIds: l.accompanimentOptionIds, course: l.course,
  };
}

export const cartSignature = (lines: CartLine[]) => JSON.stringify(lines.map(cartLinePayload));

export function draftPricing(state: any) {
  return { transactionDiscountPercent: Number(state.transactionDiscountPercent ?? 0), transactionDiscountType: state.transactionDiscountType ?? 'percentage', transactionDiscountAmount: Number(state.transactionDiscountAmount ?? 0), discountReason: state.transactionDiscountReason ?? state.discountReason };
}
export function draftRestore(view: any) { return { ...draftPricing(view ?? {}), transactionDiscountReason: view?.discountReason, customer: view?.customer ?? null }; }
export function serverLineToCart(l: any): CartLine {
  return { lineId: l.id ?? crypto.randomUUID(), productId: l.productId ?? undefined, menuItemId: l.menuItemId ?? undefined,
    name: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent ?? 0), discountType: l.discountType ?? 'percentage', discountAmount: Number(l.discountAmount ?? 0), discountReason: l.discountReason ?? undefined,
    taxId: l.taxId ?? undefined, taxInclusive: l.taxInclusive ?? undefined, note: l.note ?? undefined,
    modifiers: (l.modifiers ?? []).map((m: any) => ({ modifierId: m.modifierId ?? '', name: m.name, priceDelta: Number(m.priceDelta ?? 0) })),
    variantId: l.variantId ?? undefined, variantName: l.variantName ?? undefined, variantPrice: l.variantPrice == null ? undefined : Number(l.variantPrice),
    accompanimentOptionIds: l.accompanimentOptionIds ?? [], accompanimentNames: l.accompanimentNames ?? [], accompanimentPriceImpact: Number(l.accompanimentPriceImpact ?? 0), course: l.course ?? undefined,
    kitchenPrintedQty: Number(l.kitchenPrintedQty ?? 0),
    // Server-owned: who punched this line (never sent back on save — the API
    // rejects body fields it does not whitelist, and the first puncher wins).
    punchedById: l.punchedById ?? undefined,
    punchedByName: l.punchedByName ?? undefined,
  };
}
