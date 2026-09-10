# INVENTORY MANAGEMENT + POS INTEGRATION — PRODUCTION READINESS AUDIT

**Date:** 2026-09-09
**Commit audited:** `e4d7d7b` (branch `main`, clean tree)
**Verification environment:** PostgreSQL 16 (`cert-db`, port 5435), 51/51 migrations applied, schema at head
**Audit suite:** `apps/api/test/integration/audit/` — 27 assertions across 7 spec files, new files only, zero production-code changes

```
Static Assessment:        Moderate
Live Verification:        PERFORMED (27 adversarial assertions against real Postgres)
Production Certification: FAILED
```

---

## 1. Executive Verdict

**Overall inventory readiness: 41%.** Not deployable.

The inventory *engine* is genuinely good — better than the modules around it. Its concurrency control, AVCO valuation, ledger↔quant tie, and classification integrity all survived adversarial testing. What fails is the **wiring between inventory and everything else**: the POS pipeline that consumes it, the purchasing pipeline that feeds it, and the period lock that is supposed to freeze it.

The single most important result:

> **A POS sale posts full revenue and AR to the general ledger, and never relieves stock or posts COGS. The failure is silent — no InventoryException, no alert, no ledger row.** Live-verified end to end through the real service path.

| Severity | Count | IDs |
|---|---|---|
| **P0** | 4 | F-01, F-02, F-03, F-04 |
| **P1** | 4 | F-05, F-06, F-07, F-08 |
| **P2** | 5 | F-09, F-10, F-11, F-12, F-13 |
| **P3** | 2 | F-14, F-15 |

Suite outcome: **9 passed / 18 failed** of 27. Each failure is a finding; each pass is a control proven to work.

### What is actually strong (proven, not assumed)

- **Concurrency (INV-024/025) — PASS.** 20 concurrent sales against 10 units: exactly 10 fulfilled, 10 rejected, on-hand 0, ledger 0, 10 ledger rows. 10 concurrent receipts: quantity 100, average cost 10.000000, nothing lost. `SELECT … FOR UPDATE` + advisory locks do their job.
- **Quantity conservation (INV-INVARIANT-26) — PASS.** A 7-step mixed workload reconciles by *business classification*, not merely by signed sum.
- **Valuation conservation (INV-INVARIANT-27) — PASS.** Subledger 788.400000 == Stock Valuation GL 788.400000, to the cent, with COGS and the adjustment leg both tying out.
- **Multi-tenant isolation (INV-INVARIANT-18) — PASS.** Six adversarial cross-org probes, including an explicit foreign `organizationId` in the filter, all returned 0. Org B cannot issue org A stock.
- **Never-block-sales** behaves exactly as the owner rule specifies: 12 sales against 5 units all succeed, on-hand −7, ledger −7, running-balance chain unbroken.

### What this means in one line

The engine can be trusted with quantities. The system around it cannot yet be trusted to tell the engine the truth, or to hear it when it answers.

---

## 2. Architecture Map

```
                    ┌──────────────────────────────────────────┐
                    │            MASTER DATA                    │
                    │  Product ─ ProductVariant ─ UoM ─ Packaging│
                    │  MenuItem ─ MenuProduct (recipe, unversioned)
                    └────────────────────┬─────────────────────┘
                                         │
   ┌─────────────────────────────────────┼─────────────────────────────────┐
   │ INBOUND                             │                        OUTBOUND │
   │                                     │                                 │
   │  PurchaseOrder                      │              Order (no stock)    │
   │      ├─ po.receive ──┐              │                  │               │
   │      │               │              │              KOT fire (no stock) │
   │  GoodsReceiptNote ───┤              │                  │               │
   │      │  (createAdhoc)│              │            generateInvoice        │
   │      │               ▼              │             ├─ Sales GL  SYNC     │
   │  VendorBill ──► receiveFromBill ◄── F-01 ──┐      └─ StockPostingJob    │
   │      │            (unconditional)          │            │  (enqueued)   │
   │      ▼                                     │            ▼               │
   │   AP / GRNI                                │      worker (@Cron 30s)    │
   └────────────────────────────────────────────┼────── FOR UPDATE SKIP LOCKED
                                                │            │
                    ┌───────────────────────────┴────────────▼─────────────┐
                    │             StockService (the engine)                 │
                    │  receive · issue · adjust · transfer · receiveReturn   │
                    │  advisory lock (AVCO) · FOR UPDATE (issue)            │
                    │  conditional updateMany (adjust/transfer/batch)        │
                    └───────────────┬──────────────────────┬───────────────┘
                                    │                      │
                        StockItem.quantity          InventoryLedger
                        (authoritative quant)       (movement history,
                        AVCO runningAverageCost      NO unique key)
                                    │                      │
                                    └──────────┬───────────┘
                                               ▼
                                    StockPostingService
                                    postIssue / postReceipt /
                                    postAdjustment / postTransfer /
                                    postReturnRestock
                                               │
                                    ┌──────────▼──────────┐
                                    │  PostingService.post │
                                    │  journalCode 'INV'   │
                                    │  postingKey: NULL ◄── F-03
                                    │  assertOpen(date) ◄── F-04 (only here)
                                    └──────────┬──────────┘
                                               ▼
                                     JournalEntry / JournalLine
```

**Doc wrappers** (`StockDocService`): StockOut · WasteRecord · StockAdjustment · StockTransfer → create/approve → post through the engine.
**Counts** (`InventoryCountService`): start (snapshot) → saveDraft → submit → creates + approves a StockAdjustment. Never overwrites.

---

## 3. Inventory Source of Truth

```
Quantity source:   StockItem.quantity          Decimal(20,6)
                   @@unique([organizationId, productId, variantKey, locationId])
                   `variantKey` is a "" sentinel mirroring nullable variantId.

Movement source:   InventoryLedger             Decimal(20,6) throughout
                   @@index([organizationId, ledgerCode])  ← index, NOT unique
                   No idempotency key of any kind. One ledgerCode is
                   deliberately shared by N rows on batch/serial/transfer paths.

Valuation source:  AVCO   → StockItem.runningAverageCost
                   FIFO   → InventoryBatch layers (expiry, then receivedAt)
                   STANDARD / SPECIFIC also supported (CostingMethod enum)

Recipe source:     MenuProduct (LIVE, unversioned, no effective dates)
                   → snapshotted per sale into InvoiceItemRecipeIngredient
                     (onDelete: Restrict — hardened in d22e48a)

COGS source:       InventoryLedger.totalValue on negative-quantity rows
                   whose referenceType ∈ {pos_invoice, pos_invoice_extra, menu_recipe}

GL source:         JournalEntry / JournalLine, journalCode 'INV'
                   dedupe by @@unique([organizationId, postingKey])
                   — which inventory never populates (F-03)
```

