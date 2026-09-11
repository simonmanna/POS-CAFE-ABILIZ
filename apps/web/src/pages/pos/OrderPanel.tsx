// Order panel — Odoo-style POS control panel.
//
// Layout (top → bottom):
//   • header      — item count + order-type + customer + clear
//   • order lines — tap a line to SELECT it (highlighted); no per-line steppers
//   • totals      — subtotal / discount / total
//   • control row — Customer · Disc · More (dialog: Note, Void, Delete, Discount %, Move, Split, Hold, Held, Handover)
//   • numpad      — 1-9 0 . ⌫ + Qty / % / Price mode selectors + ±
//   • primary     — Bill · KOT · Pay
//
// The numpad is the Odoo interaction model: pick a line, choose a mode
// (Qty / % / Price), then type digits — they live-apply to the selected line.
// Removal is NOT done from the numpad, so the PIN-gated Void / Delete controls
// stay the only way to drop a line. Backspacing a quantity away leaves the line
// sitting at 0 — visible, still selected, and blocking Bill / KOT / Pay until it
// is given a real quantity — rather than silently deleting it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ShoppingCart,
  StickyNote,
  Trash2,
  Tag,
  CreditCard,
  Receipt,
  User,
  AlertTriangle,
  Printer,
  Pause,
  ArrowLeftRight,
  Split as SplitIcon,
  Percent,
  Delete as BackspaceIcon,
  MoreHorizontal,
} from "lucide-react";
import {
  selectItemCount,
  selectSubtotal,
  selectTxDiscountAmount,
  selectTotal,
  useCartStore,
} from "@/features/pos/cart.store";
import type { CartLine } from "@/features/pos/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth.store";

export type OrderTypeOption = 'dine-in' | 'takeaway' | 'delivery';

interface Props {
  quotedTotal?: number;
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
  onPrintKot: () => void;
  onVoidItem?: (line: CartLine) => void;
  onMoveItems?: () => void;
  /** Dine-in: settle (pay) the table's order. */
  onSettleTab?: () => void;
  billAlreadyPrinted?: boolean;
  onPrintAdditionalBill?: () => void;
  /** When true, hide cafe/restaurant-specific buttons (KOT, split, move items, settle tab). */
  hideCafeFeatures?: boolean;
  /** Cashier holds `pos:discount` — gates the numpad % mode + Disc/Discount buttons. Default true. */
  canDiscount?: boolean;
  /** Cashier may override a line's unit price (numpad Price mode). Default true. */
  canOverridePrice?: boolean;
  /** Retail: park current cart as a held order. */
  onHold?: () => void;
  /** Retail: open held-orders recall dialog. */
  onHeldOrders?: () => void;
  /** Retail: shift handover to another cashier. */
  onHandover?: () => void;
  /** Retail: open customer profile dialog (loyalty, store credit). */
  onCustomerProfile?: () => void;
}

// Use the organization currency like every sibling POS component — OrderPanel
// was the lone hard-coded UGX, so an org on another currency showed two symbols
// on one screen.
const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
/** Cart rows omit the currency symbol (tight space); totals keep it. */
const fmt = (n: number | string, withCurrency = true) =>
  `${withCurrency ? orgCur() + ' ' : ''}${Number(n || 0).toLocaleString()}`;

