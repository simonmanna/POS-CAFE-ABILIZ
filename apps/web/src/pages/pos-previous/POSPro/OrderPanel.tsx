import React, { useMemo } from 'react';
import {
  ShoppingCart, Plus, Minus, StickyNote, Send, Printer, CreditCard, Scissors, User, Tag, Hash, Receipt, Trash2, X, Pause,
} from 'lucide-react';
import { getFoodEmoji } from './food-images';
import type { Order, OrderItem } from './types';

interface Props {
  order: Order | null;
  tableNumber?: number;
  customerName?: string;
  onInc: (item: OrderItem) => void;
  onDec: (item: OrderItem) => void;
  onRemove: (item: OrderItem) => void;
  onVoid: (item: OrderItem) => void;
  onNote: (item: OrderItem) => void;
  onSendKOT: () => void;
  onPrintBill: () => void;
  onCharge: () => void;
  onSplit: () => void;
  onAddCustomer: () => void;
  onAddDiscount: () => void;
  onAddTax: () => void;
  onCloseOrder: () => void;
  onLineDiscount?: (item: OrderItem) => void;
  onHold?: (() => void) | null;
}

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export const OrderPanel: React.FC<Props> = ({
  order, tableNumber, customerName, onInc, onDec, onRemove, onVoid, onNote,
  onSendKOT, onPrintBill, onCharge, onSplit, onAddCustomer, onAddDiscount, onAddTax, onCloseOrder, onLineDiscount, onHold,
}) => {
  const items = useMemo(() => (order?.items || []).filter((i) => !i.voided), [order]);
  const voided = useMemo(() => (order?.items || []).filter((i) => i.voided), [order]);
  const subtotal = order?.subtotal || 0;
  const discount = order?.discountAmount || 0;
  const tax = order?.taxAmount || 0;
  const sc = order?.serviceChargeAmount || 0;
  const total = order?.total || 0;
  const empty = items.length === 0;

  return (
    <div className="pos-order-pro">
      {/* Header */}
      <div className="pos-order-head">
        <div className="flex flex-col leading-tight">
          <div className="pos-ord-num">{order?.orderNumber || 'No order'}</div>
          <div className="pos-ord-table">
            {tableNumber ? `Table ${tableNumber} · ${(order?.type || 'DINE_IN').replace('_', ' ').toLowerCase()}` : 'No table selected'}
          </div>
        </div>
        {customerName ? (
          <div className="pos-ord-customer ml-2">
            <User className="h-3 w-3" />
            {customerName}
          </div>
        ) : null}
        <div className="pos-ord-actions">
          <button type="button" className="pos-ord-action" onClick={onAddCustomer} title="Add customer">
            <User className="h-4 w-4" />
          </button>
          <button type="button" className="pos-ord-action" onClick={onAddDiscount} title="Discount">
            <Tag className="h-4 w-4" />
          </button>
          <button type="button" className="pos-ord-action" onClick={onAddTax} title="Tax & service charge">
            <Hash className="h-4 w-4" />
          </button>
          {onHold ? (
            <button type="button" className="pos-ord-action" onClick={onHold} title="Hold (park) this order">
              <Pause className="h-4 w-4" />
            </button>
          ) : null}
          {order ? (
            <button type="button" className="pos-ord-action" onClick={onCloseOrder} title="Close / clear order">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Items list */}
      {empty ? (
        <div className="pos-order-empty">
          <div className="pos-empty-icon">
            <ShoppingCart className="h-7 w-7" />
          </div>
          <p className="font-semibold text-base text-slate-300">No items yet</p>
          <p className="text-xs text-slate-500">Pick a menu item to start the order</p>
        </div>
      ) : (
        <div className="pos-order-list">
          {items.map((it) => {
            const emoji = getFoodEmoji(it.menu?.name || '', it.menu?.category?.name);
            let addOns: { id: number; name: string }[] = [];
            if (it.addOns) {
              try { addOns = JSON.parse(it.addOns); } catch { /* ignore */ }
            }
            return (
              <div key={it.id} className={'pos-order-card' + (it.kotPrinted ? ' kot-sent' : '')}>
                <div className="pos-card-row">
                  <div className="pos-card-emoji">{emoji}</div>
                  <div className="flex-1 min-w-0">
                    <div className="pos-card-name truncate">{it.menu?.name}</div>
                    <div className="pos-card-line">@ {fmt(it.unitPrice)}{it.addOnsTotal ? ` · add-ons ${fmt(it.addOnsTotal)}` : ''}</div>
                  </div>
                  <div className="pos-card-price">{fmt(it.totalPrice)}</div>
                </div>
                {addOns.length > 0 ? (
                  <div className="pos-card-addons">
                    {addOns.map((a) => <span key={a.id}>+{a.name}</span>)}
                  </div>
                ) : null}
                {it.notes ? <div className="pos-card-notes">! {it.notes}</div> : null}
                <div className="pos-card-footer">
                  <div className="pos-qty">
                    <button type="button" onClick={() => onDec(it)} aria-label="decrease"><Minus className="h-3 w-3" /></button>
                    <div className="pos-qty-val">{it.quantity}</div>
                    <button type="button" onClick={() => onInc(it)} aria-label="increase"><Plus className="h-3 w-3" /></button>
                  </div>
                  <div className="pos-card-actions">
                    <button type="button" className="pos-card-action" onClick={() => onNote(it)} title="Add note">
                      <StickyNote className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="pos-card-action danger" onClick={() => onVoid(it)} title="Void item">
                      <X className="h-3.5 w-3.5" />
                    </button>
                    {onLineDiscount ? (
                      <button type="button" className="pos-card-action" onClick={() => onLineDiscount(it)} title="Line discount">
                        <Tag className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button type="button" className="pos-card-action danger" onClick={() => onRemove(it)} title="Remove from order">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {it.kotPrinted ? <div className="pos-card-kot-badge">KOT ✓</div> : null}
              </div>
            );
          })}
          {voided.length > 0 ? (
            <div className="mt-2 text-[11px] text-slate-500 px-1">
              {voided.length} voided item{voided.length > 1 ? 's' : ''} not shown
            </div>
          ) : null}
        </div>
      )}

      {/* Totals */}
      <div className="pos-order-totals">
        <div className="pos-totals-row"><span>Subtotal</span><span className="pos-amt">{fmt(subtotal)}</span></div>
        {discount > 0 ? <div className="pos-totals-row"><span>Discount</span><span className="pos-amt text-emerald-400">−{fmt(discount)}</span></div> : null}
        {tax > 0 ? <div className="pos-totals-row"><span>Tax</span><span className="pos-amt">+{fmt(tax)}</span></div> : null}
        {sc > 0 ? <div className="pos-totals-row"><span>Service charge</span><span className="pos-amt">+{fmt(sc)}</span></div> : null}
        <div className="pos-totals-row big"><span>TOTAL</span><span className="pos-amt">{fmt(total)}</span></div>
      </div>

      {/* Action grid */}
      <div className="pos-order-actions">
        <button
          type="button"
          className="pos-action-btn-pro bg-cyan"
          onClick={onSendKOT}
          disabled={!order || items.length === 0}
        >
          <Send className="pos-action-icon" /> KOT <span className="pos-kbd">F9</span>
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-purple"
          onClick={onPrintBill}
          disabled={!order}
        >
          <Receipt className="pos-action-icon" /> Bill <span className="pos-kbd">F8</span>
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-blue"
          onClick={onAddTax}
          disabled={!order}
        >
          <Hash className="pos-action-icon" /> Tax/SC
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-amber"
          onClick={onAddDiscount}
          disabled={!order}
        >
          <Tag className="pos-action-icon" /> Discount
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-pink"
          onClick={onSplit}
          disabled={!order || items.length === 0}
        >
          <Scissors className="pos-action-icon" /> Split <span className="pos-kbd">F4</span>
        </button>
        <button
          type="button"
          className="pos-action-btn-pro bg-emerald"
          onClick={onCharge}
          disabled={!order || items.length === 0}
        >
          <CreditCard className="pos-action-icon" /> Charge <span className="pos-kbd">F2</span>
        </button>
      </div>
    </div>
  );
};