**Divergence risk between quantity and movement source: LOW.** Both are written inside the same transaction on every path, and the tie was proven live across a 7-step mixed workload and under 20-way concurrency.

---

## 4. End-to-End POS → Inventory → COGS → GL Flow (as discovered)

```
createOrder ─────────────────────────────► no stock effect  (pos-orders.service.ts:203)
fireKitchen (KOT) ───────────────────────► no stock effect  (pos-orders.service.ts:669)
generateInvoice                                              (pos-invoice.service.ts:179)
   ├─ Invoice + InvoiceItem rows                                            :291 / :331
   ├─ postInvoiceGl  Dr AR / Cr Revenue + Tax    SYNCHRONOUS                :377 / :801
   │     postingKey = pos_invoice:<id>:primary                              :826
   └─ enqueueStockPosting  StockPostingJob       ATOMIC with the invoice    :390
         idempotencyKey = <trigger>:<invoiceId>, unique per org
                    │
                    ▼  ≤30s, @Cron, FOR UPDATE SKIP LOCKED
   processStockPostingJob                                                   :935
      one transaction, FOR UPDATE on the job row, 30s timeout               :949
      items := OrderItem[] where orderId = job.orderId  ◄── note: OrderItem  :954
         └─ issueStockForItems                                             :1028
              ├─ direct product → stock.issue → snapshot create             :1039
              │     invoiceItemId: it.id   ← an OrderItem id ✗ F-01
              ├─ menu item → issueMenuItemRecipe(…, it.id)                  :1047
              │     invoiceItemId: it.id   ← an OrderItem id ✗ F-01
              └─ modifiers / accompaniments → issueLineExtras                :714
receivePayment ──────────────────────────► no stock effect                  :457
```

The design is sound: financial posting synchronous, inventory posting durable-async with a claim token, retry, backoff, dead-letter and a period-close drain. **This audit does not recommend making stock posting synchronous** — for an offline-capable café POS the async job is the correct shape. The defect is in one field assignment inside it.

---

## 5. Findings

---

### F-01 — POS sales never relieve stock and never post COGS

```
ID:          F-01
Title:       Recipe snapshot writes an OrderItem id into an InvoiceItem foreign
             key, aborting the stock-posting transaction on every valued sale
Severity:    P0  (Tier A — release blocker)
Status:      CONFIRMED — LIVE VERIFIED, end to end through the real service path
Source:      apps/api/test/integration/audit/inv-audit-pos-lifecycle.spec.ts
Exact file:  apps/api/src/modules/pos/billing/pos-invoice.service.ts
Exact fn:    issueStockForItems (:1028) and issueMenuItemRecipe (:1192)
```

**Evidence.** `processStockPostingJob` loads `OrderItem` rows (`:954`). Both snapshot writes then pass `it.id` — an **OrderItem** id — as `invoiceItemId`, a column whose foreign key targets **InvoiceItem**:

- direct product: `invoiceItemId: it.id` (`:1039`)
- recipe: `issueMenuItemRecipe(…, it.id)` → `invoiceItemId` (`:1255`)

`InvoiceItem.id` is an independent `uuid()` created in `generateInvoice` (`:331`) and is never equal to an `OrderItem.id`.

A real sale — `createOrder` → `generateInvoice` → worker:

```json
{ "soldQty": 4, "unitCost": 10,
  "onHandBefore": 100, "onHandAfter": 100,   ← no relief
  "expectedCogs": 40,  "actualCogs": 0,      ← no COGS
  "snapshotRows": 0,
  "inventoryExceptions": [],                 ← SILENT
  "revenueGl": -400, "arGl": 400, "stockValuationGl": 1000,
  "jobs": [{ "status": "pending", "attempts": 1,
             "lastError": "current transaction is aborted, commands ignored until end of transaction block" }] }
```

Recipe path, 10 burgers (1 bun + 2 patties each):

```json
{ "expected": { "bunOnHand": 190, "pattyOnHand": 180, "cogsDelta": 320 },
  "actual":   { "bunOnHand": 200, "pattyOnHand": 200, "cogsDelta": 0   },
  "snapshots": [] }
```

Underlying error, verbatim:

```
Invalid `tx.invoiceItemRecipeIngredient.create()` invocation in
  .../pos-invoice.service.ts:1255:48
Foreign key constraint violated on the constraint:
  `InvoiceItemRecipeIngredient_invoiceItemId_fkey`
```

**Why it is silent.** The per-line `catch` calls `recordInventoryException`, which issues another statement on the **already-aborted** transaction and fails with `25P02`. So the compensating control that exists specifically to surface un-deducted lines is destroyed by the same failure it is meant to report. The job returns to `pending`, retries to `maxAttempts` (5), then `failed` — with no InventoryException and no `alertStockPostingFailure`.

**Impact.** Revenue and AR post in full; cost of sale is zero. Gross margin overstated by 100% of COGS. Inventory overstated on the balance sheet and never depleted, so reorder points, ATP, expiry and stocktake variance all run on fiction. Every café shift compounds it.

**Introduced by.** The recipe-snapshot work — migration `20260908000000_recipe_snapshot`, commits `a9a91ab` / `d22e48a`. The `onDelete: Restrict` hardening in `d22e48a` is on this same FK.

**Reproduction.** `pnpm --filter @erp/api test:integration -- test/integration/audit/inv-audit-pos-lifecycle.spec.ts`

**Recommended fix.** Resolve the `InvoiceItem` for the order line before writing the snapshot (map `OrderItem → InvoiceItem` by `lineNumber` or `invoiceId + lineNumber`), or load `InvoiceItem` rows in `processStockPostingJob` instead of `OrderItem` rows. Separately — and independently of this bug — make `recordInventoryException` write on its **own** connection so a poisoned transaction can never swallow the alert.

---

### F-02 — Posting a vendor bill receives the goods a second time

```
ID:          F-02
Title:       Vendor-bill posting auto-receives every stockable line with no link
             to the goods receipt that already received it
Severity:    P0  (Tier A)
Status:      CONFIRMED — LIVE VERIFIED, both receiving paths
Source:      apps/api/test/integration/audit/inv-audit-purchasing.spec.ts
Exact file:  apps/api/src/modules/invoicing/workflows/invoicing-workflows.initializer.ts:213-241
Exact fn:    vendorBillWorkflow → 'post' transition sideEffect
```

