# POS_TRANSACTION_FLOW

The verified lifecycle of a POS sale, as executed live in the Phase-14 audit org (all steps live-evidenced via GT-01…GT-18).

## 1. Pipeline stages

```
[Terminal] cart (Zustand, localStorage) ── POST /pos/orders/quote (live server quote; INV-1 gate)
      │
      ▼ onCharge → PaymentDialog (tenders; change math) → onSettle
      ▼ one of: POST /pos/checkout │ /pos/tabs/:tableId/settle │ /pos/orders/:id/settle
      │            all three converge on the SAME recoverable pipeline via submitSaleOperation
      │            (write-ahead IndexedDB envelope + Idempotency-Key header)
      ▼
[API IdempotencyInterceptor] IdempotencyRecord: pending-lock → business-outcome run
      │  checkout: recovery lookup (clientOperationKey) → resume if crashed mid-sale
      │  1) requireCashSession (H1: cash/MM must have caller's open drawer)
      │  2) assertCreditCustomer (credit mode) / assertPricingAuthority (discount tier,
      │     manager override verify) / preflightPayment (tender accounts, store-credit balance)
      ▼
[Stage 1 — Order] own $transaction: order number (native seq) + Order.clientOperationKey(=idem key)
      │           + recordBusinessOutcome({orderId}) IN THE SAME TX   ← crash here = W1 resume
      ▼ fireKitchen (best-effort, never fails sale)
[Stage 2 — Invoice] own $transaction: FOR UPDATE CashSession→Order (re-check invoiceId null)
      │  prepareLines (server prices; expectedTotal ±1e-6 re-verified) → INV number allocated IN tx
      │  Invoice + InvoiceItems (+modifiers) → recordBusinessOutcome({invoiceId})
      │  postInvoiceGl: SALES journal, postingKey pos_invoice:{id}:primary
      │      Dr AR(receivableAccount) / Cr Revenue(per item acct) / Cr Output tax
      │      dimensions {source:pos, cashSessionId, cashierId, registerId}
      │  status→posted; enqueue StockPostingJob (at_invoice) ATOMICALLY ← W2
      ▼
[Stage 3 — Payment] own $transaction: FOR UPDATE CashSession→Invoice (residual re-read)
      │  per tender: PaymentService.createReceipt →
      │      Payment (PAY-YYYY seq) + PaymentAllocation(→invoice)
      │      GL: Dr funds acct (drawer forced for cash / configured MM/bank/card) / Cr AR
      │      CashMovement 'sale' (cash only, session-owner enforced)
      │      StoreCredit consumed same-tx (FOR UPDATE, negative rejected)
      │  settle invoice (status paid, settlementStatus settled, paymentMode from ALL allocations,
      │  version++, amountTendered recorded) → Receipt + merchant copy → closeOrderForInvoice
      │  recordBusinessOutcome(complete=true) ← W3: replay returns saved response byte-identically
      ▼
[Stage 4 — Stock] StockPostingWorker (cron 30s, FOR UPDATE SKIP LOCKED claim)
      │  single $transaction per job: re-check done → issue stock per line
      │  (recipe expansion, modifiers, accompaniments; variant quant caveat A-…/F4-8)
      │  InventoryLedger rows (balanceAfter atomic-decrement-derived) + AVCO COGS GL:
      │      Dr COGS / Cr Stock Valuation (journal INV)
      │  per-line failures → InventoryException (never blocks sale); whole-run failure → retry→failed
      ▼
[Stage 5 — post-commit best-effort] loyalty points · PosSaleCompleted event · receipt render/print
```

## 2. Refund / void flow (single $transaction)

```
POST /pos/invoices/:id/refund (pos:refund + MANDATORY manager override+PIN + reason + disposition)
  lock order: CashSession → Invoice → Payments(sorted)
  per-line refundedQty ≤ remaining; duplicate-line guard; amountRefunded ≤ total
  PosRefund row → reversal JE (SALES): Dr Revenue+Tax / Cr AR
  AR credited FIRST; payout only of collected remainder, pro-rata over original tenders:
    cash → drawer (CashMovement 'refund'); electronic → ORIGINAL account (method+account matched)
    Payment.refundedAmount / PaymentAllocation.refundedAmount incremented (DB CHECK bounds)
  restock → original issue location from ledger (rejects ambiguity), blocked while stock job pending
  invoice → refunded/settled on full refund; order closed; audit row in-tx
```
Live: GT-09 (void 11,800 → drawer), GT-10 (MTN restock +1 cake), GT-11 (partial 3,000 → drawer).

## 3. Shift lifecycle

```
open (CashRegister FOR UPDATE, float vs drawer-ledger enforced, funding GL if excess)
  → sales/refunds/movements (each GL'd; expected = float + Σsale + Σpay_in + Σadj − Σrefund − Σpay_out)
  → close (session FOR UPDATE; server-computed expected/counted/difference; blind count;
           reconciliation gate: no unsettled orders/pending payments/posting drift;
           variance GL if ≠; Z snapshot frozen IN TX)
  → Z immutable (replay = read-only; reopen dead — A-010)
```
Live: two closes at variance exactly 0; Z snapshots verified.

## 4. Offline sync flow

```
device (Android/web) queues ops → POST /sync/push (X-Device-Token, per-op actorUserId)
  per-op: IdempotencyService.executeWithKey(opId) under tenant.run(actor)
  clientIds remapped (session open → sale); failed op ⇒ dependents 424; dead-letter never dropped
  re-push of same ops ⇒ replayed (GT-13: exactly 1 sale + 1 payment)
```

## 5. Invariant ledger (all live-verified)

| Invariant | Evidence |
|---|---|
| Client total = quote = persisted = payment-required | expectedTotal ±1e-6 enforced at quote+bill |
| Exactly-once at every layer | GT-14 (replay 0 new), GT-13 (sync replay), DB uniques |
| Dr = Cr | GT-01/02/05/06/07/09/10/11 GL captures; 477-test suite |
| Drawer = Σ movements = expected at close | GT-18 (156,400 exact), Phase-0.5 sessions |
| Stock conservation (policy-permitting negative) | GT-15 (−4 exact under concurrency) |
| Money never unbalanced in GL | ROUNDING account absorbs ≤0.01 epsilon |
