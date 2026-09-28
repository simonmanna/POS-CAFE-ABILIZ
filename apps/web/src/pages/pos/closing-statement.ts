import { useAuthStore } from '@/stores/auth.store';

/**
 * Cash Register Closing Statement Summary — previewed after a shift close.
 * Same 44-column monospace ticket the bill / KOT use: the HTML wraps it in the
 * 72mm paper for the on-screen preview, and the text is what
 * POST /pos/receipts/print-closing-statement sends to the thermal printer.
 */
const W = 44;

const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
const orgName = () => useAuthStore.getState().organization?.name || 'ABILIZ CAFE AND PATISSERIE';
const money = (n: number | string | null | undefined) => Number(n || 0).toLocaleString();
const cur = (n: number | string | null | undefined) => `${orgCur()} ${money(n)}`;

const center = (s: string) => {
  const pad = Math.max(0, Math.floor((W - s.length) / 2));
  return ' '.repeat(pad) + s;
};
const two = (l: string, r: string) => l + ' '.repeat(Math.max(1, W - l.length - r.length)) + r;
const methodLabel = (m: string) =>
  m.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export interface ClosingStatementInput {
  openingFloat: number | string | null | undefined;
  openedAt?: string | null;
  closedAt?: string | null;
  registerName?: string | null;
  cashierName?: string | null;
  /** From the reconciliation / Z report: { salesTotal, saleCount, refundedTotal, payInsTotal, payOutsTotal, ... }. */
  totals?: Record<string, number | string | null | undefined>;
  /** Per-tender sales: [{ method, count, total }]. */
  byMethod?: Array<{ method: string; count: number; total: string | number }>;
  counted?: number | string | null;
  expected?: number | string | null;
  difference?: number | string | null;
}

export function buildClosingStatementText(p: ClosingStatementInput): string {
  const out: string[] = [];
  const totals = p.totals ?? {};

  out.push('='.repeat(W));
  out.push(center(orgName().toUpperCase()));
  out.push(center('CASH REGISTER CLOSING'));
  out.push(center('STATEMENT SUMMARY'));
  out.push('-'.repeat(W));
  if (p.registerName) out.push(two('Register', p.registerName.slice(0, 30)));
  if (p.cashierName) out.push(two('Cashier', p.cashierName.slice(0, 30)));
  out.push(two('Opened', when(p.openedAt)));
  out.push(two('Closed', when(p.closedAt)));
  out.push('-'.repeat(W));
  out.push(two('Opening Float', cur(p.openingFloat)));
  out.push('-'.repeat(W));
  out.push(two('TOTAL SALES', cur(totals.salesTotal ?? 0)));
  if (totals.saleCount != null) out.push(two('Transactions', String(totals.saleCount)));
  if (Number(totals.refundedTotal ?? 0) > 0) {
    out.push(two('Refunds', '-' + cur(totals.refundedTotal)));
    out.push(two('Net Sales', cur(totals.netSalesAfterRefunds ?? totals.salesTotal ?? 0)));
  }
  out.push('-'.repeat(W));
  out.push(center('SALES BY PAYMENT MODE'));
  const modes = (p.byMethod ?? []).filter((m) => Number(m.total || 0) !== 0);
  if (!modes.length) out.push(center('No sales recorded'));
  for (const m of modes) {
    out.push(two(methodLabel(m.method).slice(0, 30), cur(m.total)));
    if (m.count) out.push(`   ${m.count} transaction${m.count === 1 ? '' : 's'}`);
  }
  if (Number(totals.payInsTotal ?? 0) > 0) out.push(two('Pay-ins (owner cash-in)', cur(totals.payInsTotal)));
  if (Number(totals.payOutsTotal ?? 0) > 0) out.push(two('Pay-outs (withdrawals)', cur(totals.payOutsTotal)));
  out.push('-'.repeat(W));
  out.push(two('Cash Expected', cur(p.expected)));
  out.push(two('Cash Counted', cur(p.counted)));
  const diff = Number(p.difference ?? 0);
  out.push(two('Difference', (diff > 0 ? '+' : '') + cur(diff)));
  out.push('-'.repeat(W));
  out.push(two('Printed', when(new Date().toISOString())));
  out.push(center('Thank you!'));
  out.push('='.repeat(W));
  return out.join('\n');
}

export function buildClosingStatementHtml(p: ClosingStatementInput): string {
  const text = buildClosingStatementText(p);
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Closing Statement</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { margin:0; padding:0; width:72mm; height:auto; }
  body { font-family:'Courier New',Courier,monospace; font-size:10px; line-height:1.25; white-space:pre; padding:1mm 1mm 14mm; }
  @media print { @page { margin:0; size:72mm 297mm; } html,body { width:72mm; height:auto; } }
</style></head>
<body>${esc(text).replace(/\n/g, '<br>')}<script>
  window.onload = function () {
    var mm = Math.max(40, Math.ceil(document.body.scrollHeight * 25.4 / 96) + 4);
    var s = document.createElement('style');
    s.textContent = '@page { size:72mm ' + mm + 'mm; margin:0; }';
    document.head.appendChild(s);
  };
</script></body></html>`;
}