**Evidence — case A, PO-driven receipt then the supplier's invoice:**

```json
{ "onHandAfterPoReceipt": 100, "onHandAfterBillPost": 200,
  "stockValuationAfterReceipt": 1000, "stockValuationAfterBill": 2000,
  "apAfterReceipt": -1000, "apAfterBill": -2000,
  "ledgerRows": 2 }
```

Stock doubled, inventory value doubled, **and the supplier is recorded as owed twice**.

**Evidence — case B, the *intended* ad-hoc GRN → bill pairing:**

```json
{ "onHandAfterGrn": 50, "onHandAfterBillPost": 100,
  "grniAfterGrn": -200, "grniAfterBill": -200,
  "ledgerRows": [
    { "type": "receipt", "quantityChange": "50", "referenceType": "goods_receipt" },
    { "type": "receipt", "quantityChange": "50", "referenceType": "vendor_bill"   } ] }
```

Worse than hypothesised: stock still doubles, **and GRNI never clears**. The bill's GRNI debit is cancelled by a *new* GRNI credit raised by its own `receiveFromBill`, so the original accrual stays open forever. The AP accrual can therefore never be reconciled.

The loop has no `GoodsReceiptNote` link, no `receivedQuantity` check and no "goods already received" flag (`:213-214`). It also picks the warehouse as *first active warehouse ordered by createdAt* (`:215-219`), ignoring the GRN's own `warehouseId`.

**Impact.** Any café that both receives goods and enters supplier invoices — i.e. any café doing normal AP — doubles its inventory quantity and value, doubles its payables, and permanently breaks GRNI reconciliation.

**Recommended fix.** Receive from a bill **only** when no goods receipt covers the line. The `ThreeWayMatch` model (`schema.prisma:4849`) already exists and is unused on this path; wire the bill to the GRN and make `receiveFromBill` a fallback for bill-only purchases, not the default.

---

### F-03 — Every inventory journal entry bypasses the GL replay guard

```
ID:          F-03
Title:       Inventory / COGS / receipt / restock journal entries carry no
             postingKey, so PostingService's idempotency check never engages
Severity:    P0  (Tier A)
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-crash-boundaries.spec.ts
Exact file:  apps/api/src/modules/inventory/posting/stock-posting.service.ts:128-138, :167-177
```

**Evidence.** Two `postIssue` calls with an identical `sourceType`/`sourceId`:

```json
{ "postIssueCalls": 2, "journalEntriesCreated": 2,
  "postingKeys": [null, null], "cogsBalance": 100 }
```

Two journal entries, both `postingKey: null`, COGS double-counted (100 where 50 was correct).

`PostingService.doPost` replays an existing entry **only** `if (request.postingKey)` (`posting.service.ts:76-86`), and the `@@unique([organizationId, postingKey])` backstop cannot fire on NULLs. Sales and refunds use keys (`pos_invoice:<id>:primary`, `pos_refund:<id>`); the entire `INV` journal does not.

**Impact.** The durable, database-level defence against duplicate GL postings — the one the accounting audit established as the system's idempotency spine — is absent for every inventory movement. Today the job-level `FOR UPDATE` masks it. Any future retry path, manual replay, or backfill script duplicates COGS with nothing to stop it.

**Recommended fix.** Pass a deterministic `postingKey` on every stock posting, e.g. `inv_issue:<ledgerCode>`, `inv_receipt:<ledgerCode>`, `inv_adjust:<ledgerCode>`. `ledgerCode` is already generated in-transaction and is the natural key.

---

### F-04 — The books lock does not protect inventory

```
ID:          F-04
Title:       Period lock is enforced only inside PostingService.post, so any
             zero-value or GL-less movement mutates a closed period
Severity:    P0  (Tier A)
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-period-lock.spec.ts
Exact file:  apps/api/src/modules/accounting/posting/fiscal-period.service.ts:22
             (sole callers: posting.service.ts:92, :209, :340, :433)
```

**Evidence.** With `booksLockDate` set to tomorrow:

| Movement | Blocked? | Result |
|---|---|---|
| Valued issue (cost 10) | **yes** | rejected `Books are locked through …`, on-hand unchanged — *the control works* |
| Zero-cost issue of 30 | **no** | on-hand 100 → 70, ledger row written, 0 journal entries |
| `StockService.receive` (no GL context) | **no** | 40 units @ 3 admitted, 120 of value entered the subledger |

```json
{ "issueRejected": false, "onHandBefore": 100, "onHandAfter": 70,
  "ledgerRowsBefore": 1, "ledgerRowsAfter": 2,
  "journalEntriesBefore": 1, "journalEntriesAfter": 1 }
```

Two escape hatches: `stock-posting.service.ts:118` returns before posting when `totalValue <= 0`, and `stock.service.ts:434` skips GL entirely when there is no `glCtx`. Both still write the ledger and mutate the quant.

**Impact.** A closed period's physical stock is not frozen. Last year's stocktake stops being reproducible, and the closing inventory quantity a signed-off balance sheet was built on can be changed afterwards with no journal and no trace in the GL.

**Recommended fix.** Move the guard into `StockService` so it runs on every movement regardless of GL value — assert the period at the top of `receiveCore`, `issue`, `adjust` and `transfer`.

---

### F-05 — A partially failed stock-posting job is marked `done` and never retried

```
ID:          F-05
Title:       Line-level failures leave the job `done` with a text note; the
             backlog monitor sees a healthy queue
Severity:    P1  (Tier A)
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-crash-boundaries.spec.ts
Exact file:  apps/api/src/modules/pos/billing/pos-invoice.service.ts:1073-1096
```

**Evidence.** A job whose only line failed, then the cause was fixed and the worker re-run:

```json
{ "statusAfterFirstPass": "done",
  "statusAfterCauseFixedAndRerun": "done",
  "ingredientOnHand": 50,
  "expectedIngredientOnHandIfRecovered": 44 }
```

The job is `done` after failing. Fixing the underlying cause (adding the missing recipe) and re-running changes nothing — the top-level `if (job.status === 'done') return` (`:937`) makes the failure permanent. `StockPostingService.counts()` reports `pending + processing + failed`; a `done`-with-`lastError` job is invisible to it and to the period-close drain (`period-close.service.ts:67`).

**Impact.** Un-relieved stock and unposted COGS become permanent and unmonitored. A period can be closed over them.

