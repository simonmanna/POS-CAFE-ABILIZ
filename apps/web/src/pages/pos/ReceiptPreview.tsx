import { useMemo, useRef } from 'react';
import { Printer, Download, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
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
const money = (n: number | string) => Number(n || 0).toLocaleString();

const now = () => {
  const d = new Date();
  return d.toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * Build a standalone 80mm monospace thermal document for the bill / KOT and
 * print it through a hidden iframe — the same isolated-print mechanism the
 * settlement receipt uses. `window.print()` on the app page pulls in the whole
 * UI; this prints only the ticket.
 */
function buildThermalHtml(p: {
  type: 'bill' | 'kot';
  lines: ReceiptLine[];
  total: number;
  discountPercent?: number;
  discountAmount?: number;
  orderTypeLabel?: string;
  tableLabel?: string;
  customerName?: string;
  subtitle?: string;
  previousSubtotal?: number;
  grandTotal?: number;
}): string {
  const W = 40;
  const out: string[] = [];
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const two = (l: string, r: string) => {
    const gap = Math.max(1, W - l.length - r.length);
    return l + ' '.repeat(gap) + r;
  };

  out.push('='.repeat(W));
  out.push(center('CAFE POS'));
  out.push(center('Point of Sale'));
  out.push(center(now()));
  if (p.orderTypeLabel) out.push(center(p.orderTypeLabel));
  if (p.tableLabel) out.push(center(p.tableLabel));
  if (p.customerName) out.push(center('Customer: ' + p.customerName));
  if (p.subtitle) out.push(center(p.subtitle));
  if (p.type === 'kot') out.push(center('** KITCHEN ORDER TICKET **'));
  out.push('-'.repeat(W));

  if (p.type === 'kot') {
    // Kitchen ticket: quantity + item + modifiers/notes, no prices.
    if (p.lines.length === 0) out.push(center('No items'));
    for (const it of p.lines) {
      out.push(`${('x' + it.quantity).padStart(4)}  ${it.name.slice(0, W - 6)}`);
      if (it.variantName) out.push(`       ${it.variantName}`);
      if (it.accompanimentNames?.length) out.push(`       + ${it.accompanimentNames.join(', ')}`);
      if (it.modifiers?.length) out.push(`       + ${it.modifiers.join(', ')}`);
      if (it.note) out.push(`       Note: ${it.note}`);
    }
    out.push('-'.repeat(W));
    out.push(center('Prepare and serve with care'));
  } else {
    const descW = 20;
    const qtyW = 4;
    const priceW = W - descW - qtyW;
    out.push(`${'Item'.padEnd(descW)}${'Qty'.padStart(qtyW)}${'Price'.padStart(priceW)}`);
    out.push('-'.repeat(W));
    if (p.lines.length === 0) out.push(center('No items'));
    let subtotal = 0;
    for (const it of p.lines) {
      const lineTotal = it.unitPrice * it.quantity;
      subtotal += lineTotal;
      out.push(
        `${it.name.slice(0, descW).padEnd(descW)}${String(it.quantity).padStart(qtyW)}${money(lineTotal).padStart(priceW)}`,
      );
      if (it.variantName) out.push(`  ${it.variantName}`);
      if (it.accompanimentNames?.length) out.push(`  + ${it.accompanimentNames.join(', ')}`);
      if (it.modifiers?.length) out.push(`  + ${it.modifiers.join(', ')}`);
      if (it.discountPercent > 0) out.push(`  -${it.discountPercent}% disc`);
      if (it.note) out.push(`  Note: ${it.note}`);
    }
    out.push('-'.repeat(W));
    out.push(two('Subtotal', fmt(subtotal)));
    if (p.discountPercent && p.discountPercent > 0) {
      out.push(two(`Discount (${p.discountPercent}%)`, '-' + fmt(p.discountAmount ?? 0)));
    }
    if (p.subtitle && p.previousSubtotal != null && p.grandTotal != null) {
      out.push(two('Previous Total', fmt(p.previousSubtotal)));
      out.push(two('Additional Total', fmt(p.total)));
      out.push('='.repeat(W));
      out.push(two('Grand Total Due', fmt(p.grandTotal)));
    } else {
      out.push('='.repeat(W));
      out.push(two('TOTAL', fmt(p.total)));
    }
    out.push('-'.repeat(W));
    out.push(center('Thank you for your visit!'));
  }

  const text = out.join('\n');
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=80mm"><title>Print</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { margin:0; padding:0; width:80mm; height:auto; }
  body { font-family:'Courier New',Courier,monospace; font-size:12px; line-height:1.15; white-space:pre; padding:1px 4px 2px; }
  @media print { @page { margin:0; size:80mm auto; } html,body { width:80mm; height:auto; } }
</style></head>
<body>${esc(text).replace(/\n/g, '<br>')}</body></html>`;
}


export const ReceiptPreview: React.FC<Props> = ({
  open, onClose, type, title, lines, total,
  discountPercent, discountAmount, orderTypeLabel, tableLabel, customerName,
  subtitle, previousSubtotal, grandTotal, onPrint,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Same isolated-print flow the settlement receipt uses — only the content differs.
  const html = useMemo(
    () => buildThermalHtml({
      type, lines, total, discountPercent, discountAmount,
      orderTypeLabel, tableLabel, customerName, subtitle, previousSubtotal, grandTotal,
    }),
    [type, lines, total, discountPercent, discountAmount, orderTypeLabel, tableLabel, customerName, subtitle, previousSubtotal, grandTotal],
  );

  const doPrint = () => {
    onPrint?.();
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const doDownload = () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}-${(title.replace(/\s+/g, '-').toLowerCase() || type)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-slate-700 to-slate-900 text-white p-4">
          <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
            <Printer className="h-4 w-4" /> {title}
          </DialogTitle>
          <DialogDescription className="text-slate-300 text-xs">
            {subtitle
              ? subtitle
              : type === 'kot'
                ? 'Kitchen order ticket — preview and print.'
                : 'Preview and print the bill.'}
          </DialogDescription>
        </DialogHeader>

        <div className="bg-slate-200 p-4 flex justify-center min-h-[500px]">
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title={`${type} preview`}
            className="bg-white shadow-md"
            style={{ width: 340, height: 600 }}
          />
        </div>

        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50 flex gap-2 justify-between">
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={doDownload}>
              <Download className="h-4 w-4 mr-1" /> Download HTML
            </Button>
            <Button onClick={doPrint} style={{ background: '#16a34a' }}>
              <Printer className="h-4 w-4 mr-1" /> Print {type === 'kot' ? 'KOT' : 'Bill'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
