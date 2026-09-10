/**
 * Invoice statuses that count as a POS sale.
 *
 * `refunded` belongs here: a fully-refunded sale WAS rung up, and the refund is
 * reported as its own event. Leaving it out (as several reports used to) made
 * the Sales / Items / Cashier tabs disagree with the Daily-Sales totals, which
 * always included it — the same shift reconciling two different ways.
 *
 * This lives in `@erp/shared` rather than inside the POS module because HR's
 * per-employee sales analytics needs the identical definition, and `hr` and
 * `pos` are both verticals that may not import each other. Two hand-kept copies
 * of this list would eventually disagree, and the symptom would be HR and POS
 * reporting different totals for the same cashier.
 */
export const POS_SALE_STATUSES = ['posted', 'paid', 'refunded'] as const;

export type PosSaleStatus = (typeof POS_SALE_STATUSES)[number];