**Recommended fix.** Set `status: 'failed'` (or a new `partial`) when `failures > 0`, count it in `counts()`, and make retry re-attempt only the lines that have no ledger row.

---

### F-06 — POS sells from one org-wide location; the register's own location is ignored

```
ID:          F-06
Title:       resolvePosStockLocation ignores CashRegister.locationId and falls
             back to an arbitrary warehouse with no deterministic ordering
Severity:    P1  (Tier A — elevated: this is quantity corruption, not config)
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-tenancy-location.spec.ts
Exact file:  apps/api/src/modules/inventory/pos-stock-location.ts:15-37
```

**Evidence.** A till created with `locationId` = Branch 2 store:

```json
{ "registerLocationId": "58846d18-…",     ← Branch 2
  "resolvedLocationId": "5728dc00-…",     ← MAIN
  "orgMainLocationId":  "5728dc00-…",
  "resolverSignatureTakesRegister": false }
```

```json
{ "settingConfigured": false,
  "activeWarehouses": ["ALT", "BRANCH-2", "MAIN"],
  "resolved": "MAIN" }
```

`CashRegister.locationId` exists in the schema (`schema.prisma:3160`) and is never consulted by the sale path. With the setting unset, the resolver returns `findFirst` with **no `orderBy`** — the choice is whatever Postgres returns.

**Impact.** In a multi-branch café every till relieves one store. Branch 2's stock never depletes; MAIN goes negative. Location-level valuation, transfers and stocktakes are all wrong, and no error is raised.

**Recommended fix.** Resolve in order: cash-register location → branch location → org setting → explicit failure. Never guess when more than one candidate exists.

---

### F-07 — Stock adjustments write ledger rows with no machine-readable source

```
ID:          F-07
Title:       InventoryLedger rows from adjust() carry referenceType = NULL and
             referenceId = NULL
Severity:    P1
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-conservation.spec.ts
Exact file:  apps/api/src/modules/inventory/stock.service.ts:1019-1036
```

**Evidence.** Across the mixed workload, exactly one ledger row was orphaned:

```
adjustment_out (ledger b88d4a57-…) has referenceType=null referenceId=null
```

`AdjustStockDto` has no `sourceType`/`sourceId` fields at all, so even `StockDocService.approveAdjustment` (`stock-doc.service.ts:325-342`) cannot stamp the adjustment document — it passes the code as free-text `notes` only. Because inventory **count** sessions submit through the same path, every stocktake variance is affected too.

**Impact.** Breaks INV-INVARIANT-03 and weakens 22/23. You cannot programmatically answer "which document caused this movement" for exactly the class of movement most exposed to fraud. The GL side *is* traceable (`sourceId: ledgerCode`), so this is a subledger traceability gap rather than a loss of money.

**Recommended fix.** Add `sourceType`/`sourceId` to `AdjustStockDto` and pass `stock_adjustment` + the document id from the doc wrapper and the count session.

---

### F-08 — A bill priced in the purchase unit lands as base units

```
ID:          F-08
Title:       Vendor-bill auto-receive passes no uomId, so purchase-unit
             quantities are recorded as base units
Severity:    P1
Status:      CONFIRMED — LIVE VERIFIED
Source:      apps/api/test/integration/audit/inv-audit-purchasing.spec.ts
Exact file:  apps/api/src/modules/invoicing/workflows/invoicing-workflows.initializer.ts:226-236
```

**Evidence.** A product whose purchase unit is a case of 24, billed as 10 cases at 240:

```json
{ "billedQuantity": 10, "purchaseUomFactor": 24,
  "expectedBaseUnits": 240, "expectedUnitCost": 10,
  "actualOnHand": 10, "actualRunningAverageCost": 240 }
```

Quantity understated **24×**; unit cost overstated **24×**.

**Why it hides.** Total value (2,400) is correct, so the GL balances and every value-based reconciliation passes. Only the quantity and the per-unit cost are wrong — which then flows into COGS per unit on every subsequent sale. `StockService.receiveCore` handles UoM correctly (`:308-311`); the bill path simply never supplies `uomId`, unlike `goods-receipts.service.ts:131` and `purchase-orders.service.ts:497`.

---

### F-09 — `InventoryPostingRule` is outside the tenancy extension

```
ID:          F-09
Severity:    P2
Status:      NOT VERIFIED as exploitable — CONFIRMED as an architectural gap
```

Adversarial test result: an org-A rule pinning `STOCK_OUT` to org-A accounts did **not** leak into org B's postings.

```json
{ "orgARulesCreated": 2, "orgBJournalLines": 4,
  "orgBLinesReferencingOrgAAccounts": 0 }
{ "InventoryPostingRule in ORG_SCOPED": false }
```

The model that decides the GL account for **every stock movement** is absent from `ORG_SCOPED` (`tenancy.extension.ts:41-73`), and the RLS policies are `USING`-only with `app.org_id` set only inside transactions (`20260731093000_…/migration.sql:14-22`, `prisma.service.ts:68-135`). Isolation therefore rests entirely on the `where: { organizationId }` that each of the eight call sites happens to write by hand. Today all eight are correct. Neither of the other two layers would catch the ninth.

Same gap applies to `PurchasePayment` and 31 other `organizationId`-bearing models.

---

### F-10 — No cancellation or reversal for any stock document

```
ID:          F-10   Severity: P2   Status: STATIC VERIFIED
Files:       stock-doc.service.ts:455-468, inventory.controller.ts:291-311
```

`StockDocService` exposes only create / approve / list. There is no cancel, reject or reverse endpoint for transfers, waste, stock-outs or adjustments. A mis-keyed transfer can only be corrected by posting an opposite document by hand, with no link between the two. Approve endpoints also carry no `@Idempotent` (only the *create* endpoints do), and `assertPostable` reads `postedAt` outside the transaction (`:400` vs the guard at `:448`) — only `approveAdjustment` re-checks in-transaction.

---

### F-11 — `POST /purchase-orders/:id/receive` is not idempotent

```
ID:          F-11   Severity: P2   Status: STATIC VERIFIED
File:        purchase-orders.controller.ts:65-70
```

No `@Idempotent` decorator, unlike the GRN post route (`goods-receipts.controller.ts:70-76`). A client retry after a timeout re-receives. The over-receipt ceiling (`purchase-orders.service.ts:296-306`) caps the damage at the ordered quantity, so a partial receipt can be doubled up to that ceiling but not beyond — which is why this is P2 rather than P1.

---

### F-12 — Value-banded approvals on waste and stock-out are inert

```
ID:          F-12   Severity: P2   Status: STATIC VERIFIED
File:        stock-doc.service.ts:114, :162, :211, :247
```

