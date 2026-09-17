/**
 * Lakeview Café & Grill — business policy v1 (small café/restaurant defaults).
 *
 * These are business decisions, not code decisions. The simulation harness
 * reads them to compute the INTENDED outcome independently of the POS. Change
 * them only with owner/accountant approval and bump `version`.
 */
export const BUSINESS_POLICY = {
  version: '2026-09-17.v1',
  approvedBy: 'owner + accountant (pending sign-off)',
  currency: { code: 'UGX', operationalScale: 0, storageScale: 2 },
  timezone: 'Africa/Kampala',

  tradingDate: {
    /** Trading day window. Sales after midnight belong to the session's trading date. */
    opensAt: '06:00',
    closesAt: '23:59',
    rule: 'A sale belongs to the trading date of the cash session it was rung under; post-midnight sales stay on the previous trading date while that session is open.',
    offline: 'Offline sales keep original occurredAt, trading date and session; older than the offline window need review.',
  },

  tax: {
    /** Standard VAT (Uganda). Menu prices are VAT-inclusive (shelf price = what the guest pays). */
    standardRatePercent: 18,
    pricesInclusive: true,
    exemptItems: ['WATER-500'],
    /** Exact decimal maths; tax rounded once per tax line to whole shillings, half-up. */
    rounding: { level: 'tax_line', scale: 0, mode: 'half_up' },
  },

  costing: { method: 'AVCO' },
  freightAfterSale: 'Capitalise into inventory; share already sold goes to COGS; never rewrite historical sales.',
  priceVariance: 'Keep expected vs actual unit cost + variance; never overwrite historical purchase or sales records.',
  waste: {
    reasons: ['normal_production', 'spoilage', 'expired', 'burnt', 'damaged', 'customer_return', 'preparation_error', 'other'],
    rule: 'Normal waste follows recipe costing; abnormal waste is a separate expense/loss with reason, user, time, location.',
    cancelledAfterKot: 'Unpaid food cancelled after KOT is not revenue; ingredients follow the waste policy.',
  },
  refunds: { rule: 'Refund ≤ collected − already refunded; to the original tender; stock back only on restock disposition; COGS reversed at historical cost.' },
  cash: { rule: 'Expected drawer = float + cash collected − change − cash refunds + pay-ins − pay-outs − drops.' },
  pilot: { mode: 'SHADOW', rule: 'Existing POS stays authoritative; new POS reconciled against scenario, authoritative system and its own books.' },
} as const;
