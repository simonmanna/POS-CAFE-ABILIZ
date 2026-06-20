/**
 * Typed domain-event contract shared by publishers and subscribers (ADR-003).
 * Add new events here so the bus stays type-safe across modules.
 */

export const EVENTS = {
  // master data
  PartnerCreated: 'partner.created',
  PartnerUpdated: 'partner.updated',
  PartnerDeleted: 'partner.deleted',
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
  ProductDeleted: 'product.deleted',
  UserRegistered: 'user.registered',
  UserLoggedIn: 'user.logged_in',
  // accounting (Phase 2)
  JournalPosted: 'journal.posted',
  JournalReversed: 'journal.reversed',
  CashReceived: 'cash.received',
  CashPaid: 'cash.paid',
  BankTransfer: 'bank.transfer',
  // invoicing / AR (Phase 3)
  InvoiceCreated: 'invoice.created',
  InvoicePosted: 'invoice.posted',
  InvoicePaid: 'invoice.paid',
  InvoiceCancelled: 'invoice.cancelled',
  CreditNoteIssued: 'creditnote.issued',
  PaymentReceived: 'payment.received',
  PaymentAllocated: 'payment.allocated',
  // purchasing / AP
  BillPosted: 'bill.posted',
  BillCancelled: 'bill.cancelled',
  PaymentVoided: 'payment.voided',
  // inventory (Phase 4)
  StockReceived: 'stock.received',
  StockIssued: 'stock.issued',
  StockAdjusted: 'stock.adjusted',
  StockTransferred: 'stock.transferred',
} as const;

/** Payload emitted for a created/updated/deleted tenant entity. */
export interface EntityEventPayload {
  id: string;
  organizationId: string;
  actorId?: string;
}

export interface UserLoggedInPayload {
  userId: string;
  organizationId: string;
  at: string;
}

export interface JournalPostedPayload {
  organizationId: string;
  journalEntryId: string;
  entryNumber: string;
  sourceType?: string;
  sourceId?: string;
}

export interface JournalReversedPayload {
  organizationId: string;
  journalEntryId: string;
  reversalEntryId: string;
}

export interface TreasuryPayload {
  organizationId: string;
  journalEntryId: string;
  amount: string;
}

export interface DocumentEventPayload {
  organizationId: string;
  documentId: string;
  documentNumber: string;
}

export interface PaymentEventPayload {
  organizationId: string;
  paymentId: string;
  amount: string;
}

export interface PaymentAllocatedPayload {
  organizationId: string;
  paymentId: string;
  documentId: string;
  amount: string;
}

export interface StockEventPayload {
  organizationId: string;
  productId: string;
  locationId: string;
  ledgerCode: string;
  quantity: string;
}

/** Maps every event name to its payload type. */
export interface DomainEventMap {
  'partner.created': EntityEventPayload;
  'partner.updated': EntityEventPayload;
  'partner.deleted': EntityEventPayload;
  'product.created': EntityEventPayload;
  'product.updated': EntityEventPayload;
  'product.deleted': EntityEventPayload;
  'user.registered': EntityEventPayload;
  'user.logged_in': UserLoggedInPayload;
  'journal.posted': JournalPostedPayload;
  'journal.reversed': JournalReversedPayload;
  'cash.received': TreasuryPayload;
  'cash.paid': TreasuryPayload;
  'bank.transfer': TreasuryPayload;
  'invoice.created': DocumentEventPayload;
  'invoice.posted': DocumentEventPayload;
  'invoice.paid': DocumentEventPayload;
  'invoice.cancelled': DocumentEventPayload;
  'creditnote.issued': DocumentEventPayload;
  'payment.received': PaymentEventPayload;
  'payment.allocated': PaymentAllocatedPayload;
  'bill.posted': DocumentEventPayload;
  'bill.cancelled': DocumentEventPayload;
  'payment.voided': PaymentEventPayload;
  'stock.received': StockEventPayload;
  'stock.issued': StockEventPayload;
  'stock.adjusted': StockEventPayload;
  'stock.transferred': StockEventPayload;
}

export type DomainEventName = keyof DomainEventMap;