The approval gate passes `amount: Number(doc.totalValue ?? 0)`, but `totalValue` is only computed **during posting** (`:162`, `:247`) — at gate time it is always `0`. Every amount band in the seeded `stock_out` and `waste` workflows (`default-approval-workflows.ts:98-112`) therefore evaluates against zero and never fires. Inventory count submission is worse: its snapshot carries only `{ countId }` (`inventory-count.service.ts:340-342`), so `amountOf` resolves to 0 and there is no seeded workflow for `inventory_count_submit` at all. There is also **no count freeze** — nothing blocks sales at a location during a draft count; the staleness guard detects drift after the fact and is bypassable with `force=true`.

---

### F-13 — Reconciliation compares two different date bases

```
ID:          F-13   Severity: P2   Status: STATIC VERIFIED
File:        pos-gl-reconciliation.service.ts:72 vs :107
```

The COGS side buckets by `InventoryLedger.createdAt`; the revenue side by `Invoice.issueDate`. An offline sale replayed with a back-dated `occurredAt` (`pos-invoice.service.ts:303`) books revenue in one period and COGS in another, and the reconciliation reports a variance that is not one.

---

### F-14 — Modifiers can only add consumption, never remove it

```
ID:          F-14   Severity: P3   Status: STATIC VERIFIED
File:        pos-invoice.service.ts:714-796
```

`issueLineExtras` walks `Modifier.inventoryItemId` and `AccompanimentOption.inventoryItemId` and always **issues**. There is no negative-consumption path, so "no cheese" on a burger whose recipe includes cheese still consumes the cheese. Systematic over-consumption of removed ingredients; magnitude depends on how often customers remove items.

---

### F-15 — Recipes are unversioned

```
ID:          F-15   Severity: P3   Status: STATIC VERIFIED
File:        schema.prisma:2475 (MenuProduct), pos-invoice.service.ts:1210
```

`MenuProduct` has no version or effective-date column. `InvoiceItemRecipeIngredient` correctly snapshots what was consumed **after** the fact, so historical COGS is protected once written — but the recipe is read live at worker time, so a recipe edited between invoice and drain changes what is deducted for an already-billed sale. The window is ≤30s in normal operation, and unbounded whenever the queue is backed up.

---

## 6. Golden Transaction Matrix

| ID | Case | Result | Evidence |
|---|---|---|---|
| INV-001 | Purchase receipt | **PASS** | `procurement-flow.spec.ts` — Dr Inventory + Input Tax / Cr AP, GRNI nets to 0 |
| INV-002 | Partial purchase receipt | **PASS** | `partially_received` → `received` |
| INV-003 | Duplicate receipt (over-receipt) | **PASS** | blocked, no stock or GL residue |
| INV-004 | POS sale (direct product) | **FAIL** | F-01 — on-hand 100→100, COGS 0 |
| INV-005 | POS sale with recipe | **FAIL** | F-01 — bun 200→200, patty 200→200, COGS 0 |
| INV-006 | POS sale with modifier | **NOT VERIFIED** | blocked by F-01 |
| INV-007 | Quantity increase | **NOT VERIFIED** | blocked by F-01 |
| INV-008 | Quantity decrease | **NOT VERIFIED** | blocked by F-01 |
| INV-009 | Item cancellation | **PARTIAL** | no stock effect pre-invoice (correct by design) |
| INV-010 | Order void | **PARTIAL** | as INV-009 |
| INV-011 | Refund with restock | **NOT VERIFIED** | blocked by F-01 (nothing was ever issued to return) |
| INV-012 | Refund without restock | **STATIC** | no stock movement; correct |
| INV-013 | Waste | **STATIC** | posts `waste`/`expiry_write_off`; approval band inert (F-12) |
| INV-014 | Damage | **STATIC** | as INV-013 |
| INV-015 | Manual adjustment in | **PASS** | classified `adjustment_in` |
| INV-016 | Manual adjustment out | **PASS*** | correct quantity/value; source reference NULL (F-07) |
| INV-017 | Stock count variance | **PASS** | `inventory-engine.spec.ts` — posts adjustment, never overwrites |
| INV-018 | Transfer | **PASS** | A−10 / B+10 atomic, two ledger rows, cost basis carried |
| INV-019 | Partial transfer | **N/A** | not modelled (`qtyTransferred := qtyRequested`) |
| INV-020 | Transfer retry | **PARTIAL** | no in-transit ⇒ no duplicate receive; but approve is not idempotent (F-10) |
| INV-021 | Opening stock | **STATIC** | `opening_balance` move type exists |
| INV-022 | Recipe change | **PARTIAL** | snapshot protects history; live read at drain time (F-15) |
| INV-023 | Unit conversion | **PASS / FAIL** | receive+issue correct; vendor-bill path 24× wrong (F-08) |
| INV-024 | Concurrent sale | **PASS** | 20 attempts / 10 units → 10 ok, 10 rejected, on-hand 0 |
| INV-025 | Concurrent receipt | **PASS** | 10 × (10 @ 10) → qty 100, avg 10.000000 |
| INV-026 | Offline sale | **STATIC** | server re-derives; device movements are local-only |
| INV-027 | Offline replay | **PARTIAL** | `opId` idempotency at sync layer; refund replay dead-letters (see §14) |
| INV-028 | Duplicate POS event | **NOT VERIFIED** | blocked by F-01 |
| INV-029 | Worker retry | **FAIL** | F-05 — `done` jobs never retried |
| INV-030 | Worker permanent failure | **PARTIAL** | `failed` + InventoryException exists, but F-01 destroys the exception |
| INV-031 | Inventory GL posting | **PASS** | valuation ties to GL exactly |
| INV-032 | COGS posting | **FAIL** | F-01 (never posts) + F-03 (duplicable) |
| INV-033 | Inventory reversal | **PARTIAL** | `receiveReturn` correct; no doc-level reversal (F-10) |
| INV-034 | Multi-location isolation | **FAIL** | F-06 |
| INV-035 | Multi-tenant isolation | **PASS** | 6 adversarial probes, all 0 |
| INV-036 | Historical cost preservation | **PASS** | snapshot at historical unit cost |
| INV-037 | Backdated transaction | **PARTIAL** | receipts guarded; adjust/transfer hardcode `new Date()` |
| INV-038 | Period-closed inventory txn | **FAIL** | F-04 |
| INV-039 | Adjustment authorization | **PARTIAL** | engine + permissions exist; bands inert (F-12) |
| INV-040 | Inventory-to-GL reconciliation | **PASS*** | ties exactly — but only because COGS is 0 on both sides (F-01) |

