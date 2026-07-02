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
  // M5 — cash sessions
  CashSessionOpened: 'cash.session.opened',
  CashSessionClosed: 'cash.session.closed',
  CashSessionReconciled: 'cash.session.reconciled',
  CashMovementRecorded: 'cash.movement.recorded',
  CashBankingRecorded: 'cash.banking.recorded',
  // D2-2 — period close
  FiscalPeriodClosed: 'fiscal_period.closed',
  FiscalPeriodLocked: 'fiscal_period.locked',
  // Phase C — FX revaluation
  FxRevaluationRan: 'fx_revaluation.ran',
  // Phase D — bank reconciliation
  BankStatementImported: 'bank_statement.imported',
  BankReconciliationRan: 'bank_reconciliation.ran',
  // Phase F.6 — Procurement chain
  PurchaseRequestCreated: 'purchase_request.created',
  PurchaseRequestSubmitted: 'purchase_request.submitted',
  PurchaseRequestApproved: 'purchase_request.approved',
  PurchaseRequestRejected: 'purchase_request.rejected',
  PurchaseRequestConverted: 'purchase_request.converted',
  PurchaseOrderCreated: 'purchase_order.created',
  PurchaseOrderApproved: 'purchase_order.approved',
  PurchaseOrderSent: 'purchase_order.sent',
  PurchaseOrderCancelled: 'purchase_order.cancelled',
  GoodsReceiptPosted: 'goods_receipt.posted',
  GoodsReceiptCancelled: 'goods_receipt.cancelled',
  ThreeWayMatchComputed: 'three_way_match.computed',
  DebitNoteCreated: 'debit_note.created',
  DebitNotePosted: 'debit_note.posted',
  // Phase F.6 — Push notifications
  PushSubscribed: 'push.subscribed',
  // POS vertical (Phase 8) — Phase A additions (sell loop)
  PosSaleCompleted: 'pos.sale.completed',
  PosRefundCompleted: 'pos.refund.completed',
  PosHoldCreated: 'pos.hold.created',
  PosHoldRecalled: 'pos.hold.recalled',
  PosHoldDeleted: 'pos.hold.deleted',
  PosOverrideApproved: 'pos.override.approved',
  PosVoidCompleted: 'pos.void.completed',
  PosReportGenerated: 'pos.report.generated',
  // POS Order → Invoice → Receipt domain (DDD split)
  PosOrderCreated: 'pos.order.created',
  PosOrderUpdated: 'pos.order.updated',
  PosOrderInvoiced: 'pos.order.invoiced',
  PosOrderClosed: 'pos.order.closed',
  PosOrderCancelled: 'pos.order.cancelled',
  PosInvoiceSettled: 'pos.invoice.settled',
  PosInvoiceCredited: 'pos.invoice.credited',
  PosInvoiceWrittenOff: 'pos.invoice.written_off',
  CheckoutCompensationFailed: 'pos.checkout.compensation_failed',
  StoreCreditReversalFailed: 'pos.store_credit.reversal_failed',
  // POS Phase T1 — Tables Management (ADR-012)
  PosTableCreated: 'pos.table.created',
  PosTableUpdated: 'pos.table.updated',
  PosTableDeleted: 'pos.table.deleted',
  PosTableStatusChanged: 'pos.table.status_changed',
  PosTableMerged: 'pos.table.merged',
  PosTableUnmerged: 'pos.table.unmerged',
  PosTableTransferred: 'pos.table.transferred',
  PosTableSplit: 'pos.table.split',
  PosTableCleaned: 'pos.table.cleaned',
  PosTableReservationCreated: 'pos.table.reservation_created',
  PosTableReservationSeated: 'pos.table.reservation_seated',
  PosTableReservationCancelled: 'pos.table.reservation_cancelled',
  PosTableReservationNoShow: 'pos.table.reservation_no_show',
  // Staff / RBAC management
  RoleCreated: 'role.created',
  RoleUpdated: 'role.updated',
  RoleDeleted: 'role.deleted',
  UserCreated: 'user.created',
  UserUpdated: 'user.updated',
  UserDeleted: 'user.deleted',
  UserPasswordReset: 'user.password_reset',
  UserUnlocked: 'user.unlocked',
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
  /** Unit cost at the time of the move (AVCO recompute, FIFO batch cost, or STANDARD). */
  unitCost?: string;
  /** Total monetary value (= unitCost × quantity). */
  totalValue?: string;
  /** New running-average cost after a receipt (AVCO only). */
  newRunningAverage?: string;
  /** Delta between counted and system quantity on adjustment. */
  delta?: string;
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
  'cash.session.opened': { organizationId: string; sessionId: string; cashRegisterId: string };
  'cash.session.closed': { organizationId: string; sessionId: string; expected: string; counted: string; variance: string };
  'cash.session.reconciled': { organizationId: string; sessionId: string; cashRegisterId: string };
  'cash.movement.recorded': { organizationId: string; sessionId: string; movementId: string; movementType: string; amount: string };
  'cash.banking.recorded': { organizationId: string; sessionId: string; amount: string; bankName: string };
  'fiscal_period.closed': { organizationId: string; periodId: string; periodName: string; closingEntryId: string; netIncome: string };
  'fiscal_period.locked': { organizationId: string; periodId: string; periodName: string };
  'fx_revaluation.ran': { organizationId: string; asOf: string; revalued: number; totalGain: string };
  'bank_statement.imported': { organizationId: string; bankAccountId: string; imported: number; skipped: number };
  'bank_reconciliation.ran': { organizationId: string; bankAccountId: string; runId: string; matched: number; unmatched: number };
  'purchase_request.created': { organizationId: string; requestId: string; requestNumber: string };
  'purchase_request.submitted': { organizationId: string; requestId: string };
  'purchase_request.approved': { organizationId: string; requestId: string; approverId: string };
  'purchase_request.rejected': { organizationId: string; requestId: string; reason: string };
  'purchase_request.converted': { organizationId: string; requestId: string; purchaseOrderIds: string[] };
  'purchase_order.created': { organizationId: string; orderId: string; orderNumber: string; partnerId: string };
  'purchase_order.approved': { organizationId: string; orderId: string; approverId: string };
  'purchase_order.sent': { organizationId: string; orderId: string; sentAt: string };
  'purchase_order.cancelled': { organizationId: string; orderId: string; reason: string };
  'goods_receipt.posted': { organizationId: string; receiptId: string; receiptNumber: string; orderId: string };
  'goods_receipt.cancelled': { organizationId: string; receiptId: string; reason: string };
  'three_way_match.computed': { organizationId: string; purchaseOrderId: string; matched: number; mismatched: number; blocked: number };
  'debit_note.created': { organizationId: string; noteId: string; noteNumber: string; direction: 'outbound' | 'inbound' };
  'debit_note.posted': { organizationId: string; noteId: string; direction: 'outbound' | 'inbound'; amount: string };
  'push.subscribed': { organizationId: string; userId: string; subscriptionId: string };
  'pos.sale.completed': { organizationId: string; invoiceId: string; invoiceNumber: string; cashSessionId?: string; total: string };
  'pos.refund.completed': { organizationId: string; invoiceId: string; creditNoteId: string; total: string };
  'pos.hold.created': { organizationId: string; holdId: string; name: string; total: string; heldById: string };
  'pos.hold.recalled': { organizationId: string; holdId: string; recalledById: string };
  'pos.hold.deleted': { organizationId: string; holdId: string };
  'pos.override.approved': { organizationId: string; approverId: string; overrideKind: 'discount' | 'void' | 'manual_refund'; referenceId?: string; amount?: string };
  'pos.void.completed': { organizationId: string; invoiceId?: string; documentLineId?: string; voidedById: string; reason?: string };
  'pos.report.generated': { organizationId: string; reportKind: 'x' | 'z' | 'hourly' | 'top_items' | 'variance'; cashSessionId?: string; asOf: string };
  'pos.order.created': { organizationId: string; orderId: string; orderNumber: string; tableId?: string };
  'pos.order.updated': { organizationId: string; orderId: string; version: number };
  'pos.order.invoiced': { organizationId: string; orderId: string; invoiceId: string; invoiceNumber: string };
  'pos.order.closed': { organizationId: string; orderId: string; invoiceId?: string };
  'pos.order.cancelled': { organizationId: string; orderId: string; reason?: string };
  'pos.invoice.settled': { organizationId: string; invoiceId: string; invoiceNumber: string; paymentMode: string };
  'pos.invoice.credited': { organizationId: string; invoiceId: string; invoiceNumber: string; partnerId: string; amount: string };
  'pos.invoice.written_off': { organizationId: string; invoiceId: string; invoiceNumber: string; amount: string };
  'pos.checkout.compensation_failed': { organizationId: string; invoiceId: string; paymentIds: string[] };
  'pos.store_credit.reversal_failed': { organizationId: string; invoiceId: string; amount: number };
  'pos.table.created': { organizationId: string; tableId: string; number: number; name: string };
  'pos.table.updated': { organizationId: string; tableId: string; changes: Record<string, unknown> };
  'pos.table.deleted': { organizationId: string; tableId: string };
  'pos.table.status_changed': { organizationId: string; tableId: string; from: string; to: string; reason?: string };
  'pos.table.merged': { organizationId: string; sourceId: string; targetId: string; orderIds: string[]; actorId: string };
  'pos.table.unmerged': { organizationId: string; tableId: string; actorId: string };
  'pos.table.transferred': { organizationId: string; sourceId: string; targetId: string; orderIds: string[]; actorId: string };
  'pos.table.split': { organizationId: string; sourceOrderId: string; newOrderIds: string[]; actorId: string };
  'pos.table.cleaned': { organizationId: string; tableId: string; actorId: string };
  'pos.table.reservation_created': { organizationId: string; reservationId: string; tableId: string; startAt: string; endAt: string };
  'pos.table.reservation_seated': { organizationId: string; reservationId: string; tableId: string; orderId?: string };
  'pos.table.reservation_cancelled': { organizationId: string; reservationId: string; tableId: string };
  'pos.table.reservation_no_show': { organizationId: string; reservationId: string; tableId: string };
  'role.created': EntityEventPayload;
  'role.updated': EntityEventPayload;
  'role.deleted': EntityEventPayload;
  'user.created': EntityEventPayload;
  'user.updated': EntityEventPayload;
  'user.deleted': EntityEventPayload;
  'user.password_reset': EntityEventPayload;
  'user.unlocked': EntityEventPayload;
}

export type DomainEventName = keyof DomainEventMap;