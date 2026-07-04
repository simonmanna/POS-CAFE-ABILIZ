/**
 * The contract every module uses to post to the ledger (ADR-009).
 * Modules NEVER create JournalEntry rows directly — they build a PostingRequest
 * (typically via AccountDeterminationService) and call PostingService.post().
 */
/**
 * Journal-entry statuses that affect account balances. A reversal posts a NEW
 * `posted` entry AND flips the original to `reversed`; BOTH must be summed so
 * the pair nets to zero. Summing only `posted` would leave the reversal alone,
 * flipping the sign of the original transaction (see accounting audit C1).
 * `draft` entries are intentionally excluded — they are not yet in the books.
 */
export const BALANCE_AFFECTING_STATUSES = ['posted', 'reversed'] as const;

export interface PostingLineInput {
  accountId: string;
  /** Transaction-currency amount. Exactly one of debit/credit must be > 0. */
  debit?: number | string;
  credit?: number | string;
  partnerId?: string;
  description?: string;
  /** Reporting dimensions; fall back to the request-level values when omitted. */
  branchId?: string;
  costCenterId?: string;
}

export interface PostingRequest {
  /** Journal code, e.g. "SALES", "CASH", "BANK", "GEN". */
  journalCode: string;
  date: Date | string;
  description?: string;
  currencyId?: string;
  /** Rate to the org functional currency. Default 1. */
  exchangeRate?: number;
  /** Provenance, e.g. sourceType="invoice", sourceId=<documentId>. */
  sourceType?: string;
  sourceId?: string;
  /** Reporting dimensions applied to the entry and, by default, every line. */
  branchId?: string;
  costCenterId?: string;
  lines: PostingLineInput[];
}

/** Documents may implement this to describe how they post. */
export interface Postable {
  toPostingRequest(): PostingRequest | Promise<PostingRequest>;
}