---

## 7. Inventory Invariant Results (27)

| # | Invariant | Result |
|---|---|---|
| 01 | Every mutation creates exactly one authoritative movement | **PASS** |
| 02 | No movement is duplicated | **PASS** (engine) / **FAIL** (F-02 purchasing) |
| 03 | No movement without a valid source | **FAIL** — F-07 |
| 04 | Historical movements cannot be silently modified | **PASS** — no update path found |
| 05 | Stock balance == ledger-derived balance | **PASS** — held under 20-way concurrency |
| 06 | Transfers preserve total organizational stock | **PASS** |
| 07 | POS consumption == inventory consumption | **FAIL** — F-01 (0 vs N) |
| 08 | Recipe consumption == configured recipe quantity | **FAIL** — F-01 |
| 09 | Modifier consumption correctly reflected | **NOT VERIFIED** — blocked by F-01; F-14 known gap |
| 10 | Refund returns never exceed sold quantity | **PASS** — `refundedQty` + invoice-value caps |
| 11 | Valuation equals the configured method | **PASS** |
| 12 | COGS equals inventory cost consumed | **FAIL** — F-01 |
| 13 | Inventory GL == inventory subledger | **PASS** |
| 14 | COGS GL == COGS subledger | **PASS*** — vacuously; both zero (F-01) |
| 15 | Failed jobs cannot silently disappear | **FAIL** — F-05, F-01 |
| 16 | Retries cannot duplicate stock | **PASS** (job layer) / **FAIL** (F-03 GL layer, F-11 PO receive) |
| 17 | Offline replay cannot duplicate stock | **PARTIAL** |
| 18 | Org A cannot access org B stock | **PASS** |
| 19 | Location A cannot silently consume location B | **FAIL** — F-06 |
| 20 | Closed periods cannot be mutated | **FAIL** — F-04 |
| 21 | Configuration changes do not rewrite history | **PASS** — snapshot holds |
| 22 | Every manual adjustment is auditable | **PARTIAL** — AuditLog yes, ledger no (F-07) |
| 23 | Every change attributable to a user/system op | **PARTIAL** — `performedBy` set; reference NULL on adjust |
| 24 | Inventory + COGS accounting stays balanced | **PASS** — every entry balanced |
| 25 | POS → Inventory → COGS → GL independently reconcilable | **FAIL** — F-01 |
| **26** | **Quantity conservation by classification** | **PASS** |
| **27** | **Valuation conservation → GL** | **PASS** |

**14 pass · 8 fail · 5 partial/not-verified.**

---

## 8. Failure Injection Results

| ID | Scenario | Result |
|---|---|---|
| FI-INV-01 | Network failure after mutation, client retries | **PARTIAL** — job idempotencyKey holds; PO receive unprotected (F-11) |
| FI-INV-02 | Crash inside inventory transaction | **PASS** — atomic rollback; no orphan ledger row observed |
| FI-INV-03 | Two terminals sell the final unit | **PASS** (strict) — 1 succeeds, 1 rejected, never negative |
| FI-INV-04 | Worker crash after movement, before job complete | **PASS** — whole job is one transaction; reclaim converges |
| FI-INV-05 | Duplicate stock receipt | **FAIL** — F-02 |
| FI-INV-06 | Duplicate transfer receipt | **PASS** — no in-transit step to duplicate |
| FI-INV-07 | Invoice succeeds, inventory job permanently fails | **FAIL** — F-01: no exception, no alert |
| FI-INV-08 | Refund repeated | **PASS** (static) — `refundedQty` cap enforced |
| FI-INV-09 | Offline sale replayed | **PARTIAL** — `opId` guard; refund replay dead-letters |
| FI-INV-10 | Serialization failure | **PARTIAL** — no retry loop; surfaces as a caller-visible error |

**Crash boundary matrix**

| Case | Failure point | Result |
|---|---|---|
| A | Invoice committed, job never created | **PASS** — enqueue is in the invoice transaction (`:390`) |
| B | Job created, never claimed | **PASS** — 60s stale reclaim |
| C | Job claimed, line 1 issued, process dies | **PASS** — single transaction; nothing partial commits |
| D | Stock + ledger written, COGS post fails | **PASS** — rolls back together |
| E | COGS posted, job completion fails | **NOT VERIFIED** — injection did not reach the in-transaction client; structurally safe by the same single-transaction argument, and F-03 means a genuine replay here **would** duplicate the COGS entry |
| F | Worker retries whole job after partial success | **PASS** — `done` guard + `FOR UPDATE` |

**The async architecture is sound.** Its recovery properties hold everywhere they could be exercised. Its failure is a data bug (F-01) and a status bug (F-05), not a design flaw — do not redesign it.

---

## 9. POS Integration Assessment

| Stage | Assessment |
|---|---|
| **Order** | Correct — no stock effect, explicitly documented. |
| **KOT** | Correct — fire writes tickets and `kitchenPrintedQty` only. Reprinting a KOT cannot consume stock twice. |
| **Invoice** | **Broken (F-01).** Sales GL posts; the stock job is enqueued atomically and then always fails. |
| **Payment** | Correct — no stock effect. |
| **Refund** | Well built: `refundedQty` cap, invoice-value cap, snapshot-based restock at historical cost, `postingKey`, and a guard refusing restock while stock jobs are undrained. **Currently unreachable** — F-01 means nothing was issued to return. Restock also uses the *current* POS location, not the original issue location. |
| **Cancellation** | Correct pre-invoice; nothing had been issued. |
| **Modification** | Correct — the job reads live `OrderItem` rows at drain time, so pre-drain edits change what is deducted. Fired-quantity protection is enforced. |
| **Modifiers** | Consumption wired via `inventoryItemId`; additive only (F-14). |
| **Offline sync** | Device movements are local-only and never pushed; the server re-derives from the recipe at replay. Sound design. One live gap: replayed refunds/voids never supply `stockDisposition`, which `refund-operation.ts:20` hard-requires, so every one dead-letters after the device has already reversed its local stock. |

---

## 10. Inventory ↔ Accounting Assessment

