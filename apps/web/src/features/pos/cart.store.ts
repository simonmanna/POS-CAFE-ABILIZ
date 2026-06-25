/**
 * POS cart store — zustand.
 *
 * Single source of truth for the active cart. Persisted to sessionStorage so
 * a page reload (or accidental F5) doesn't lose the cashier's work. Cleared
 * explicitly after a successful checkout or when the cashier taps "New sale".
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CartLine, DiscountType } from './types';

export type OrderType = 'dine-in' | 'takeaway' | 'delivery';

interface CartState {
  lines: CartLine[];
  transactionDiscountPercent: number;
  transactionDiscountType: DiscountType;
  transactionDiscountAmount: number;
  overrideById?: string;
  cashSessionId?: string;
  /** Workflow state */
  orderType?: OrderType;
  tableId?: string;
  tableNumber?: number;
  tableName?: string;
  sentToKitchen: boolean;
  /** Add a product line, merging by (productId or sku) + taxInclusive flag. */
  addLine: (line: Omit<CartLine, 'lineId' | 'discountPercent'> & { discountPercent?: number }) => void;
  setQuantity: (lineId: string, qty: number) => void;
  /** Set line discount. amount is percent or fixed amount based on type. */
  setDiscount: (lineId: string, amount: number, type?: DiscountType) => void;
  setNote: (lineId: string, note: string) => void;
  removeLine: (lineId: string) => void;
  /** Order-level discount. type=percentage → amount is percent; type=fixed → amount in minor units. */
  setTransactionDiscount: (amount: number, type?: DiscountType) => void;
  setOverrideById: (id: string | undefined) => void;
  setCashSession: (id: string | undefined) => void;
  setOrderType: (type: OrderType | undefined) => void;
  setTable: (id: string | undefined, number?: number, name?: string) => void;
  markSentToKitchen: (v: boolean) => void;
  /** Replace cart wholesale (used when recalling a hold). */
  load: (lines: CartLine[]) => void;
  clear: () => void;
}

const newLineId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? (crypto as any).randomUUID()
    : Math.random().toString(36).slice(2);

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      transactionDiscountPercent: 0,
      transactionDiscountType: 'percentage' as DiscountType,
      transactionDiscountAmount: 0,
      overrideById: undefined,
      cashSessionId: undefined,
      orderType: undefined,
      tableId: undefined,
      tableNumber: undefined,
      tableName: undefined,
      sentToKitchen: false,
      addLine: (line) => {
        set((state) => {
          // Key on (product|sku) + taxInclusive + selected modifiers + note so a
          // differently-customized item lands on its OWN cart line (e.g. "Large
          // + Extra milk" vs "Small + No ice"), while an identical pick merges
          // (qty +1). P10: taxInclusive keeps the same product addable twice.
          const keyOf = (l: {
            productId?: string;
            menuItemId?: string;
            sku?: string;
            taxInclusive?: boolean;
            modifiers?: Array<{ modifierId: string }>;
            note?: string;
          }) =>
            (l.menuItemId ?? l.productId ?? l.sku?.toLowerCase() ?? '') +
            (l.taxInclusive ? '|incl' : '') +
            '|m:' + (l.modifiers ?? []).map((m) => m.modifierId).sort().join(',') +
            '|n:' + (l.note ?? '');
          const key = keyOf(line);
          const existing = state.lines.find((l) => keyOf(l) === key);
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.lineId === existing.lineId ? { ...l, quantity: l.quantity + (line.quantity || 1) } : l,
              ),
            };
          }
          return {
            lines: [
              ...state.lines,
              {
                ...line,
                lineId: newLineId(),
                discountPercent: line.discountPercent ?? 0,
              },
            ],
          };
        });
      },
      setQuantity: (lineId, qty) =>
        set((state) => ({
          lines: state.lines
            .map((l) => (l.lineId === lineId ? { ...l, quantity: Math.max(0, qty) } : l))
            .filter((l) => l.quantity > 0),
        })),
      setDiscount: (lineId, amount, type) =>
        set((state) => ({
          lines: state.lines.map((l) =>
            l.lineId === lineId
              ? {
                  ...l,
                  discountPercent: type === 'fixed' ? 0 : Math.max(0, Math.min(100, amount)),
                  discountType: type ?? 'percentage',
                  discountAmount: type === 'fixed' ? Math.max(0, amount) : undefined,
                }
              : l,
          ),
        })),
      setNote: (lineId, note) =>
        set((state) => ({
          lines: state.lines.map((l) => (l.lineId === lineId ? { ...l, note } : l)),
        })),
      removeLine: (lineId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.lineId !== lineId) })),
      setTransactionDiscount: (amount, type) =>
        set({
          transactionDiscountPercent: type === 'fixed' ? 0 : Math.max(0, Math.min(100, amount)),
          transactionDiscountType: type ?? 'percentage',
          transactionDiscountAmount: type === 'fixed' ? Math.max(0, amount) : 0,
        }),
      setOverrideById: (id) => set({ overrideById: id }),
      setCashSession: (id) => set({ cashSessionId: id }),
      setOrderType: (type) => set({ orderType: type }),
      setTable: (id, number, name) => set({ tableId: id, tableNumber: number, tableName: name }),
      markSentToKitchen: (v) => set({ sentToKitchen: v }),
      load: (lines) => set({ lines, transactionDiscountPercent: 0, overrideById: undefined }),
      clear: () => set({
        lines: [], transactionDiscountPercent: 0, transactionDiscountType: 'percentage',
        transactionDiscountAmount: 0, overrideById: undefined,
        orderType: undefined, tableId: undefined, tableNumber: undefined, tableName: undefined,
        sentToKitchen: false,
      }),
    }),
    {
      name: 'pos-cart',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/** Derived selectors (kept outside the store so they're tree-shake friendly). */
export const selectSubtotal = (state: CartState): number =>
  state.lines.reduce((sum, l) => {
    const lineTotal = l.quantity * l.unitPrice;
    const discount = l.discountType === 'fixed'
      ? (l.discountAmount ?? 0)
      : lineTotal * (l.discountPercent / 100);
    return sum + Math.max(0, lineTotal - discount);
  }, 0);

export const selectTxDiscountAmount = (state: CartState): number => {
  const sub = selectSubtotal(state);
  if (state.transactionDiscountType === 'fixed') {
    return Math.min(state.transactionDiscountAmount, sub);
  }
  return sub * (state.transactionDiscountPercent / 100);
};

export const selectTotal = (state: CartState): number =>
  Math.max(0, selectSubtotal(state) - selectTxDiscountAmount(state));

export const selectItemCount = (state: CartState): number =>
  state.lines.reduce((s, l) => s + l.quantity, 0);