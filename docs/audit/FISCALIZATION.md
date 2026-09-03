# Fiscalization (F22)

**Setting `FISCAL_PROVIDER` is not a compliance solution.** It selects a seam. Until a real adapter is wired, the system records that an invoice was *expected* to be fiscally signed but was not, and marks it `fiscalStatus: 'pending'`.

## What exists

- `Invoice.fiscalStatus` — `null` (no provider), `'pending'` (provider set, not signed), or `'signed'` (a device returned a code).
- `Invoice.fiscalCode`, `Invoice.fiscalQr`, `Invoice.fiscalizedAt` — hold a real device's response for printing on the receipt.
- `PosInvoiceService.fiscalizeInvoice(invoice)` — called best-effort after an invoice is generated. With `FISCAL_PROVIDER=none` it does nothing. With any other value and no adapter, it sets `fiscalStatus: 'pending'` and warns.

## Finding unsigned invoices

```sql
SELECT "invoiceNumber", "issueDate"
FROM "Invoice"
WHERE "fiscalStatus" = 'pending'
ORDER BY "issueDate";
```

## Wiring a real provider

1. Implement an adapter that signs an invoice and returns `{ fiscalCode, fiscalQr }` (plus any provider reference).
2. In `fiscalizeInvoice`, call it and persist the result with `fiscalStatus: 'signed'`, `fiscalizedAt: new Date()`.
3. Add the code/QR to the receipt template.
4. Handle provider downtime deliberately: queue and retry rather than dropping the sale; a sale must not be blocked, but an unsigned invoice must remain visible as `pending`.

## Uganda / EFRIS

The Uganda Revenue Authority requires EFRIS for VAT-registered taxpayers. This repository does **not** implement EFRIS. For a Ugandan VAT-registered business, either integrate a verified EFRIS solution or use a documented compliant external invoicing workflow, and confirm the specific business's obligations with its accountant. The `FISCAL_PROVIDER=efris` value is a placeholder name, not an implementation.