| Area | Assessment |
|---|---|
| Inventory | Subledger ties to GL exactly (788.400000 == 788.400000). |
| COGS | **Never posts from POS** (F-01); duplicable when it does (F-03). |
| GL | Every entry balanced; rounding tolerance handled. |
| AR | Correct and synchronous. |
| Revenue | Correct — which is precisely the danger: revenue without cost. |
| Returns | Correctly reverses Dr Stock Val / Cr COGS at historical cost. |
| Adjustments | GL correct; ledger source reference missing (F-07). |
| Waste | Posts Dr expense / Cr Stock Val; approval bands inert (F-12). |
| Transfers | Cost basis carried; value-neutral across locations. |
| **AP / GRNI** | **Broken (F-02)** — payables doubled, GRNI never clears. |

---

## 11. Reconciliation Assessment

```
Stock Ledger ↔ Stock Balance    PASS   exact under a 7-step workload and 20-way concurrency
Inventory    ↔ GL               PASS   788.400000 == 788.400000
COGS         ↔ GL               PASS*  vacuous — both sides zero (F-01)
POS          ↔ Inventory        FAIL   4 units sold, 0 consumed
POS          ↔ COGS             FAIL   400 revenue, 0 COGS
POS          ↔ GL               PASS   revenue and AR post correctly
```

The independent three-way aggregate — `InvoiceItem` vs `InventoryLedger` vs `JournalLine`, each computed from its own table — is the control that exposed F-01. **Keep it and make it a permanent monitor.** `PosGlReconciliationService` already has the COGS lag arm (`:164-171`); it needs the unit-quantity arm as well, and the date-basis fix (F-13).

---

## 12. Security / Fraud Assessment

| Vector | Status |
|---|---|
| Increase stock without reason | Requires `inventory.move` or a doc + approval. Bands inert (F-12). |
| Decrease stock without authorization | Same. |
| Delete / edit historical movements | No update or delete path exists on `InventoryLedger`. **Good.** |
| Change cost | Only via receipt (audited) or adjustment (audited). |
| Change a recipe after the sale | Historical COGS protected by the snapshot; pre-drain window open (F-15). |
| Backdate receipts | Guarded through the GL — but only when the movement has value (F-04). |
| **Bypass stock controls** | **Yes — F-04.** Any zero-value movement bypasses the books lock entirely. |
| Transfer without approval | Engine endpoint is permission-gated; doc approve is not idempotent (F-10). |
| Fake stock counts | Session posts an auditable adjustment; force requires a reason and is logged. No variance threshold, no count freeze (F-12). |
| Repeatedly refund | Blocked by `refundedQty` and invoice-value caps. **Good.** |
| Exploit offline sync | `opId` idempotency + cross-org replay refusal (`tests/pos/recovery.spec.ts:124`). |
| Exploit duplicate requests | Job layer safe; **PO receive unprotected (F-11)**; GL layer unprotected (F-03). |
| Manipulate location | **Yes — F-06.** |
| Access another organization | **No.** Proven across 6 probes. |

**Most serious fraud finding: F-04.** An operator who understands the system can move stock inside a closed period with no journal entry, by ensuring the movement carries no value.

---

## 13. Concurrency Assessment

The strongest area of the system.

```
Strict mode (allowNegativeStock = false, stockPolicy = block)
  seeded 10 · 20 concurrent single-unit sales
  → 10 fulfilled, 10 rejected ("Insufficient stock … on hand 0, requested 1")
  → on-hand 0 · ledger sum 0 · exactly 10 issue rows        PASS

Permissive mode (shipped default — never-block-sales)
  seeded 5 · 12 concurrent sales
  → 12 fulfilled · on-hand −7 · ledger sum −7
  → running-balance chain breaks: []                        PASS

Concurrent receipts
  10 × (10 units @ 10) simultaneously
  → qty 100 · avg cost 10.000000 · ledger 100               PASS
```

**Note on the existing suite.** `inventory-engine.spec.ts:237` is named *"cannot oversell when allowNegativeStock=false"* but never writes that setting, and the registry default is `true` (`setting-registry.ts:73`). The strict-mode branch it names has therefore never been exercised; the test fails deterministically (3/3 runs, both sales succeed). The property it claims to protect is in fact correct — this audit proved it — but that test was not the thing proving it. Fix the test, do not fix the engine.

Under sustained contention one issue in twelve occasionally failed on a lock wait when run back-to-back with another heavy test; in isolation, 12/12 succeeded. Worth a retry-on-serialization-failure wrapper (P3), since the owner rule is that a sale must never be blocked.

---

## 14. Offline Assessment

| Question | Answer |
|---|---|
| Is inventory authoritative locally or server-side? | **Server-side.** Device `InventoryMovementEntity` rows are local, unit-cost-less, and never pushed. |
| Is offline stock reserved? | No. |
| Can two terminals oversell offline? | **Yes, by design** — consistent with never-block-sales. Not separately reported. |
| Sync ordering / idempotency | `opId` (client UUID) via `IdempotencyService.executeWithKey`; hash mismatch → 409; dependency fail-fast → 424. |
| Stale recipe / product config while offline | Server re-derives at replay from the **current** recipe, not the one the device sold against. |
| Failed inventory sync | `SyncOpDeadLetter` with a review path. |
| **Live gap** | Replayed refunds and voids never carry `stockDisposition`, which `refund-operation.ts:20` requires — so each dead-letters *after* the device already reversed its local stock. Device and server then disagree until a human intervenes. |

Back-dated replay also splits revenue and COGS across periods in the reconciliation (F-13).

---

## 15. Multi-Location Assessment

Isolation between locations is enforced at the data layer — `StockItem` is unique per `(org, product, variantKey, location)`, and transfers are explicit, atomic and value-neutral.

The failure is in **selection**, not isolation: the POS sale path resolves one org-wide location and ignores `CashRegister.locationId` (F-06). Everything downstream — valuation by location, transfers, stocktakes, reorder points — is then computed on stock that was relieved from the wrong store.

---

## 16. Multi-Tenant Assessment

**PASS — the strongest result in the audit.**

Six adversarial probes from inside org B's tenant context, using the application's own client: `stockItem`, `inventoryLedger`, `inventoryBatch`, `product`, `inventoryLocation`, and a deliberately hostile query carrying org A's `organizationId` explicitly. All returned 0. `stock.issue` against org A's product and location threw.

An org-A `InventoryPostingRule` did not influence org B's journal lines.

The qualifier (F-09): this rests on **one** layer. `InventoryPostingRule` is not in `ORG_SCOPED`, RLS is `USING`-only and inert under the superuser connection, and `app.org_id` is set only inside transactions. Correct today; one hand-written query away from not being.

---

## 17. Remediation Plan

### Phase 0 — Verification (done)

`apps/api/test/integration/audit/` — 7 spec files, 27 assertions, real Postgres. Keep them; they are the regression suite for everything below.

