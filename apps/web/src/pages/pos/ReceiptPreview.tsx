import { Printer, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  note?: string;
  /** Selected modifier names, e.g. ["Large", "Extra shot"]. Printed under the item. */
  modifiers?: string[];
  variantName?: string;
  accompanimentNames?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  type: 'bill' | 'kot';
  title: string;
  lines: ReceiptLine[];
  total: number;
  discountPercent?: number;
  discountAmount?: number;
  orderTypeLabel?: string;
  tableLabel?: string;
  customerName?: string;
  subtitle?: string;
  /** For additional bills: previous subtotal already billed */
  previousSubtotal?: number;
  /** For additional bills: grand total including all items */
  grandTotal?: number;
  onPrint?: () => void;
}

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;

const now = () => {
  const d = new Date();
  return d.toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const ReceiptPreview: React.FC<Props> = ({
  open, onClose, type, title, lines, total,
  discountPercent, discountAmount, orderTypeLabel, tableLabel, customerName,
  subtitle, previousSubtotal, grandTotal, onPrint,
}) => {
  const empty = lines.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!max-w-[400px] p-0 overflow-hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="bg-slate-800 text-white p-0 m-0">
          <DialogTitle className="text-white text-xs font-semibold uppercase tracking-wider px-3 pt-2">
            {title}
          </DialogTitle>
          {subtitle && (
            <DialogDescription className="text-sky-300 text-[10px] font-bold px-3 pb-2">
              {subtitle}
            </DialogDescription>
          )}
        </DialogHeader>
        {/* Toolbar */}
        <div className="flex items-center justify-between bg-slate-800 px-3 py-2 text-white">
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-white hover:bg-white/20"
              onClick={() => { onPrint?.(); window.print(); }}
            >
              <Printer className="h-3.5 w-3.5 mr-1" /> Print
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-white hover:bg-white/20" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Receipt body — thermal printer width */}
        <div className="flex justify-center bg-slate-100 p-4">
          <div className="bg-white shadow-sm" style={{ width: 300, fontFamily: "'Courier New', Courier, monospace", fontSize: 11, lineHeight: 1.4 }}>
            {/* Logo */}
            <div className="px-3 pt-3 pb-1 text-center border-b border-dashed border-slate-300">
              <img src="/abiliz-logo.png" alt="Logo" className="mx-auto max-w-full" style={{ maxHeight: 60 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>

            {/* Header */}
            <div className="px-3 pt-2 pb-2 text-center border-b border-dashed border-slate-300">
              <div className="text-sm font-bold uppercase tracking-wider">Cafe POS</div>
              <div className="text-[10px] text-slate-500">Point of Sale</div>
              <div className="text-[10px] text-slate-500 mt-1">{now()}</div>
              {orderTypeLabel && (
                <div className="text-[10px] font-semibold text-slate-700 mt-1">{orderTypeLabel}</div>
              )}
              {tableLabel && (
                <div className="text-[10px] text-slate-700">{tableLabel}</div>
              )}
              {customerName && (
                <div className="text-[10px] text-slate-700">Customer: {customerName}</div>
              )}
              {subtitle && (
                <div className="text-[10px] font-bold text-sky-700 mt-1">{subtitle}</div>
              )}
              {type === 'kot' && (
                <div className="text-[10px] font-bold text-amber-700 mt-1">** KITCHEN ORDER TICKET **</div>
              )}
            </div>

            {/* Items header */}
            <div className="px-3 py-1.5 border-b border-dashed border-slate-300 text-[10px] font-bold uppercase text-slate-500 flex">
              <span className="flex-1">Item</span>
              <span className="w-10 text-right">Qty</span>
              <span className="w-16 text-right">Price</span>
            </div>

            {/* Items */}
            {empty ? (
              <div className="px-3 py-6 text-center text-slate-400 text-[10px]">No items</div>
            ) : (
              <div className="px-3 py-1">
                {lines.map((it, i) => (
                  <div key={i}>
                    <div className="flex items-start py-0.5">
                      <span className="flex-1 truncate">{it.name}</span>
                      <span className="w-10 text-right">{it.quantity}</span>
                      <span className="w-16 text-right">{fmt(it.unitPrice * it.quantity)}</span>
                    </div>
                    {it.variantName && (
                      <div className="text-[9px] text-slate-600 pl-1 -mt-0.5">{it.variantName}</div>
                    )}
                    {it.accompanimentNames && it.accompanimentNames.length > 0 && (
                      <div className="text-[9px] text-slate-600 pl-1 -mt-0.5">+ {it.accompanimentNames.join(', ')}</div>
                    )}
                    {it.modifiers && it.modifiers.length > 0 && (
                      <div className="text-[9px] text-slate-600 pl-1 -mt-0.5">+ {it.modifiers.join(', ')}</div>
                    )}
                    {it.discountPercent > 0 && (
                      <div className="text-[9px] text-emerald-600 pl-1 -mt-0.5">-{it.discountPercent}% disc</div>
                    )}
                    {it.note && (
                      <div className="text-[9px] text-slate-500 pl-1 -mt-0.5 italic">Note: {it.note}</div>
                    )}
                    {type === 'kot' && (
                      <div className="text-[9px] text-slate-500 pl-1 -mt-0.5">@ {fmt(it.unitPrice)} ea</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Divider */}
            <div className="border-t border-dashed border-slate-300 mx-3" />

            {/* Totals */}
            {type === 'bill' && (
              <div className="px-3 py-2 text-[10px]">
                <div className="flex justify-between py-0.5">
                  <span>Subtotal</span>
                  <span>{fmt(lines.reduce((s, it) => s + it.unitPrice * it.quantity, 0))}</span>
                </div>
                {discountPercent && discountPercent > 0 ? (
                  <div className="flex justify-between py-0.5 text-emerald-600">
                    <span>Discount ({discountPercent}%)</span>
                    <span>-{fmt(discountAmount ?? 0)}</span>
                  </div>
                ) : null}
                {subtitle && previousSubtotal != null && grandTotal != null ? (
                  <>
                    <div className="flex justify-between py-0.5 mt-1">
                      <span className="text-slate-500">Previous Total</span>
                      <span className="text-slate-500">{fmt(previousSubtotal)}</span>
                    </div>
                    <div className="flex justify-between py-0.5 text-slate-700">
                      <span>Additional Total</span>
                      <span>{fmt(total)}</span>
                    </div>
                    <div className="flex justify-between py-0.5 text-sm font-bold border-t-2 border-slate-400 pt-1 mt-1">
                      <span>Grand Total Due</span>
                      <span>{fmt(grandTotal)}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between py-0.5 text-sm font-bold border-t border-dashed border-slate-300 pt-1 mt-1">
                    <span>TOTAL</span>
                    <span>{fmt(total)}</span>
                  </div>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="px-3 pb-3 pt-2 text-center border-t border-dashed border-slate-300 text-[9px] text-slate-400">
              {type === 'bill' ? 'Thank you for your visit!' : 'Prepare and serve with care'}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
