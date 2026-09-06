# POS_SELLING_TERMINAL_AUDIT

**Scope:** Selling Terminal feature-by-feature — cafe (`Terminal.tsx`), retail (`RetailTerminal.tsx`), payment dialog, and their backend counterparts. Static (Phases 1–2) + live (Phase 14) evidence.

## 1. Product discovery

| Scenario | Result | Evidence |
|---|---|---|
| Search by name | Client-side filter over loaded catalog (cafe: MenuItems; retail: 200-row product page) | Terminal.tsx:151-170, features/pos/api.ts:43-63 |
| Barcode scan (cafe) | **P2 (A-018):** resolves only against the *category-filtered* grid — cross-category scan no-ops silently | Terminal.tsx:816-826 |
| Barcode scan (retail) | **P1 (A-003 CONFIRMED live):** `/pos/lookup` returns array; `res.data?.id` never resolves — fallback dead beyond page 1 | RetailTerminal.tsx:393-398; evidence-a003.json |
| Inactive/deleted products | Correctly excluded both layers (`isActive`, tenancy-extension `deletedAt:null`) | pos.service.ts:1048-1063; product.service.ts:71-103 |
| Out-of-stock | **Never blocked** (owner rule); no OOS badge in POS grid (digital menu does badge) — P3 | stock.service.ts:546-578; MenuGrid.tsx |
| Price display | Same DB source as server quote (basePrice/salesPrice); **stale-cache window self-heals at quote with `expectedTotal` 400 guard** | resolveLines; pos.service.ts:225 |
| Variants | Server re-resolves variant price from DB at quote — client value never trusted | pos-variant.service.ts:212-226 |

## 2. Cart

| Scenario | Result |
|---|---|
| Add/remove/qty±/merge-duplicate | PASS — merge key `(product|menu)+taxInclusive+mods+variant+acc+note` (cart.store.ts:138-153) |
| Decimal quantity | **Accepted everywhere with no integer/min/max enforcement** (numpad `.`; DTO `@IsNumber`; `allowFractionalSale/minSaleQty/maxSaleQty` never read) — P3 (F1-10) |
| Clear/empty/large carts | No guards needed; body limit 2MB bounds size |
| Rapid/double clicks | **4-layer guard verified** (busy flag → write-ahead envelope → stable per-cart key → server pending-lock). No window found (Phase-1 delegate + GT-14 live) |
| operationPending lock | Blocks all wrapped mutations during settle; bypassable via raw `setState` (internal use only) — P3 note |

## 3. Pricing, discounts, taxes (INV-1)

```
displayed TOTAL = quotedTotal ?? estimate (labeled) → charge gated on live quote
server re-prices every line from DB at quote AND re-verifies expectedTotal ±1e-6 in billing tx
client unitPrice/variantPrice/modifier deltas NEVER trusted
```

| Scenario | Result | Evidence |
|---|---|---|
| Order-level % discount + reason + override | **PASS live (GT-06)**: 15% → 10,200; discountTotal 1,800; GL Cr4100=10,200 net | evidence-gt.json |
| **Line discount** | **P1 (A-002 CONFIRMED live):** 400 "A discount reason is required" — UI never collects line reasons; control-with-reason 200 proves root cause | evidence-a002.json |
| Line ≥10% discount | **P2 (A-017):** no override prompt client-side → mid-payment 403 (backend measures per-line effective %) | pricing-policy.ts:29-42 vs Terminal.tsx:872 |
| Fixed-amount line discount display | **P2 (A-022):** renders undiscounted (display only; totals correct) | OrderPanel.tsx:315 |
| Tax-inclusive | **P2 (A-101 CONFIRMED live):** `resolveLines` overwrites client flag with `Boolean(product.taxInclusive)`; Tax.isInclusive=true + product=false ⇒ exclusive applied; menu-item path uses tax flag correctly | GT-07 retest |
| Rounding | 6dp Decimal throughout; backend rounding-account epsilon posted (live trial balance: ROUNDING 0.000001) | posting.service.ts:124; live TB |

## 4. Customers

Walk-in default (auto-ensured); selection at any time (quote is customer-independent); credit requires named customer + limit/hold checks at TWO layers (preflight + in-tx FOR UPDATE on Partner+Tab); **P2 (A-020): dead direct endpoint `POST /pos/invoices/:id/credit` bypasses WALKIN guard**.

## 5. Payment dialog (checkout critical path)

| Scenario | Result | Evidence |
|---|---|---|
| Exact cash | PASS (GT-01): Dr1101=Cash leg, drawer movement, payment+merchant receipts | evidence-gt.json |
| Overpay + change | PASS (GT-05 driver logic; change quarantined from tenders/GL — amountTendered recorded on settle only) | pos-invoice.service.ts:510-513 |
| Underpay/zero/invalid | Rejected server-side (positive legs; Σ≤residual ±1e-6); **P2 (A-019):** client tolerance 0.01 lets 1-cent-short reach server → mid-payment 400 | normalizeTenders:763-780; PaymentDialog.tsx:224 |
| MTN → MTN account | **PASS live (GT-02):** 2110 debit exactly | evidence-gt.json |
| Airtel → Airtel account | **PASS live (GT-03):** 2120 debit exactly | evidence-gt.json |
| Bank + reference | **PASS live (GT-04):** 1200 debit; reference persisted | evidence-gt.json |
| Card | Category-enforced; **P3 (F2-5):** UI offers current-asset cards the backend rejects (mid-settle 400) | tender-account.ts:61 |
| Split 40k cash + 60k MTN | **PASS live (GT-05):** 2 payments right accounts; allocations 100,000; `paymentMode=mixed`; drawer movement 40k only | evidence-gt.json |
| Store credit tender | Mechanics sound (same-tx lock, negative rejected, forced liability account) — but funding is the P0 (A-001) | payment.service.ts:229-241 |
| Credit settle | PASS (settleCredit writes no Payment/GL; AR stays; limit checked in-tx) | pos-credit-settlement.spec + Phase-2 |

## 6. Payment transaction integrity (INV-3/INV-4)

- **GT-14 live:** same-key replay → 0 new invoices (replay 200); concurrent same-key → exactly 1 sale (loser 409)
- **GT-17:** client-retry-after-timeout ≡ same-key replay — single sale
- Crash windows W0–W5 all recover to exactly-once (staged business outcomes; DB uniques as backstop)
- One **live artifact worth noting**: a checkout that 400s after order creation (our tax_payable-missing probe) leaves an `in_progress` orphan order that correctly **blocks shift close** until cancelled — safe, but noisy (driver teardown had to cancel it)

## 7. UX verdict

Fast paths are genuinely good (keyboard numpad, scan-to-add in retail, blind count). Cashier-critical gaps: **no offline/failed-sale surface in cafe mode (A-004)**, **line-discount dead end (A-002)**, **silent scan failures (A-003/A-018)**, mid-payment 400s from tolerance/permission mismatches (A-019/A-017/D3-print).