### Phase 1 — Production blockers (P0)

1. **F-01** — resolve the real `InvoiceItem` before writing the recipe snapshot, or load `InvoiceItem` rows in `processStockPostingJob`. Independently, move `recordInventoryException` onto its own connection so an aborted transaction can never swallow the alert. *Nothing else on this list matters until this is fixed — every POS-side assertion is blocked behind it.*
2. **F-02** — receive from a vendor bill only when no goods receipt covers the line; wire the existing `ThreeWayMatch`.
3. **F-03** — deterministic `postingKey` on every stock posting (`inv_issue:<ledgerCode>` etc.).
4. **F-04** — assert the fiscal period inside `StockService`, on every movement, regardless of GL value.

### Phase 2 — High priority (P1)

5. **F-05** — `failed`/`partial` status when `failures > 0`; count it; retry only un-relieved lines.
6. **F-06** — resolve the POS location from the cash register, then branch, then setting; fail loudly rather than guess.
7. **F-07** — `sourceType`/`sourceId` on `AdjustStockDto`, stamped by the doc wrapper and count session.
8. **F-08** — pass `uomId` on the vendor-bill receive path.

### Phase 3 — Policy and architecture (P2/P3)

9. F-09 add `InventoryPostingRule` (+ `PurchasePayment`) to `ORG_SCOPED`; add `WITH CHECK` to RLS.
10. F-10 cancel/reverse endpoints for stock documents; `@Idempotent` on approve; move `assertPostable` inside the transaction.
11. F-11 `@Idempotent` on PO receive.
12. F-12 compute document value before the approval gate; variance thresholds and a count freeze.
13. F-13 single date basis in the reconciliation.
14. F-14 negative/removal modifier consumption — a product decision as much as a code one.
15. F-15 recipe versioning, or read the recipe at invoice time and pass it to the job.
16. Fix `inventory-engine.spec.ts:237` to actually write `inventory.allowNegativeStock = false`.
17. Retry-on-serialization-failure wrapper on `StockService.issue`.

### Phase 4 — Certification

Re-run the full audit suite, the golden matrix, all 27 invariants, FI-INV-01…10, and the three-way POS ↔ Inventory ↔ GL reconciliation. Then a shadow stocktake against a real shift.

---

## 44. Critical Final Question

> *If I deploy this inventory system to a real restaurant tomorrow, can a cashier, waiter, kitchen worker, inventory officer, accountant, network failure, retry, concurrent terminal, offline device, or background worker cause inventory quantities, inventory valuation, COGS, or accounting to become incorrect, duplicated, lost, unreconciled, or untraceable?*

```
YES
```

Not as an edge case. On the first sale of the first shift, without anyone doing anything wrong:

1. **Every cashier, every sale (F-01).** Revenue and AR post; stock is never relieved; COGS is never posted; no exception is raised and no alert fires. Gross margin overstated by the full cost of goods, inventory overstated on the balance sheet, and every reorder point and stocktake variance computed from a quantity that has not moved since the last delivery.
2. **Every accountant entering a supplier invoice (F-02).** Stock quantity doubles, inventory value doubles, payables double, and GRNI never clears — in the *intended* receive-then-bill workflow.
3. **Any operator, in a closed period (F-04).** Zero-value movements and unposted receipts pass the books lock untouched, so a signed-off period's inventory can still be changed with no journal entry.
4. **Any multi-branch café (F-06).** Every till relieves one store regardless of which register rang the sale.
5. **Any purchase in cases, cartons or packs (F-08).** Quantity understated by the pack factor and unit cost overstated by the same factor, while total value stays right — so the GL balances and nothing flags it.
6. **Any background worker after a line fails (F-05).** The job is marked `done`, never retried, invisible to the backlog monitor, and the period can be closed over it.

The answers to the 30 restaurant questions that matter most: a cashier **can** sell below stock (by design, and correctly implemented); two terminals **cannot** oversell the final unit in strict mode; KOT printing **cannot** double-consume; invoice creation **cannot** double-consume — it currently consumes *nothing*; offline replay **cannot** duplicate consumption; one organization **cannot** reach another's stock.

---

## Scorecard

| Area | Score | Basis |
|---|---:|---|
| Inventory domain model | 8 | Rich, correct decimals, sensible sentinels |
| Stock ledger | 7 | Complete history, coherent chain; no idempotency key |
| Quantity integrity | 8 | Ledger↔quant exact under concurrency |
| Unit conversion | 4 | Engine correct; bill path 24× wrong |
| Recipe / BOM | 5 | Explodes correctly; unversioned |
| POS integration | 1 | Does not relieve stock at all |
| KOT integration | 9 | Clean separation, no double-consume |
| Modifier consumption | 4 | Additive only; unverifiable behind F-01 |
| Purchase / receiving | 3 | Strong PO controls, doubled by the bill path |
| Stock transfers | 7 | Atomic and value-neutral; no reversal |
| Stock counts | 7 | Adjustment-based, staleness-guarded; no freeze |
| Adjustments | 6 | Auditable; untraceable in the ledger |
| Waste / shrinkage | 5 | Correct GL; inert approval bands |
| Refund / return | 7 | Well built; currently unreachable |
| Inventory valuation | 8 | AVCO/FIFO correct, exact to the cent |
| COGS | 1 | Never posts from POS |
| Accounting integration | 5 | Inventory→GL exact; COGS→GL vacuous; AP doubled |
| Idempotency | 4 | Job layer strong; GL and PO receive unprotected |
| Concurrency | 9 | Best area; proven under 20-way contention |
| Offline operation | 6 | Sound model; refund replay dead-letters |
| Multi-location | 3 | Isolation good, selection broken |
| Multi-tenancy | 8 | Proven; one-layer defence |
| Reporting | 5 | Present; built on unrelieved stock |
| Reconciliation | 5 | Framework exists and works; date basis wrong |
| Security / SoD | 5 | Permissions real; bands inert; period bypass |
| Auditability | 6 | Immutable history; adjustment source NULL |
| Database integrity | 7 | Constraints good; ledger unique missing |
| Operational monitoring | 3 | Alerts exist; F-01 and F-05 defeat them |
| **Overall inventory readiness** | **4.1 / 10** | |

---

```
Static Assessment:        Moderate
Live Verification:        Performed — 27 assertions, real PostgreSQL 16
Production Certification: FAILED — 4 P0, 4 P1 open
```

Do not deploy. Fix F-01 first; it blocks verification of eleven other matrix rows.
