# POS_PRODUCTION_READINESS_AUDIT

**Audit ID:** POS-CAFE-PHASE14 · **Dates:** 2026-09-04 → 2026-09-05 · **Live org:** `POS-AUDIT-20260905083145` (`d86cfbc8-b114-4ef9-ae45-0ed4ebc4d207`, UGX)
**Method:** static code audit (Phases 0–11) → live reproduction in isolated org (Phase 14) → Wave-0 remediation → this report.

> **WAVE 0 STATUS: ✅ COMPLETE & LIVE-VERIFIED (2026-09-05)** — A-001 (P0) and A-100 closed.
> Evidence: `audit/evidence-wave0-verification.json` — **9/9 live checks PASS** on the rebuilt server:
> cashier mint → **403**; unfunded mint → 400; cap=0 → 403 (disabled by default); funded mint within cap → 201
> with **funding GL Dr 5200 / Cr 2350 (10,000, balanced)** + **AuditLog row** + balance delta exact; notes → no 500.
> Regression: new spec `pos-store-credit-issuance.spec.ts` **5/5 PASS**; full stage-1 suite **54 suites / 482 tests PASS**; vitest recovery **10/10**; web typecheck clean.
> GT money path re-verified after the fix: **unchanged and exact** (GT-01…GT-18 downstream states all still hold).

---

## 1. Executive summary

POS-CAFE is a **financially sound core wrapped in a partially broken authorization and terminal layer**. The money pipeline — idempotent checkout, double-entry GL, refund bounds, shift close — is genuinely excellent and **live-proven** in an isolated org: 18/18 golden transactions executed with exact GL, drawer, receipt, stock and reconciliation figures. However, live reproduction confirmed **one P0 (cashier-mintable store credit, spendable, unbacked, unaudited)**, four P1s, and a set of P2 authorization/report gaps. The repo's own E2E suite is broken (syntax error), meaning the headline "sell loop" was never actually running in CI.

**Verdict: ❌ NOT PRODUCTION READY** (unchanged from static analysis; now live-evidenced). Path to conditional readiness is short — the P0/P1 fixes are small and well-bounded.

## 2. Architecture reviewed

- **Frontend** React 18 + React Router + TanStack Query + Zustand; cafe/retail/rental terminals; offline queue (IndexedDB write-ahead)
- **Backend** NestJS 11 + Prisma 6 (PG 18), `/api/v1`; modules: pos, accounting, inventory, invoicing, sync, kernel(idempotency/tenancy/RLS)
- **Money integrity machinery** 4-layer idempotency (HTTP key → clientOperationKey → postingKey → stockJobKey), staged business-outcome recovery, single GL writer with rounding account, FOR UPDATE lock discipline
- **Isolation** audit org with own COA (14 accounts), register+drawer, 5 payment methods, warehouse+stock, 4 users (admin/manager/cashier/supervisor + waiter/kitchen roles), 18% VAT tax

## 3. Tests executed (Phase 14)

| Suite | Result |
|---|---|
| **Golden GT-01…GT-18** (live, isolated org) | **18/18 executed; 62 checks PASS** + documented permission asymmetries (see E matrix) |
| **Jest** (`scripts/test-pos-stage1.cjs`, disposable `pos_stage1_9021`) | **53 suites / 477 tests — 477 PASS, 0 fail** |
| **Vitest recovery** (`tests/pos`) | **10/10 PASS** |
| **Vitest e2e** (`tests/e2e/pos-sell-loop.spec.ts`) | **BROKEN — does not compile** (syntax error :83) — finding A-104 |

## 4. Findings — CONFIRMED statuses (live unless noted)

### P0 — Critical
| ID | Status | Finding | Live evidence |
|---|---|---|---|
| **A-001** | **CONFIRMED** | **Store-credit minting by Cashier/Waiter** (`partner:read` only, no cap, no GL, no audit) → spendable on real sales | `evidence-a001.json`: mint 201 ×4 (400,000 total), `glEntries=0`, `loyaltyAuditRows=0`; **spend leg: INV-2026-000001 paid 16,000 in store credit — goods (2 cakes) left, liability Dr 16,000 absorbed fabricated credit**. Bonus: same endpoint 500s (`PrismaClientValidationError`) when the documented `notes` DTO field is used — **A-100 (P2)**. |

### P1 — High
| ID | Status | Finding | Live evidence |
|---|---|---|---|
| **A-002** | **CONFIRMED** | Line discounts blocked: 400 "A discount reason is required" at settle; no UI path to supply a line reason | `evidence-a002.json`: quote 201 → checkout **400**; control with `discountReason` on the line → **200** (INV-000002). Root cause exactly as static. |
| **A-003** | **CONFIRMED** | Retail barcode fallback dead: `/pos/lookup` returns an **array**; frontend reads `res.data?.id` | `evidence-a003.json`: response is array of product rows → `.id` undefined → silent no-op beyond loaded page. |
| **A-004** | **CONFIRMED (static)** | Cafe terminal offline queue unmounted (`OfflineIndicator` commented out) | `Terminal.tsx:1341` vs `RetailTerminal.tsx:661`; browser-level, not API-reproducible. |
| **A-005** | **CONFIRMED** | Manager override PIN brute-force: no lockout, no failure audit, no attempt rows | `evidence-a005.json`: 10× wrong PIN → 10× 401, `LoginAttempt rows=0`, `auditRows=0`; correct PIN still accepted after failures (throttle-only protection: 10/min ⇒ 4-digit space in ~17h). |
| **A-006** | **CONFIRMED** | `cashier-shift-summary` omits `adjustment` movements → false expected-cash | `evidence-a006.json`: reconciliation expectedCash **57,700** vs summary **52,700** — drift = exactly the 5,000 adjustment. |

