# POS_REMEDIATION_PLAN

**Status: AWAITING GO/NO-GO APPROVAL — no fixes have been made.**
Order respects dependencies and blast radius. Every fix ends with a regression test requirement; the GT suite + Jest must be re-run after each wave.

---

## Wave 0 — P0 (blocks everything)

| # | Finding | Smallest safe fix | Files | Regression |
|---|---|---|---|---|
| 0.1 | **A-001** cashier-mintable store credit | 1) `@RequirePermissions('pos:override')` on `POST /pos/loyalty/credit/issue`; 2) cap amount (org setting, default 0 = disabled); 3) post funding GL (Dr source acct / Cr store-credit liability) inside the same tx — refuse if no funded source; 4) `audit.recordInTx` | pos-loyalty.controller.ts:107-111, pos-loyalty.service.ts:169-192 | new spec: cashier mint → 403; admin-with-override + funded source → 201 + GL + audit row; GT re-run A-001 driver expecting 403 |
| 0.2 | **A-100** notes-500 on same endpoint | drop `notes` from ledger create (column absent) or add column via migration — recommend dropping the arg | pos-loyalty.service.ts:183 | notes-mint 201 |

## Wave 1 — Security cluster (P1/P2, independent)

| # | Finding | Fix | Files | Regression |
|---|---|---|---|---|
| 1.1 | **A-005** override PIN brute-force | failed-attempt counter + lockout (reuse LoginAttempt infra) + audit failed verifies | pos-overrides.service.ts:123-165 | 10 wrong → locked; audit rows present |
| 1.2 | **A-007** PIN→password | require current PASSWORD for change-password (PIN may remain for PIN change only) | pos-auth.service.ts:166-182 | PIN-only attempt 400 |
| 1.3 | **A-030** stale 12h token perms | in-service checks (`assertPricingAuthority`, `writeOff`) re-read roles from DB (reuse PermissionsGuard path) | pricing-policy.ts:34-39, pos-invoice.service.ts:599 | revoke pos:discount mid-shift → discount 403 within one request |
| 1.4 | A-016/A-103 | add `pos:delete_item` enforcement server-side on order-item mutations or remove the dead UI gate; add `pos:void` to Manager role seed; align print/reprint permission with UI (`pos:reports`) | pos.controller.ts, seed.ts:687+, pos-receipts.service.ts:1461 | permission matrix test |
| 1.5 | A-020 | add WALKIN guard to direct credit endpoint | pos-invoice.service.ts:1216-1228 | walk-in credit 400 |

## Wave 2 — Terminal blockers (P1)

| # | Finding | Fix | Files | Regression |
|---|---|---|---|---|
| 2.1 | **A-002** line-discount reason | collect reason in LineDiscountDialog → `line.discountReason`; (backend already accepts it — A-002 control proved) | LineDiscountDialog.tsx, Terminal.tsx:840-847, cart.store.ts:181-193 | GT-06b → PASS |
| 2.2 | **A-003** lookup array | unwrap `res.data[0]` + feedback toast on no-match | RetailTerminal.tsx:393-400 | scan beyond page 1 adds item |
| 2.3 | **A-004** offline unmounted | uncomment OfflineIndicator in cafe Terminal | Terminal.tsx:1341 | manual + hook presence test |
| 2.4 | **A-101** tax flag | tri-state product flag: respect line/tax intent — resolve `l.taxInclusive ?? tax.isInclusive` (drop Boolean(product.taxInclusive) overwrite; treat product flag only as display default) | pos-orders.service.ts resolveLines | new spec: isInclusive tax + product false → inclusive split |
| 2.5 | A-017/A-019 | prompt override for line ≥tier; tighten client settle tolerance to backend ε | Terminal.tsx:872, PaymentDialog.tsx:224 | mid-payment 400s gone |

## Wave 3 — Money-adjacent reports & shift (P1/P2)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 3.1 | **A-006** summary expected | add adjustments to cashierShiftSummary formula (reuse computeExpected) | re-run A-006 driver: 57,700 both |
| 3.2 | A-012 | server-side pending-sync check (device queue endpoint or refuse close while device tokens have undelivered seqs) | close-over-offline test |
| 3.3 | A-031 | reports: bucket by issueDate; net refundedQty in item reports; unify byMethod definition | golden report asserts |
| 3.4 | A-104 | fix e2e spec syntax (line 80-83 parens) + wire into `pnpm verify` | `pnpm test:e2e` runs green |

## Wave 4 — P2 batch (ordered by risk)

1. **A-009** legacy 375,000 adjusting JE — **requires owner sign-off** (Dr Cash / Cr AR + WALKIN write-off) — run `scripts/pos-release-preflight.cjs` before/after
2. SoD cluster: A-011 banking approval+ownership · A-014 pay_in counterpart bounds/approval · A-015 handover variance threshold · A-013 one-user-one-register · A-010 decide reopen-or-remove
3. Inventory: A-024 stamp recipe issues with sourceType/sourceId (+ persist `reference`) · **A-025 add FOR UPDATE on StockItem in issue()** (chain race live-proven) · A-026 deterministic location + no silent swallow · A-027 correction on bare receipts
4. A-008 RLS: connect app via non-owner role (`rls:setup-role`) + `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for PosRefund
5. A-028 postingKey on payment+refund JEs; A-029 refund receipt type; A-002b A-018 cafe scan scope; A-021 config-change invalidation; A-022 fixed-discount display; A-023 server-side category paging

## Wave 5 — P3 hygiene (after stability)

A-102 sync funding field · orphaned job cleanup · EventOutbox pruning · IdempotencyRecord GC · dead code removal (dup useCheckout, useLookupSku, enqueueTabRound, dead routes) · seed gap fixes (products.view vs product:read) · receipt-number unique index · READMEs for F1-13 dead code cluster.

## Verification protocol (per wave)

1. `pnpm --filter @erp/api test` (jest) + `pnpm test:pos:recovery` on disposable DB
2. Re-run `audit/repro-a-series.cjs`, `audit/gt-suite.cjs`, `audit/gt-retest.cjs` against a FRESH audit org (drivers included in `audit/`)
3. `scripts/pos-release-preflight.cjs` before/after Wave 4.1
4. Only after Waves 0–3 + 4.1: re-issue production-readiness verdict (expected: CONDITIONALLY PRODUCTION READY)
