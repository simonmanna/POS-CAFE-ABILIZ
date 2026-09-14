/**
 * Maps a stock-ledger line's resolved source (`kind` + `targetId`, from
 * `GET /inventory/ledger/:id`) onto the app route that shows that transaction.
 *
 * Kinds with no first-class detail page fall back to their list page, and
 * anything unresolved falls back to the generic movement page.
 */
export type LedgerSourceKind =
  | 'pos_invoice'
  | 'invoice'
  | 'credit_note'
  | 'goods_receipt'
  | 'purchase_order'
  | 'debit_note'
  | 'production_order'
  | 'rental_agreement'
  | 'repair_order'
  | 'stock_out'
  | 'waste'
  | 'stock_adjustment'
  | 'stock_transfer'
  | 'none';

export interface LedgerSourceRef {
  referenceType: string;
  referenceId: string;
  kind: LedgerSourceKind;
  targetId: string | null;
  code: string | null;
  status: string | null;
  date: string | null;
  partnerName: string | null;
  label: string;
}

/** Route for a source document, or null when the kind has no page of its own. */
export function sourceRoute(source: LedgerSourceRef | null | undefined): string | null {
  if (!source) return null;
  const id = source.targetId;

  switch (source.kind) {
    case 'pos_invoice':
      return id ? `/pos/receipts/${id}` : null;
    case 'invoice':
      return id ? `/invoices/${id}` : null;
    case 'credit_note':
      return id ? `/credit-notes/${id}` : null;
    case 'goods_receipt':
      return id ? `/procurement/goods-receipts/${id}` : null;
    case 'purchase_order':
      return id ? `/procurement/purchase-orders/${id}` : null;
    case 'production_order':
      return id ? `/manufacturing/orders/${id}` : null;
    case 'rental_agreement':
      return id ? `/rental/agreements/${id}` : null;
    case 'repair_order':
      return id ? `/repair/orders/${id}` : null;
    // List-only modules — no per-document page exists yet.
    case 'debit_note':
      return '/procurement/debit-notes';
    case 'waste':
      return source.code ? `/inventory/waste?code=${encodeURIComponent(source.code)}` : '/inventory/waste';
    case 'stock_out':
      return '/inventory/adjustments';
    case 'stock_adjustment':
      return '/inventory/adjustments';
    case 'stock_transfer':
      return '/inventory/transfers';
    default:
      return null;
  }
}

/** Where the ledger's "View" button should land for a given entry. */
export function ledgerViewRoute(entryId: string, source: LedgerSourceRef | null | undefined): string {
  return sourceRoute(source) ?? `/inventory/ledger/${entryId}`;
}

const REFERENCE_LABELS: Record<string, string> = {
  pos_invoice: 'POS Sale',
  pos_invoice_extra: 'POS Sale (extras)',
  pos_invoice_writeoff: 'POS Write-Off',
  menu_recipe: 'Recipe Consumption',
  pos_refund: 'POS Refund',
  sales_invoice: 'Sales Invoice',
  invoice: 'Invoice',
  document: 'Invoice',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  goods_receipt: 'Goods Receipt',
  purchase_order: 'Purchase Order',
  direct_stock_in: 'Stock In',
  direct_stock_out: 'Stock Out (direct)',
  stock_out: 'Stock Out',
  waste: 'Waste',
  expiry_write_off: 'Expiry Write-Off',
  stock_adjust: 'Stock Adjustment',
  adjustment: 'Stock Adjustment',
  stock_transfer: 'Stock Transfer',
  production_order: 'Production Order',
  production_qc: 'Production QC',
  production_reversal: 'Production Reversal',
  production_order_cancel: 'Production Cancelled',
  work_order: 'Work Order',
  agreement: 'Rental Agreement',
  rental_checkout: 'Rental Checkout',
  rental_return: 'Rental Return',
  rental_inspect: 'Rental Inspection',
  repair_part_issue: 'Repair Part Issue',
  min_stock: 'Min-Stock Top-Up',
  manual: 'Manual Entry',
};

/** Friendly name for a raw `referenceType`. */
export function referenceLabel(referenceType: string | null | undefined): string {
  if (!referenceType) return 'Manual';
  return (
    REFERENCE_LABELS[referenceType] ??
    referenceType.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  );
}