### Downgraded / adjusted after live repro
| ID | Status | Change |
|---|---|---|
| **A-007** | **CONFIRMED, downgraded P1→P2** | `change-password` is **self-service only** (`user.sub`); cannot target another user. Live: cashier rotated own back-office password with 4-digit PIN + logged in with it (200/200), then restored. PIN-as-only-credential for password rotation remains a weakness, not a takeover vector. |

### New findings from live phase
| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **A-100** | P2 | `credit/issue` 500s on documented `notes` field (writes nonexistent ledger column) | `evidence-a001.json → mintWithNotes` (PrismaClientValidationError) |
| **A-101** | P2 | **`resolveLines` overwrites client `taxInclusive` with `Boolean(product.taxInclusive)`** — a Tax configured `isInclusive=true` applies **exclusively** when the product flag is false; client intent silently ignored | GT-07 retest: request `taxInclusive:true` ignored → 10,000 + 1,800 = 11,800; GL correct for the exclusive computation (Cr4100 10,000 / Cr2300 1,800 / Dr1300 11,800) |
| **A-102** | P3 | Sync `cash_session.open` ignores `openingSourceAccountId` — offline shift-open cannot fund an excess float, only declare drawer carry | GT-12 debugging trail |
| **A-103** | P3 | Permission asymmetries live-confirmed: Manager role cannot void (`pos:void` missing from Manager); print gated `pos:override`+role so even Manager 403s on plain print of a printed receipt (reprint-with-reason flow) | GT-09/GT-16 captures |
| **A-104** | P3 | `tests/e2e/pos-sell-loop.spec.ts` does not compile (syntax error :83) — the repo's primary E2E never runs | vitest transform failure |

### Carried P2 register (static-confirmed, live not required)
A-008 RLS-not-forced/owner-bypass · A-009 legacy 375,000 cash GL overstatement · A-010 dead reopen · A-011 banking no-approval/no-owner · A-012 client-trusted pendingSyncCount · A-013 one-user-multi-register · A-014 pay_in unapproved/unbounded · A-015 handover auto-approves variance · A-016 void/delete UI-gates only · A-017 line≥10% mid-payment 403 · A-018 cafe scan scoped · A-019 0.01-vs-1e-6 settle tolerance · A-020 dead credit endpoint bypasses WALKIN guard · A-021 stale tender cache · A-022 fixed-discount display · A-023 retail grid truncation · A-024 recipe stock untraceable · **A-025 issue() ledger chain race (F4-2) — LIVE-CONFIRMED in GT-15: 4 concurrent rows share stale qtyBefore, chain linking broken while per-row arithmetic stays exact** · A-026 nondeterministic stock location · A-027 negative-stock COGS gap · A-028 payment GL no postingKey · A-029 no refund receipt · A-030 stale POS-token permissions · A-031 reports createdAt-bucketing + no refund netting.

## 5. Production-readiness verdict

```
P0 defects:                0 remaining (A-001 CLOSED Wave 0, live-verified)  → PASS
Critical financial dup:    none — GT-14/15/17 prove exactly-once             → PASS
Material reconciliation:   A-006 false shift figures; A-009 legacy           → FAIL gate (Wave 3)
Critical security:          A-005 brute-force; A-007 PIN→password; A-030    → FAIL gate (Wave 1)
Golden tests:               18/18 executed, downstream states verified       → PASS
Critical E2E:               e2e suite broken (A-104)                         → FAIL gate (Wave 3)
Regression suites:          Jest 482/482, recovery 10/10                    → PASS
Known data corruption:      A-009 needs formal remediation decision          → PENDING
```

**NOT PRODUCTION READY — but the P0 is gone.** With Wave 0 complete, the remaining blockers are the Wave-1 security cluster (A-005/A-007/A-030), Wave-2 terminal blockers (A-002/A-003/A-004/A-101), Wave-3 report/E2E fixes (A-006/A-104), and the A-009 legacy entry decision. On completion of Waves 1–3 + 4.1 the expected verdict is **CONDITIONALLY PRODUCTION READY** (conditions: A-009 remediation or formal acceptance; SoD batch scheduled).

## 6. Remediation status

| Wave | Scope | Status |
|---|---|---|
| **0** | **A-001 (P0) + A-100** — `pos:override` gate, `pos.storeCreditIssueLimit` cap (default 0 = disabled), mandatory funded GL (Dr funding / Cr liability, drawer refused), FOR UPDATE lock, in-tx audit; notes 500 fixed | **✅ DONE + live-verified 9/9** |
| 1 | Security cluster: A-005 lockout, A-007 password-auth, A-030 live perms, A-016/A-103 permission alignment, A-020 WALKIN guard | pending approval |
| 2 | Terminal blockers: A-002 line-reason UI, A-003 lookup unwrap, A-004 offline mount, A-101 tax tri-state, A-017/A-019 | pending approval |
| 3 | A-006 summary formula, A-012 server-side pending check, A-031 report definitions, A-104 e2e fix | pending approval |
| 4 | A-009 legacy JE (owner sign-off), SoD cluster, inventory traceability | pending approval |
| 5 | P3 hygiene | pending approval |

**Wave-0 change set:** `setting-registry.ts` (+`pos.storeCreditIssueLimit`), `pos-loyalty.service.ts` (issueCredit rewritten: gate/cap/funding-GL/lock/audit), `pos-loyalty.controller.ts` (`pos:override` + `fundingAccountId` DTO), `CustomerProfileDialog.tsx` (manager-only funded UI), `scripts/test-pos-stage1.cjs` (+new spec pattern), `test/integration/pos-store-credit-issuance.spec.ts` (new, 5 tests), `audit/verify-wave0.cjs` (live verifier).
