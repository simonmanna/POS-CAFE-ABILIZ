// Order panel — cart lines + qty steppers + line discount + totals + action grid.
// Pure presentation: reads from the zustand cart store + emits events up.
import React from "react";
import {
  ShoppingCart,
  Plus,
  Minus,
  StickyNote,
  Trash2,
  X,
  Tag,
  CreditCard,
  Receipt,
  User,
  AlertTriangle,
  Printer,
} from "lucide-react";
import { getFoodEmoji } from "./food-images";
import {
  selectItemCount,
  selectSubtotal,
  selectTxDiscountAmount,
  selectTotal,
  useCartStore,
} from "@/features/pos/cart.store";
import type { CartLine } from "@/features/pos/types";

export type OrderTypeOption = 'dine-in' | 'takeaway' | 'delivery';

interface Props {
  customerName?: string;
  orderTypeLabel?: string;
  orderType: OrderTypeOption;
  onChangeOrderType: (t: OrderTypeOption) => void;
  tableLabel?: string;
  tableId?: string;
  onInc: (line: CartLine) => void;
  onDec: (line: CartLine) => void;
  onRemove?: (line: CartLine) => void;
  onNote: (line: CartLine) => void;
  onLineDiscount: (line: CartLine) => void;
  onPrintBill: () => void;
  onCharge: () => void;
  onSplit: () => void;
  onAddCustomer: () => void;
  onAddDiscount: () => void;
  onCloseOrder: () => void;
  onPrintKot: () => void;
  onVoidItem?: (line: CartLine) => void;
  onMoveItems?: () => void;
  /** Dine-in: settle (pay) the table's order. */
  onSettleTab?: () => void;
  billAlreadyPrinted?: boolean;
  onPrintAdditionalBill?: () => void;
}

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;