const ORDER_TYPES: Array<{ key: 'dine-in' | 'takeaway' | 'delivery'; label: string }> = [
  { key: 'dine-in', label: 'Dine In' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
];

type NumMode = 'qty' | 'disc' | 'price';

export const OrderPanel: React.FC<Props> = ({
  quotedTotal,
  customerName,
  orderType,
  onChangeOrderType,
  tableId,
  onRemove,
  onNote,
  onLineDiscount,
  onPrintBill,
  onCharge,
  onSplit,
  onAddCustomer,
  onAddDiscount,
  onPrintKot,
  onVoidItem,
  onMoveItems,
  onSettleTab,
  billAlreadyPrinted = false,
  onPrintAdditionalBill,
  hideCafeFeatures = false,
  canDiscount = true,
  canOverridePrice = false,
  onHold,
  onHeldOrders,
  onHandover,
  onCustomerProfile,
}) => {
  const lines = useCartStore((s) => s.lines);
  const transactionDiscountPercent = useCartStore((s) => s.transactionDiscountPercent);
  const subtotal = useCartStore(selectSubtotal);
  const txDisc = useCartStore(selectTxDiscountAmount);
  const estimate = useCartStore(selectTotal);
  const total = quotedTotal ?? estimate;
  const itemCount = useCartStore(selectItemCount);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const setDiscount = useCartStore((s) => s.setDiscount);
  const setUnitPrice = useCartStore((s) => s.setUnitPrice);
  const empty = lines.length === 0;
  /* A line the cashier has emptied with the numpad. It is still on the order —
   * it just has no quantity yet — so every money/kitchen action is blocked until
   * it is given one or explicitly voided. */
  const zeroQtyLines = lines.filter((l) => !(l.quantity > 0));
  const hasZeroQty = zeroQtyLines.length > 0;
  const blockedReason = hasZeroQty
    ? `Set a quantity for ${zeroQtyLines.map((l) => l.name).join(', ')} first`
    : undefined;
  const cannotTransact = empty || hasZeroQty;

  /* ============== Odoo numpad state ============== */
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [mode, setMode] = useState<NumMode>('qty');
  const [editing, setEditing] = useState(false);
  const bufferRef = useRef<string>('');
  const selectedLine = lines.find((l) => l.lineId === selectedLineId) ?? null;

  /* Auto-select the newest line so the numpad always has a target. */
  useEffect(() => {
    if (lines.length === 0) {
      if (selectedLineId !== null) setSelectedLineId(null);
      return;
    }
    if (!selectedLineId || !lines.some((l) => l.lineId === selectedLineId)) {
      setSelectedLineId(lines[lines.length - 1].lineId);
      setMode('qty');
      bufferRef.current = '';
      setEditing(false);
    }
  }, [lines, selectedLineId]);

  const selectLine = useCallback((id: string) => {
    setSelectedLineId(id);
    setMode('qty');
    bufferRef.current = '';
    setEditing(false);
  }, []);

  const pickMode = useCallback((m: NumMode) => {
    if (m === 'disc' && !canDiscount) return;
    if (m === 'price' && !canOverridePrice) return;
    // F-02: a discount typed straight onto the numpad carried no reason, so the
    // server rejected the sale at the payment screen — the one place a cashier
    // cannot fix it. The % key now opens the dialog that collects the reason
    // (and, above the org's threshold, the manager approval) up front.
    if (m === 'disc') {
      const line = useCartStore.getState().lines.find((l) => l.lineId === selectedLineId);
      if (line) onLineDiscount?.(line);
      return;
    }
    setMode(m);
    bufferRef.current = '';
    setEditing(false);
  }, [canDiscount, canOverridePrice, selectedLineId, onLineDiscount]);

  /* A permission that was revoked (or a mode the cashier can't use) must never
   * stay active — fall back to Qty so digits can't apply to a gated field. */
  useEffect(() => {
    if (mode === 'disc' || (mode === 'price' && !canOverridePrice)) {
      setMode('qty');
      bufferRef.current = '';
      setEditing(false);
    }
  }, [mode, canDiscount, canOverridePrice]);

  /** Apply the current buffer to the selected line for the active mode. */
  const applyBuffer = useCallback(() => {
    const line = useCartStore.getState().lines.find((l) => l.lineId === selectedLineId);
    if (!line) return;
    const raw = bufferRef.current;
    const num = raw === '' || raw === '-' || raw === '.' || raw === '-.' ? NaN : parseFloat(raw);
    if (mode === 'qty') {
      // An empty/partial buffer means "the cashier cleared this line's quantity".
      // Park it at 0 (allowZero keeps the row — the numpad never deletes) so the
      // zero is visible and the order cannot be billed until it is resolved.
      const next = Number.isNaN(num) || num < 0 ? 0 : num;
      setQuantity(line.lineId, next, { allowZero: true });
    } else if (mode === 'disc') {
      // Unreachable: pickMode routes 'disc' to the reason dialog (F-02). Kept as
      // a guard so a stale mode can never apply an unreasoned discount.
      return;
    } else {
      if (!canOverridePrice) return; // gated: price override right
      setUnitPrice(line.lineId, Number.isNaN(num) ? 0 : Math.max(0, num));
    }
  }, [mode, selectedLineId, canDiscount, canOverridePrice, setQuantity, setDiscount, setUnitPrice]);

  const pressDigit = useCallback((d: string) => {
    if (!selectedLineId) return;
    if (!editing) { bufferRef.current = d; setEditing(true); }
    else bufferRef.current += d;
    applyBuffer();
  }, [applyBuffer, editing, selectedLineId]);

  const pressDot = useCallback(() => {
    if (!selectedLineId) return;
    if (!editing) { bufferRef.current = '0.'; setEditing(true); }
    else if (!bufferRef.current.includes('.')) bufferRef.current += '.';
    applyBuffer();
  }, [applyBuffer, editing, selectedLineId]);

  const pressBackspace = useCallback(() => {
    if (!selectedLineId) return;
    if (editing && bufferRef.current.length > 0) {
      bufferRef.current = bufferRef.current.slice(0, -1);
    } else {
      // Not mid-edit (or nothing left to delete): backspace still means "clear
      // this value". Entering edit mode with an empty buffer is what makes a
      // single-digit quantity such as 5 fall to 0 on one press instead of
      // stubbornly staying at 5.
      bufferRef.current = '';
      setEditing(true);
    }
    applyBuffer();
  }, [applyBuffer, editing, selectedLineId]);

  const pressSign = useCallback(() => {
    if (!selectedLineId || mode === 'qty') return; // sign is meaningful for %/price only
    if (!editing) return;
    bufferRef.current = bufferRef.current.startsWith('-') ? bufferRef.current.slice(1) : '-' + bufferRef.current;
    applyBuffer();
  }, [applyBuffer, editing, mode, selectedLineId]);

  /** Live value shown under each mode chip so the cashier sees what they're editing. */
  const modeValue = (m: NumMode): string => {
    if (!selectedLine) return '';
    if (m === 'qty') return String(selectedLine.quantity);
    if (m === 'disc') return `${selectedLine.discountPercent || 0}%`;
    return Number(selectedLine.unitPrice || 0).toLocaleString();
  };

  const noSel = !selectedLine;

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
          <div className="pos-ord-customer ml-2 cursor-pointer" onClick={onCustomerProfile} title="View customer profile">
            <User className="h-3 w-3" />
            {customerName}
          </div>
        ) : null}
        <div className="pos-ord-actions">
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
        </div>
      </div>

      {/* Lines list — tap to select; numpad edits the selected line. */}
      {empty ? (
        <div className="pos-order-empty">
          <div className="pos-empty-icon">
            <ShoppingCart className="h-7 w-7" />
          </div>
          <p className="font-semibold text-base text-slate-300">
            {tableId ? "Empty order" : "No items yet"}
          </p>
          <p className="text-xs text-slate-500">
            {tableId ? "Pick items — they auto-save to this table" : "Pick a product to start the order"}
          </p>
        </div>
      ) : (
        <div className="pos-order-list min-h-0">
          {lines.map((it) => {
            const isCombo = Boolean(it.comboId);
            // A-022: fixed-amount discounts must not display as a percentage off
            const lineSub = it.discountType === 'fixed_amount'
              ? it.quantity * it.unitPrice - (it.discountAmount ?? 0)
              : it.quantity * it.unitPrice * (1 - it.discountPercent / 100);
            const isSel = it.lineId === selectedLineId;
            return (
              <div
                key={it.lineId}
                className={"pos-oline" + (isSel ? " selected" : "")}
                onClick={() => selectLine(it.lineId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLine(it.lineId); } }}
              >
                <div className="pos-oline-body">
                  <div className="pos-oline-name truncate">
                    {it.name}
                    {isCombo ? <span className="pos-oline-combo">COMBO</span> : null}
                  </div>
                  <div className="pos-oline-sub">
                    @ {fmt(it.unitPrice, false)}
                    {it.discountPercent > 0 ? ` · −${it.discountPercent}%` : it.discountType === 'fixed_amount' && (it.discountAmount ?? 0) > 0 ? ` · −${fmt(it.discountAmount!, false)} fixed` : ""}
                  </div>
                  {it.variantName && <div className="pos-oline-meta truncate">{it.variantName}</div>}
                  {it.accompanimentNames && it.accompanimentNames.length > 0 && (
                    <div className="pos-oline-meta truncate">+ {it.accompanimentNames.join(", ")}</div>
                  )}
                  {it.modifiers && it.modifiers.length > 0 ? (
                    <div className="pos-oline-meta amber truncate">
                      {it.modifiers.map((m) => (m as any).kitchenPrintName ?? m.name).filter(Boolean).join(" · ")}
                    </div>
                  ) : null}
                  {it.note ? <div className="pos-oline-note truncate">! {it.note}</div> : null}
                  {/* Who punched this line. Shown per line, not per order: on a
                      busy floor one table is rung up by whoever is nearest. */}
                  {it.punchedByName ? (
                    <div className="pos-oline-meta truncate">
                      <User className="h-3 w-3 inline-block mr-1 -mt-0.5" />
                      {it.punchedByName}
                    </div>
                  ) : null}
                </div>
                <div className={"pos-oline-qty" + (it.quantity > 0 ? "" : " text-rose-500")}>{it.quantity}</div>
                <div className="pos-oline-price">{fmt(lineSub, false)}</div>
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
        {quotedTotal == null && <div className="text-xs text-amber-700">Estimated — waiting for server quote</div>}
        <div className="pos-totals-row big">
          <span>TOTAL</span>
          <span className="pos-amt">{fmt(total)}</span>
        </div>
      </div>

      {/* Control rows — act on the selected line / order */}
      <div className="pos-ctl-rows">
        <div className="pos-ctl-row">
          <button type="button" className="pos-ctl-btn" onClick={onAddCustomer} title="Customer">
            <User className="h-4 w-4" /><span>Customer</span>
          </button>
          <button type="button" className="pos-ctl-btn" disabled={noSel || !canDiscount} onClick={() => selectedLine && onLineDiscount(selectedLine)} title={canDiscount ? "Line discount on selected item" : "Requires discount permission"}>
            <Tag className="h-4 w-4" /><span>Disc</span>
          </button>
          <Dialog>
            <DialogTrigger asChild>
              <button type="button" className="pos-ctl-btn" disabled={noSel && empty} title="More actions">
                <MoreHorizontal className="h-4 w-4" /><span>More</span>
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>More Actions</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 p-2">
                {/* Line actions (require selection) */}
                {!noSel && (
                  <>
                    <Button variant="outline" className="w-full justify-start" onClick={() => selectedLine && onNote(selectedLine)}>
                      <StickyNote className="h-4 w-4 mr-2" /> Note
                    </Button>
                    {onVoidItem && (
                      <Button variant="destructive" className="w-full justify-start" onClick={() => selectedLine && onVoidItem(selectedLine)}>
                        <AlertTriangle className="h-4 w-4 mr-2" /> Void
                      </Button>
                    )}
                    {onRemove && (
                      <Button variant="destructive" className="w-full justify-start" onClick={() => selectedLine && onRemove(selectedLine)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                      </Button>
                    )}
                  </>
                )}
                {/* Order-level actions */}
                {!empty && (
                  <>
                    <hr className="my-2 border-slate-200" />
                    <Button variant="outline" className="w-full justify-start" disabled={!canDiscount} onClick={onAddDiscount} title={canDiscount ? "Order discount" : "Requires discount permission"}>
                      <Percent className="h-4 w-4 mr-2" /> Discount %
                    </Button>
                    {!hideCafeFeatures && onMoveItems && (
                      <Button variant="outline" className="w-full justify-start" onClick={onMoveItems} title="Move items to another table">
                        <ArrowLeftRight className="h-4 w-4 mr-2" /> Move
                      </Button>
                    )}
                    {!hideCafeFeatures && onSplit && (
                      <Button variant="outline" className="w-full justify-start" onClick={onSplit} title="Split the bill">
                        <SplitIcon className="h-4 w-4 mr-2" /> Split
                      </Button>
                    )}
                    {hideCafeFeatures && onHold && (
                      <Button variant="outline" className="w-full justify-start" onClick={onHold} title="Park this order">
                        <Pause className="h-4 w-4 mr-2" /> Hold
                      </Button>
                    )}
                    {hideCafeFeatures && onHeldOrders && (
                      <Button variant="outline" className="w-full justify-start" onClick={onHeldOrders} title="Recall a parked order">
                        <Pause className="h-4 w-4 mr-2" /> Held
                      </Button>
                    )}
                    {hideCafeFeatures && onHandover && (
                      <Button variant="outline" className="w-full justify-start" onClick={onHandover} title="Hand over shift">
                        <ArrowLeftRight className="h-4 w-4 mr-2" /> Handover
                      </Button>
                    )}
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Numpad — Odoo model: pick a line, choose a mode, type digits. */}
        <div className="pos-numpad">
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('1')}>1</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('2')}>2</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('3')}>3</button>
          <button type="button" className={"pos-numkey mode" + (mode === 'qty' ? ' active' : '')} disabled={noSel} onClick={() => pickMode('qty')} title="Edit quantity">
            <span className="pos-numkey-lbl">Qty</span>
            <span className="pos-numkey-val">{modeValue('qty')}</span>
          </button>

          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('4')}>4</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('5')}>5</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('6')}>6</button>
          <button type="button" className={"pos-numkey mode" + (mode === 'disc' ? ' active' : '')} disabled={noSel || !canDiscount} onClick={() => pickMode('disc')} title={canDiscount ? "Edit discount %" : "Requires discount permission"}>
            <span className="pos-numkey-lbl">%</span>
            <span className="pos-numkey-val">{modeValue('disc')}</span>
          </button>

          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('7')}>7</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('8')}>8</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('9')}>9</button>
          <button type="button" className={"pos-numkey mode" + (mode === 'price' ? ' active' : '')} disabled={noSel || !canOverridePrice} onClick={() => pickMode('price')} title={canOverridePrice ? "Edit unit price" : "Requires price-override permission"}>
            <span className="pos-numkey-lbl">Price</span>
            <span className="pos-numkey-val">{modeValue('price')}</span>
          </button>

          <button type="button" className="pos-numkey op" disabled={noSel || mode === 'qty'} onClick={pressSign} title="Toggle sign">±</button>
          <button type="button" className="pos-numkey" disabled={noSel} onClick={() => pressDigit('0')}>0</button>
          <button type="button" className="pos-numkey op" disabled={noSel} onClick={pressDot}>.</button>
          <button type="button" className="pos-numkey back" disabled={noSel} onClick={pressBackspace} title="Backspace">
            <BackspaceIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {hasZeroQty ? (
        <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-rose-700 bg-rose-50 border-t border-rose-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {zeroQtyLines.length === 1 ? '1 line has' : `${zeroQtyLines.length} lines have`} no quantity.
            Set a quantity or void {zeroQtyLines.length === 1 ? 'it' : 'them'} to continue.
          </span>
        </div>
      ) : null}

      {/* Primary actions — print + pay */}
      <div className="pos-order-actions">
        {!hideCafeFeatures && (
          <button type="button" className="pos-action-btn-pro bg-sky-600" onClick={onPrintKot} disabled={cannotTransact} title={blockedReason}>
            <Printer className="pos-action-icon" /> KOT
          </button>
        )}

        <button
          type="button"
          className="pos-action-btn-pro bg-purple"
          onClick={billAlreadyPrinted ? onPrintAdditionalBill : onPrintBill}
          disabled={cannotTransact}
          title={blockedReason ?? (billAlreadyPrinted ? 'Print additional bill for new items' : 'Print bill (F8)')}
        >
          <Receipt className="pos-action-icon" /> {billAlreadyPrinted ? 'Add Bill' : 'Bill'}{' '}
          {!billAlreadyPrinted && <span className="pos-kbd">F8</span>}
        </button>


        {tableId && onSettleTab ? (
          <button type="button" className="pos-action-btn-pro bg-emerald pos-pay" onClick={onSettleTab} disabled={cannotTransact} title={blockedReason ?? "Settle (pay) this table's order"}>
            <CreditCard className="pos-action-icon" /> Settle Bill
          </button>
        ) : (
          <button type="button" className="pos-action-btn-pro bg-emerald pos-pay" onClick={onCharge} disabled={cannotTransact} title={blockedReason}>
            <CreditCard className="pos-action-icon" /> Pay <span className="pos-kbd">F2</span>
          </button>
        )}
      </div>
    </div>
  );
};
