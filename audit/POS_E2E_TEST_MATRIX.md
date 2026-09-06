# POS_E2E_TEST_MATRIX

**Legend:** Status = live result (Phase 14, isolated org) unless marked *(static)*. Severity refers to the defect the scenario exposes (not the scenario's own pass/fail).

## Golden transactions (GT-01…GT-18)

| ID | Feature | Scenario | Expected | Actual | Status | Severity |
|----|---------|----------|----------|--------|--------|----------|
| GT-01 | Cash sale | 2×Tea 6,000; verify invoice+GL+drawer+receipt+stock+order-close | settled; Dr1101/Cr1300/Cr4100 =6,000; movement 6,000; RCT payment+merchant; job done; ledger −2; order closed | All exact | **PASS** | — |
| GT-02 | MTN sale | 1×Cake 8,000 | Payment→2110; no drawer movement; Dr2110/Cr4100 | All exact | **PASS** | — |
| GT-03 | Airtel sale | 1×Cake 8,000 | Payment→2120; no drawer movement | All exact | **PASS** | — |
| GT-04 | Bank sale | 1×Cake 8,000 ref AUD-TRF-001 | Payment→1200; reference persisted | All exact | **PASS** | — |
| GT-05 | Split payment | 40k cash + 60k MTN of 100k | 2 payments right accounts; allocations Σ=100k; mode=mixed; drawer 40k only | All exact | **PASS** | — |
| GT-06 | Order discount | 15% + reason + manager override | Total 10,200; disc 1,800; GL revenue net | All exact | **PASS** | — |
| GT-06b | Line discount | 10% line, no reason | (defect A-002) settle succeeds | **400 "A discount reason is required"**; control-with-reason 200 | **FAIL (defect confirmed)** | **P1 A-002** |
| GT-07 | Taxable sale | 2×Coffee, Tax isInclusive=true, product taxInclusive=false | gross=net+tax split per flags | **Exclusive applied (10,000+1,800)** — client flag overwritten by product flag | **PASS w/ defect** | **P2 A-101** |
| GT-08 | Multi-item + decimal qty | 1.5 Tea + 0.5 Cake + 1 Service | Σ=18,500; decimals persisted | Exact | **PASS** | — |
| GT-09 | Void | manager voids settled sale | refunded; cash→drawer; refund GL Dr rev/tax / Cr AR | Manager **403 (pos:void missing from Manager role)**; admin void PASS; drawer refund movement 11,800; GL exact | **PASS w/ gap** | **P3 A-103** |
| GT-10 | Full return | MTN sale, restock | invoice refunded; cake restocked +1; refund to MTN acct (2110); PosRefund+GL linked | All exact | **PASS** | — |
| GT-11 | Partial return | 1 of 2 teas, cash | partially_refunded 3,000; drawer refund 3,000 | Exact | **PASS** | — |
| GT-12 | Offline sale | device push: session open + sale | applied, attributable to actor | Applied (after fixing drawer-carry float + A-102 note) | **PASS** | P3 A-102 (source-account ignored) |
| GT-13 | Offline double-sync | re-push same ops | replayed; 1 sale; 1 payment | replayed/replayed; exactly 1+1 | **PASS** | — |
| GT-14 | Duplicate payment | same-key replay + concurrent same key | no dup sale | 0 new invoices; concurrent→1 sale (409 loser) | **PASS** | — |
| GT-15 | Concurrent sale | parallel 2×2 of last units | both sell; stock −4; ledger chain intact | both 200; stock −4 exact; **per-row arithmetic OK but chain linking BROKEN (stale qtyBefore)** | **PASS w/ defect** | **P2 A-025 (F4-2)** |
| GT-16 | Printer failure | print a printed receipt | sale immutable; failure surfaces cleanly | 403 → reprint-with-reason redirect (correct design); sale immutable; cashier AND manager both 403 on plain print | **PASS w/ asymmetry** | P3 A-103/D3 |
| GT-17 | Network failure mid-pay | retry after success | single sale via replay | invoices delta 0 | **PASS** | — |
| GT-18 | Shift close | close at expected | variance 0; Z frozen | expected=counted 156,400; Z kind='z' snapshot; **summary shows different expected when adjustments exist (A-006)** | **PASS w/ defect** | **P1 A-006** |

## A-series reproductions

| ID | Feature | Scenario | Expected (per finding) | Actual | Status | Severity |
|----|---------|----------|------------------------|--------|--------|----------|
| A-001 | Store-credit mint | Cashier POSTs credit/issue 100,000 | (defect) mint succeeds w/o GL/audit | **201; 400k across runs; glEntries=0; audit=0; SPEND: INV-1 paid 16,000 fabricated credit** | **CONFIRMED** | **P0** |
| A-001b | notes field | credit/issue with `notes` | DTO-documented field accepted | **500 PrismaClientValidationError** | **CONFIRMED** | P2 A-100 |
| A-002 | Line discount | settle w/o line reason | 400 reason | 400 "A discount reason is required"; control 200 | **CONFIRMED** | P1 |
| A-003 | Barcode lookup | GET /pos/lookup | array shape kills `.id` | isArray=true, product objects | **CONFIRMED** | P1 |
| A-004 | Cafe offline mount | OfflineIndicator mounted | hook mounted | commented out (Terminal.tsx:1341) | **CONFIRMED (static)** | P1 |
| A-005 | Override brute-force | 10 wrong PINs | lockout/audit if defended | 10×401; 0 attempt rows; 0 audit; correct PIN accepted after (throttle-only) | **CONFIRMED** | P1 |
| A-006 | Shift summary drift | adjustment 5,000 in open shift | summary == reconciliation | recon 57,700 vs summary **52,700** (drift = adjustment) | **CONFIRMED** | P1 |
| A-007 | PIN→password | rotate own password via PIN | (downgraded) self-service only | 200 + login with new password (self); manager-targeting blocked by DTO | **CONFIRMED, rescoped** | P2 |

## Negative/adversarial probes (all behaved correctly)

| Probe | Result |
|---|---|
| Non-owner drawer movement (admin into cashier session) | 403 "belongs to a different cashier" ✓ |
| Open below drawer ledger | 400 "below the drawer ledger" ✓ (float continuity enforced) |
| Close with unsettled orders | 400 blocked w/ reconciliation detail ✓ (a failed checkout's orphan order correctly trapped) |
| Opening float without funding source | 400 "Choose the source of added float" ✓ |
| Insufficient funding account | 400 "insufficient recorded funds" ✓ |
| Idempotency hash mismatch (same key, different body) | 409 ✓ (observed in driver reruns) |
| Different-key same logical sale | new legitimate sale (clientOperationKey unique per operation) ✓ |
| Tenders below total | 400 "does not match amount due" ✓ |
| Refund > collected | blocked by allocation bounds (static + GT-10/11 exact) ✓ |
| Concurrent shift close | session FOR UPDATE + status recheck (Phase-6 static; no double-Z) ✓ |

## Existing suites

| Suite | Result |
|---|---|
| Jest stage-1 (disposable DB) | **477/477 PASS** (53 suites) |
| Vitest recovery | **10/10 PASS** |
| Vitest e2e sell-loop | **BROKEN — syntax error** (A-104) — cannot run |