const ORDER_TYPES: Array<{ key: 'dine-in' | 'takeaway' | 'delivery'; label: string }> = [
  { key: 'dine-in', label: 'Dine In' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
];

export const OrderPanel: React.FC<Props> = ({
  customerName,
  orderType,
  onChangeOrderType,
  tableId,
  onInc,
  onDec,
  onRemove,
  onNote,
  onLineDiscount,
  onPrintBill,
  onCharge,
  onSplit,
  onAddCustomer,
  onAddDiscount,
  onCloseOrder,
  onPrintKot,
  onVoidItem,
  onMoveItems,
  onSettleTab,
  billAlreadyPrinted = false,
  onPrintAdditionalBill,
}) => {
  const lines = useCartStore((s) => s.lines);
  const transactionDiscountPercent = useCartStore(
    (s) => s.transactionDiscountPercent,
  );
  const subtotal = useCartStore(selectSubtotal);
  const txDisc = useCartStore(selectTxDiscountAmount);
  const total = useCartStore(selectTotal);
  const itemCount = useCartStore(selectItemCount);
  const empty = lines.length === 0;

  return (
    <div className="pos-order-pro">
      {/* Header */}
      <div className="pos-order-head">
        <div className="flex items-center gap-2 min-w-0">
          <div className="pos-ord-num shrink-0">
            {empty ? "No items" : `${itemCount} item${itemCount === 1 ? "" : "s"}`}
          </div>
        </div>
        {customerName ? (
          <div className="pos-ord-customer ml-2">
            <User className="h-3 w-3" />
            {customerName}
          </div>
        ) : null}
        <div className="pos-ord-actions">
          {/* Order type dropdown */}
          <div className="mr-1 pr-1.5 flex items-center">
            <select
              className="text-[13px] font-bold cursor-pointer appearance-none bg-white/15 text-white rounded-md px-2 py-1 pr-5 border border-white/20"
              value={orderType}
              onChange={(e) => onChangeOrderType(e.target.value as OrderTypeOption)}
              title="Order type"
              style={{ backgroundImage: 'url("data:image/svg+xml,%3csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3e%3cpath fill=%27%23fff%27 d=%27M5 6l3 3 3-3%27/%3e%3c/svg%3e")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', backgroundSize: '10px' }}
            >
              {ORDER_TYPES.map((ot) => (
                <option key={ot.key} value={ot.key} className="text-slate-800">{ot.label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="pos-ord-action"
            onClick={onAddCustomer}
            title="Add customer"
          >
            <User className="h-4 w-4" />
          </button>
          {lines.length > 0 ? (
            <button
              type="button"
              className="pos-ord-action"
              onClick={onCloseOrder}
              title="Clear cart"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Lines list — this IS the table's open order (auto-saved). */}
      {empty ? (
        <div className="pos-order-empty">
          <div className="pos-empty-icon">
            <ShoppingCart className="h-7 w-7" />
          </div>
          <p className="font-semibold text-base text-slate-300">
            {tableId ? "Empty order" : "No items yet"}
          </p>
          <p className="text-xs text-slate-500">
            {tableId
              ? "Pick items — they auto-save to this table"
              : "Pick a product to start the order"}
          </p>
        </div>
      ) : (
<div className="pos-order-list min-h-0">
          {lines.map((it) => {
            const emoji = getFoodEmoji(it.name);
            const lineSub =
              it.quantity * it.unitPrice * (1 - it.discountPercent / 100);
            return (
              <div key={it.lineId} className="pos-order-card">
                <div className="pos-card-row">
                  <div className="pos-card-emoji">{emoji}</div>
                  <div className="flex-1 min-w-0">
                    <div className="pos-card-name truncate">{it.name}</div>
                    <div className="pos-card-line">
                      @ {fmt(it.unitPrice)} · {it.quantity}×
                      {it.discountPercent > 0
                        ? ` · −${it.discountPercent}%`
                        : ""}
                    </div>
                  </div>
                  <div className="pos-card-price">{fmt(lineSub)}</div>
                </div>
                {it.variantName && (
                  <div className="text-[11px] font-semibold text-slate-700 px-1 truncate">{it.variantName}</div>
                )}
                {it.accompanimentNames && it.accompanimentNames.length > 0 && (
                  <div className="text-[11px] text-slate-600 px-1 truncate">+ {it.accompanimentNames.join(", ")}</div>
                )}
                {it.modifiers && it.modifiers.length > 0 ? (
                  <div className="text-[11px] text-amber-700 px-1 truncate">
                    {it.modifiers
                      .map((m) => (m as any).kitchenPrintName ?? m.name)
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                ) : null}
                {it.note ? (
                  <div className="pos-card-notes">! {it.note}</div>
                ) : null}
                <div className="pos-card-footer">
                  <div className="pos-qty">
                    <button type="button" onClick={() => onDec(it)} aria-label="decrease"><Minus className="h-3 w-3" /></button>
                    <div className="pos-qty-val">{it.quantity}</div>
                    <button type="button" onClick={() => onInc(it)} aria-label="increase"><Plus className="h-3 w-3" /></button>
                  </div>
                  <div className="pos-card-actions">
                    <button type="button" className="pos-card-action" onClick={() => onNote(it)} title="Add note"><StickyNote className="h-3.5 w-3.5" /></button>
                    <button type="button" className="pos-card-action" onClick={() => onLineDiscount(it)} title="Line discount"><Tag className="h-3.5 w-3.5" /></button>
                    {onVoidItem ? <button type="button" className="pos-card-action text-rose-500" onClick={() => onVoidItem(it)} title="Void item"><AlertTriangle className="h-3.5 w-3.5" /></button> : null}
                    {onRemove ? <button type="button" className="pos-card-action danger" onClick={() => onRemove(it)} title="Remove"><Trash2 className="h-3.5 w-3.5" /></button> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Totals */}
      <div className="pos-order-totals">
        <div className="pos-totals-row">
          <span>Subtotal</span>
          <span className="pos-amt">{fmt(subtotal)}</span>
        </div>
        {transactionDiscountPercent > 0 ? (
          <div className="pos-totals-row">
            <span>Discount ({transactionDiscountPercent}%)</span>
            <span className="pos-amt text-emerald-600">−{fmt(txDisc)}</span>
          </div>
        ) : null}
        <div className="pos-totals-row big">
          <span>TOTAL</span>
          <span className="pos-amt">{fmt(total)}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="pos-order-actions">
        <button
          type="button"
          className="pos-action-btn-pro bg-purple"
          onClick={billAlreadyPrinted ? onPrintAdditionalBill : onPrintBill}
          disabled={empty}
          title={billAlreadyPrinted ? 'Print additional bill for new items' : 'Print bill (F8)'}
        >
          <Receipt className="pos-action-icon" /> {billAlreadyPrinted ? 'Add Bill' : 'Bill'}{' '}
          {!billAlreadyPrinted && <span className="pos-kbd">F8</span>}
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-sky-600"
          onClick={onPrintKot}
          disabled={empty}
        >
          <Printer className="pos-action-icon" /> Print KOT
        </button>

        {tableId && onSettleTab ? (
          <button
            type="button"
            className="pos-action-btn-pro bg-emerald"
            onClick={onSettleTab}
            disabled={empty}
            title="Settle (pay) this table's order"
          >
           <CreditCard className="pos-action-icon" />Settle Bill
          </button>
        ) : (
          <button
            type="button"
            className="pos-action-btn-pro bg-emerald"
            onClick={onCharge}
            disabled={empty}
          >
            <CreditCard className="pos-action-icon" /> CheckOut{" "}
            <span className="pos-kbd">F2</span>
          </button>
        )}

        <button
          type="button"
          className="pos-action-btn-pro bg-amber"
          onClick={onAddDiscount}
          disabled={empty}
        >
         Discount
        </button>

        {onMoveItems ? (
          <button
            type="button"
            className="pos-action-btn-pro bg-pink"
            onClick={onMoveItems}
            disabled={empty}
            title="Move selected items to another table"
          >
          Move Items
          </button>
        ) : null}

        <button
          type="button"
          className="pos-action-btn-pro bg-pink"
          onClick={onSplit}
          disabled={empty}
          title={tableId ? "Split this table's bill into separate payments" : 'Split payment across tenders'}
        >
         Split
        </button>
      </div>
    </div>
  );
};
