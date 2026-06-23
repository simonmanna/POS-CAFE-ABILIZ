// HTML builders for the on-screen receipt and KOT previews. These mirror
// the print-server templates so the cashier can preview exactly what will
// be printed.
import type { Order, Payment } from './types';

const fmt = (n: number) => Number(n || 0).toLocaleString();
const dash = '-'.repeat(32);

export interface ReceiptContext {
  businessName?: string;
  businessAddress?: string;
  taxId?: string;
  currency?: string;
  footer?: string;
  receiptNumber?: string;
}

export function buildReceiptHtml(order: Order, ctx: ReceiptContext): string {
  const cur = ctx.currency || 'UGX';
  const items = (order.items || []).filter((i) => !i.voided);
  const c = (n: number) => `${cur} ${fmt(n)}`;
  const itemsRows = items.map((it) => {
    const addOns = (() => {
      try { return it.addOns ? JSON.parse(it.addOns) as { name: string; price: number }[] : []; }
      catch { return []; }
    })();
    const addHtml = addOns.length
      ? `<div style="font-size:11px;color:#666;padding-left:8px;">+ ${addOns.map((a) => a.name).join(', ')}</div>`
      : '';
    const notesHtml = it.notes ? `<div style="font-size:11px;color:#a16207;padding-left:8px;font-style:italic;">! ${escapeHtml(it.notes)}</div>` : '';
    return `<tr><td colspan="3" style="padding:2px 0;font-weight:600;">${escapeHtml(it.menu?.name || '')}${addHtml}${notesHtml}</td></tr>
      <tr><td style="padding:0 0 4px 0;color:#666;font-size:11px;">${it.quantity} × ${c(it.unitPrice)}</td><td></td><td style="text-align:right;padding:0 0 4px 0;">${c(it.totalPrice)}</td></tr>`;
  }).join('');

  const pays: Payment[] = order.payments || [];
  const payRows = pays.map((p) => {
    const change = (p.change || 0) > 0 ? ` (chg ${c(p.change)})` : '';
    const ref = p.reference ? ` <span style="color:#666;">${escapeHtml(p.reference)}</span>` : '';
    return `<tr><td colspan="2" style="padding:1px 0;">${p.method}${ref}</td><td style="text-align:right;">${c(p.tendered || p.amount)}${change ? ` <span style="color:#666;font-size:11px;">${change}</span>` : ''}</td></tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(order.orderNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', monospace; width: 80mm; margin: 0 auto; padding: 8px; color: #000; font-size: 12px; }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: 800; }
  .big { font-size: 16px; font-weight: 800; }
  .sep { border-top: 1px dashed #000; margin: 4px 0; height: 0; }
  .dbl { border-top: 1px solid #000; margin: 4px 0; height: 0; }
  table { width: 100%; border-collapse: collapse; }
  .total { font-size: 16px; font-weight: 800; }
  .footer { margin-top: 12px; text-align: center; font-size: 11px; }
  .qr { text-align: center; margin-top: 8px; }
</style></head>
<body>
  <div class="center bold" style="font-size:18px;">${escapeHtml(ctx.businessName || 'Cafe')}</div>
  ${ctx.businessAddress ? `<div class="center" style="font-size:11px;">${escapeHtml(ctx.businessAddress)}</div>` : ''}
  ${ctx.taxId ? `<div class="center" style="font-size:11px;">TIN: ${escapeHtml(ctx.taxId)}</div>` : ''}
  <div class="sep"></div>
  <table>
    <tr><td>Order #</td><td class="right">${escapeHtml(order.orderNumber)}</td></tr>
    <tr><td>Date</td><td class="right">${new Date().toLocaleString()}</td></tr>
    ${order.table ? `<tr><td>Table</td><td class="right">T${order.table.number}${order.table.zone ? ` (${escapeHtml(order.table.zone)})` : ''}</td></tr>` : ''}
    <tr><td>Type</td><td class="right">${(order.type || '').replace('_', ' ')}</td></tr>
    ${order.customer ? `<tr><td>Guest</td><td class="right">${escapeHtml(order.customer.name)}</td></tr>` : ''}
    <tr><td>Cashier</td><td class="right">${escapeHtml((order as any).user?.name || '')}</td></tr>
  </table>
  <div class="sep"></div>
  <table>${itemsRows}</table>
  <div class="sep"></div>
  <table>
    <tr><td>Subtotal</td><td class="right">${c(order.subtotal || 0)}</td></tr>
    ${(order.discountAmount || 0) > 0 ? `<tr><td>Discount</td><td class="right">−${c(order.discountAmount)}</td></tr>` : ''}
    ${(order.taxAmount || 0) > 0 ? `<tr><td>Tax</td><td class="right">+${c(order.taxAmount)}</td></tr>` : ''}
    ${(order.serviceChargeAmount || 0) > 0 ? `<tr><td>Service chg</td><td class="right">+${c(order.serviceChargeAmount)}</td></tr>` : ''}
  </table>
  <div class="dbl"></div>
  <table><tr><td class="big">TOTAL</td><td class="right big">${c(order.total || 0)}</td></tr></table>
  <div class="sep"></div>
  ${payRows ? `<table>${payRows}</table><div class="sep"></div>` : ''}
  <div class="qr"><canvas id="qr" width="120" height="120"></canvas><div style="font-size:9px;color:#666;">Scan for e-receipt</div></div>
  <div class="footer">${escapeHtml(ctx.footer || 'Thank you for your visit!')}</div>
  <div class="footer" style="font-size:9px;">Printed ${new Date().toLocaleString()}</div>
  <script>
    (function(){
      var s='${escapeHtml(order.orderNumber + '|' + (order.total || 0))}';
      // simple QR pattern (visual only, no library). Replaced with a placeholder box.
      var c=document.getElementById('qr');
      if(c){ var x=c.getContext('2d'); x.fillStyle='#000'; var i=0; for(var y=0;y<12;y++){ for(var xx=0;xx<12;xx++){ if(((s.charCodeAt((i++)%s.length)||0)+(y*xx))%3===0) x.fillRect(xx*10,y*10,9,9);} } }
    })();
  </script>
</body></html>`;
}

export function buildKOTHtml(order: Order, station?: 'BAR' | 'KITCHEN' | 'CAFE'): string {
  const items = (order.items || []).filter((i) => !i.voided);
  const rows = items.map((it) => {
    const addOns = (() => {
      try { return it.addOns ? JSON.parse(it.addOns) as { name: string }[] : []; }
      catch { return []; }
    })();
    const addHtml = addOns.length ? `<div style="font-size:11px;color:#666;padding-left:12px;">+ ${addOns.map((a) => a.name).join(', ')}</div>` : '';
    const notesHtml = it.notes ? `<div style="font-size:12px;color:#dc2626;padding-left:12px;font-weight:700;">! ${escapeHtml(it.notes)}</div>` : '';
    return `<div style="margin:6px 0;padding-bottom:6px;border-bottom:1px dashed #000;">
      <div style="font-size:18px;font-weight:800;">${it.quantity} × ${escapeHtml(it.menu?.name || '')}</div>
      ${addHtml}${notesHtml}
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>KOT ${escapeHtml(order.orderNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', monospace; width: 80mm; margin: 0 auto; padding: 8px; color: #000; font-size: 12px; }
  .center { text-align: center; }
  .bold { font-weight: 800; }
  .sep { border-top: 1px dashed #000; margin: 4px 0; height: 0; }
  .big { font-size: 16px; font-weight: 800; }
</style></head>
<body>
  <div class="center big">** ${(station || 'KITCHEN').toUpperCase()} **</div>
  <div class="center" style="font-size:11px;">Kitchen Order Ticket</div>
  <div class="sep"></div>
  <div style="display:flex;justify-content:space-between;"><span>Order</span><span class="bold">${escapeHtml(order.orderNumber)}</span></div>
  <div style="display:flex;justify-content:space-between;"><span>Type</span><span>${(order.type || '').replace('_', ' ')}</span></div>
  ${order.table ? `<div style="display:flex;justify-content:space-between;"><span>Table</span><span class="bold">T${order.table.number}${order.table.zone ? ` (${escapeHtml(order.table.zone)})` : ''}</span></div>` : ''}
  ${order.customer ? `<div style="display:flex;justify-content:space-between;"><span>Guest</span><span>${escapeHtml(order.customer.name)}</span></div>` : ''}
  <div style="display:flex;justify-content:space-between;"><span>Time</span><span>${new Date().toLocaleString()}</span></div>
  <div class="sep"></div>
  ${rows}
  <div class="sep"></div>
  <div class="center" style="font-size:11px;">Items: ${items.length} · ${new Date().toLocaleTimeString()}</div>
</body></html>`;
}

function escapeHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
