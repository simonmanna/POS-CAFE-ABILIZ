# Rental Management System — Revised Integration Plan

**Goal:** Add a full rental lifecycle (quote → hold → agreement → checkout → extend/swap → return → inspect → settle) to the existing POS-CAFE system, behind an `ENABLE_RENTAL` feature flag, with every shilling landing in the existing general ledger.

**Source design:** `rental-management-module` AI design (attached). Verified anchor-by-anchor against the repo — the design is accurate. This plan revises the *sequence, exit criteria, and repo-specific gotchas*, not the architecture.

**Architecture (kept from source design):**
- Rental is a capability of `Product` (`isRentable` + rate card), not a separate product entity.
- Checkout is an internal `StockService.transfer` (RENT-STOCK → RENT-OUT), **no COGS, no inventory relief**.
- Rental/sale distinction is **per line** (`OrderItem.rentalAgreementLineId`), not per order — mixed carts work.
- Status lives on `RentalUnit` (never on `InventorySerial` — that would break issue/receive for every other product).
- Deposit is a **liability** (`customer_deposit` account), never an invoice line; fees are ordinary invoice lines via seeded fee products.
- Availability is the one genuinely new engine: `RentalAvailabilityService` with a calendar-window sweep (max-concurrent, not naive sum) + advisory locks + a `btree_gist` EXCLUDE constraint.

---

## Verification of the source design against this repo

| Design claim | Repo reality | Verdict |
|---|---|---|
| No rental code exists | `grep -ril rental` in api/shared/web → 0 hits | ✅ true |
| `gen:vertical` scaffold | `scripts/gen-vertical.mjs` — creates module/service/controller/spec/dto, wires app.module.ts + permissions | ✅ true, use it |
| ModuleRegistry + permissions auto-seed | `module-registry.service.ts`, `PERMISSIONS.beverage` at `packages/shared/src/permissions.ts:262` | ✅ true |
| `ORG_SCOPED` hand-maintained at `:9` | confirmed; `SOFT_DELETE` at `:206` | ✅ true — **the one list that silently leaks across tenants** |
| Feature-flag gate | `...(enabled('ENABLE_BEVERAGE') ? [BeverageModule] : [])` at `apps/api/src/app.module.ts:72-75` | ✅ true |
| `posMode` toggle | `Terminal.tsx:2046-2047` (`cafe`/`retail`) | ✅ true; also `pos.controller.ts:199`, `sync-push.service.ts:317`, `SettingsPage.tsx:11`, `DevCompanySettingsPage.tsx:35` |
| `StockReservation` is date-less | `ATP = on-hand − sum(active)` at `stock-reservation.service.ts:21` | ✅ true — the gap the calendar engine fills |
| `StockService.transfer` remaps serials' `locationId` | `stock.service.ts` (transfer ~1147-1200) | ✅ true |
| RLS catalog-driven migration re-runnable | `migrations/20260731093000_rls_all_org_scoped_tables/` exists | ✅ true |
| COA required-key guard | `coa-template.ts:127-131` (`COA_MAPPINGS`) | ✅ true — safety net for the 4 new keys |
| ~37 account mapping keys | 39 keys (`account-mappings.ts`) | minor drift — add 4, don't replace |
| Cited line numbers | several drifted (Product 723, Order 4757, OrderItem 4831) | **use symbols, not line numbers** |

**Corrections applied in this plan:**
1. Reference files by symbol/path — the source design's line numbers are stale by a few to dozens of lines.
2. Re-sequenced into **8 milestones with hard exit gates** (0-compile-errors, `migrate diff` = 0 drift, targeted specs green) instead of 7 loose phases.
3. Added repo-specific gotchas: OneDrive `prisma generate` EPERM, stale dist servers on ports, `text=` engine vs anchored regex in Playwright, `/auth/login` throttle (use storageState).

---

## Build order (8 milestones)

Each milestone ends at a **gate**: `pnpm --filter @erp/shared build && pnpm --filter api typecheck && pnpm --filter web typecheck && pnpm lint:arch` → 0 errors, then targeted specs.

### M0 — Scaffold + flags (½ day)
- `pnpm gen:vertical rental` → creates `apps/api/src/modules/rental/` skeleton + wires `RentalModule` into `app.module.ts` + placeholder permissions.
- Replace the naive `enabled('ENABLE_RENTAL')` gate in app.module.ts (gen:vertical wires it directly; wrap it): `...(enabled('ENABLE_RENTAL') ? [RentalModule] : [])`.
- Add `ENABLE_RENTAL="false"` / `VITE_ENABLE_RENTAL="false"` to `.env.example`.
- Replace placeholder permissions with real `rental.*` set in `packages/shared/src/permissions.ts` (read, manage, checkout, return, inspect, waive, extend, swap, refund_deposit, service, report, override_score) — mirror `PERMISSIONS.beverage` block shape.
- **Gate:** module boots with flag off; typecheck + lint:arch clean.

### M1 — Schema, tenancy, kernel lifecycle (1 day)
- `apps/api/prisma/schema.prisma`:
  - `Product` += `isRentable, rentalIsPooled, rentalDepositAmount, rentalReplacementCost, rentalLateFeePerPeriod, rentalDefaultPeriod, rentalMinPeriods, rentalMaxPeriods, rentalBufferDays, rentalRequiresCleaning` (beverage-control precedent: scalar fields on Product).
  - `Order` += `transactionKind SaleKind @default(sale)` + `rentalAgreementId String?`; `OrderItem` += `rentalAgreementLineId String?`. **Do NOT touch `OrderType`** (service-mode axis).
  - New enums (13): `RentalUnitStatus, RentalAgreementStatus, RentalReservationStatus, RentalBookingStatus, RentalRatePeriod, RentalConditionGrade, RentalServiceType, RentalServiceStatus, RentalDepositStatus, RentalDepositMoveType, RentalLocationRole, RentalPackageItemRole, SaleKind`.
  - New models (all org-scoped): `RentalRate, RentalUnit, RentalLocationConfig, RentalPackage, RentalPackageItem, RentalReservation, RentalReservationLine, RentalAgreement, RentalAgreementLine, RentalBooking, RentalExtension, RentalSwap, RentalReturn, RentalReturnLine, RentalDamage, RentalServiceOrder, RentalDeposit, RentalDepositMovement, RentalCustomerScore, LifecycleEvent`.
  - GIN index on `RentalUnit.attributes`; `RentalBooking` EXCLUDE constraint via `btree_gist` (see M1 SQL below).
- `apps/api/src/kernel/lifecycle/` — `lifecycle.types.ts`, `lifecycle.registry.ts` (mirror `ModuleRegistry` registration), `lifecycle.service.ts` (`transition()` writes `LifecycleEvent` **inside caller's tx** + domain event), `DispositionPolicy` (condition grade → next state table, defaults in code, overridable per org via settings).
- **Tenancy (the critical hand-edit):** add all 19 new models to `ORG_SCOPED` in `apps/api/src/kernel/prisma/tenancy.extension.ts:9`. Add `RentalRate`, `RentalUnit`, `RentalPackage` to `SOFT_DELETE` (`:206`) — matches the menus soft-delete-only rule.
- Migration `pnpm prisma migrate dev --name rental_management`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE "RentalBooking" ADD CONSTRAINT rental_booking_no_overlap
    EXCLUDE USING gist ("organizationId" WITH =, "unitId" WITH =,
      tstzrange("startAt","endAt") WITH &&)
    WHERE ("unitId" IS NOT NULL AND "status" IN ('held','confirmed','active'));
  ```
- Re-run the catalog-driven RLS block (copy `DO $$` from `migrations/20260731093000_rls_all_org_scoped_tables/migration.sql:25`) — it covers new tables automatically.
- **Gate:** `pnpm prisma migrate diff` = 0 drift; `prisma generate` succeeds (**kill node first — OneDrive EPERM on query-engine dll**).

### M2 — GL keys, settings, permissions, fee products (½ day)
- 4 mapping keys in `packages/shared/src/accounting/account-mappings.ts`: `customer_deposit` (current_liability), `rental_income` (revenue), `late_fee_income` (revenue), `damage_recovery_income` (revenue).
- 4 accounts in `apps/api/src/modules/accounting/coa/coa-template.ts` + entries in `COA_MAPPINGS` (`:131`). The required-key spec test is the guard.
- Seed fee products `RENT-LATE`, `RENT-DAMAGE`, `RENT-MISSING`, `RENT-EXTEND` (`productType: fee`, `incomeAccountOverrideId` → mapped accounts). `prepareLines` honours the override → zero new pricing code.
- Widen `SettingGroup` union at `apps/api/src/kernel/settings/setting-registry.ts:21` with `'rental'`; register keys **only when code honours them** (`rental.defaultBufferDays`, `lateFeeGraceHours`, `reservationHoldMinutes`, `depositRequired`, `autoCleaningOnReturn`, `minCustomerScore`, `blockOverdueCustomers`, `overdueEscalationDays`, `dispositionPolicy`).
- **Gate:** `coa-template.spec` green; typecheck clean.

### M3 — Catalog, units, availability (1.5 days)
- `RentalCatalogService` — product-form rental fields, `RentalRate` tier CRUD, `resolveRate(productId, period, units)` (highest-priority band containing units), `RentalPackage` CRUD.
- `RentalUnitService` — CRUD, bulk-generate (`Suit #001..#020`), barcode/QR issue, attribute editing, status transitions via `LifecycleService.transition`, retire → `StockService.adjust` (existing post path).
- `RentalAvailabilityService` — serialized (candidates = status ∈ available/reserved/checked_out, minus overlapping held/confirmed/active bookings), pooled (max-concurrent sweep, **not naive sum**), package (all required components available; per-component response). Advisory lock per `rental:{orgId}:{productId}` inside tx, mirroring `stock.service.ts:82`.
- `RentalLocationConfig` bootstrap: 5 locations `RENT-STOCK` (store) / `RENT-OUT` / `RENT-CLEAN` / `RENT-REPAIR` / `RENT-DAMAGED` (virtual) created via `LocationService` on first use.
- Endpoints: `GET /rental/availability`, `GET /rental/calendar`, `GET /rental/packages/:id/availability`.
- **Specs:** `rental-availability.spec.ts` (non-overlap bookable; overlap rejected; buffer blocks same-day turnaround; pooled max-concurrent ≠ naive sum; cleaning unit excluded; package blocked by one required component).
- **Gate:** availability specs green.

### M4 — Reservation → agreement → checkout + deposit (2 days)
- `RentalReservationService` — hold (writes `RentalBooking` status `held`, `expiresAt = now + holdMinutes`) / confirm / cancel / convert → promotes to `confirmed`.
- `RentalScoreService` — `RentalCustomerScore` from late returns, damage events, lost items, unpaid balance, cancelled reservations; recompute on agreement close + nightly.
- `RentalAgreementService` — `create` (expand package → lines, resolve rates, compute totals + deposit, snapshot terms); `confirm` (approval gate via `approvals.checkOrRequestApproval` — trip when score < min, over credit limit / on creditHold, or open overdue agreement; **add `'rental_agreement'` to `apps/web/src/lib/approval-entity-types.ts`**); `checkout` (one tx: bookings→active, units→checked_out, `StockService.transfer` RENT-STOCK→RENT-OUT, `Order` with `transactionKind: 'rental'`, `generateInvoice`, collect deposit).
- `RentalDepositService` — collect(tender[])/refund/apply/forfeit; each creates `Payment` + `RentalDepositMovement` + posting; cash legs via existing `CashMovement`.
- **The two POS guards** in `apps/api/src/modules/pos/billing/pos-invoice.service.ts`:
  1. Enqueue `StockPostingJob` (`:253`) **excluding lines with `rentalAgreementLineId != null`**; defensively re-filter in `processStockPostingJob` (`:1031`).
  2. `reserveForInvoice` (`:267`) skips rental lines — rentals hold the calendar, not ATP.
- `RentalPostingService` — deposit collect (Dr Cash/Bank/MoMo · Cr `customer_deposit`), refund (reverse), apply (Dr `customer_deposit` · Cr AR via `PaymentAllocation`), forfeit (Dr `customer_deposit` · Cr `damage_recovery_income`). Model on `StockPostingService.postPurchasePayment` (`stock-posting.service.ts:292`).
- **Specs:** `rental-posting.spec.ts` (deposit round-trip balances; rental invoice posts `rental_income` + **no COGS**; mixed cart posts COGS for consumable only); `rental-concurrency.spec.ts` (two parallel checkouts same unit+window → exactly one succeeds); `lifecycle.spec.ts` (illegal transitions rejected; exactly one event per transition; disposition routing).
- **Gate:** all specs green; **live e2e slice**: wedding-dress product w/ sell price + 3-tier rate, 5 units; hold → expire → re-book (overlap refused, next window accepted); checkout → RENT-STOCK fell / RENT-OUT rose / valuation unchanged / garment-bag line did post COGS; deposit split cash+MoMo → `customer_deposit` balance in trial balance.

### M5 — Mid-hire: extension + swap (1 day)
- `RentalExtensionService.extend(agreementLineId, newDueAt)` — availability-check the extended window (can be **blocked** by next booking → return conflict so counter offers swap/refuse), update `RentalBooking.endAt`, price delta from rate card, raise settlement order line against `RENT-EXTEND`.
- `RentalSwapService.swap(agreementLineId, toUnitId, reason)` — check new unit, cancel/create bookings, old unit RENT-OUT→RENT-CLEAN, new unit RENT-STOCK→RENT-OUT, price delta, both lifecycle events. Agreement stays open.
- **Gate:** typecheck + e2e: extend 2 days, swap dress for larger size → bookings + locations follow.

### M6 — Return, inspection, disposition, settlement (2 days)
- `RentalReturnService.receive` — per component line: returned/missing, `lateDays` from line `dueAt` honouring `lateFeeGraceHours`, `lateFeeAmount` from `Product.rentalLateFeePerPeriod`, `DispositionPolicy` → next state, stock move, unit transition, booking complete/release. Partial returns → `partially_returned`.
- `inspect` — condition grade, photos, `RentalDamage` rows w/ charge amounts; missing components charge `rentalReplacementCost`; `waive` requires `rental:waive`.
- `settle` — fees > 0 → settlement `Order` (`transactionKind: 'rental_settlement'`) via `generateInvoice`, apply deposit, refund balance per original tender. Agreement → `closed`; score recomputed.
- `RentalServiceOrderService` — cleaning/repair/alteration; completion → RENT-STOCK + `available`; cost via `ExpensesService` → `expenseId`.
- Audit every state change with `AuditService.recordInTx` (money paths must be in-tx); reuse existing verbs (`reserve, issue, receive, assign, unassign, clean, approve, adjust`) — no enum migration.
- **Gate:** e2e: return 2 days late, 1 missing veil + stain → late fee + replacement + damage charges, settlement invoice, deposit application, per-tender refund; cleaning order → unit `available`, expense posted; trial balance still balances; deposits-held report ties to ledger.

### M7 — POS rental mode (1.5 days)
- Widen `posMode` to `'rental'` in **5 places**: `apps/api/src/modules/pos/pos.controller.ts:199`, `apps/api/src/modules/sync/sync-push.service.ts:317`, `apps/web/src/pages/pos/SettingsPage.tsx:11`, `apps/web/src/pages/settings/DevCompanySettingsPage.tsx:35`, switch at `Terminal.tsx:2047`.
- New `apps/web/src/pages/pos/RentalTerminal.tsx` (template: `RetailTerminal.tsx`). Reuse `OrderPanel` w/ `hideCafeFeatures` + rental props: date-range picker + live availability, rate preview, package picker, deposit tender panel, unit picker / barcode scan, `Checkout & Hand Over`.
- Counter flows: new rental, pickup vs reservation (scan agreement QR), quick return + checklist, extend, swap, deposit refund.
- `apps/web/src/features/rental/api.ts` — react-query hooks (mirror `features/beverage/api.ts`).
- **Gate:** typecheck + web build; manual: terminal boots in rental mode only when flag on.

### M8 — Back-office, notifications, reports, cron (2 days)
- Pages under `apps/web/src/pages/rental/`: `AgreementsPage`, `AgreementDetailPage` (follows **InventoryDetailPage pattern**: breadcrumb → header bar → gradient tab bar → card content `bg-muted/30 border-b rounded-t-lg`; `InfoRow` dl/dt/dd), `ReservationsCalendarPage`, `UnitsPage`, `UnitDetailPage` (lifecycle history + profitability), `PackagesPage`, `ReturnsInspectionPage`, `ServiceOrdersPage`, `DepositsPage`, `CustomerScorePage`, `RentalReportsPage`. Reuse `@/components/data-table`, `@/lib/format`, `@/lib/export-csv`.
- Routes `apps/web/src/App.tsx:164`; nav in `apps/web/src/components/layout/app-shell.tsx:87` with `flag: 'VITE_ENABLE_RENTAL'` — **widen the union at `app-shell.tsx:84`**.
- `RentalCronWorker` (follow `kernel/workers/cron-workers.service.ts`): 5-min hold expiry; hourly overdue + escalation; daily 08:00 due-tomorrow/pickup/cleaning nudges; nightly score recompute. Fan out via `NotificationsService.send` (approvals-notifications subscriber pattern).
- Reports as query service + `@Get('reports/*')` on rental controller (inventory.controller pattern): most-rented, rental revenue, **utilization %** (rented days ÷ available days), late returns, damage cost, deposits held (must tie to `customer_deposit` balance), outstanding rentals, per-item profitability (`lifetimeRevenue − acquisitionCost − cleaning − repair`), cleaning/repair cost, score distribution.
- Customer rental history endpoint (extends `pos-customer-statement.controller.ts` derived-statement pattern).
- **Gate:** full verification suite below.

---

## Full verification (end of M8)

1. `pnpm --filter @erp/shared build && pnpm --filter api typecheck && pnpm --filter web typecheck && pnpm --filter web build && pnpm lint:arch` — **0 compile errors = hard deploy gate**.
2. `pnpm --filter api test` — new specs: availability, posting, concurrency, lifecycle (as listed above).
3. `pnpm --filter api test -- coa-template.spec` — 4 new keys have template accounts.
4. `pnpm prisma migrate diff` → 0 drift.
5. Live e2e with `ENABLE_RENTAL=true` / `VITE_ENABLE_RENTAL=true`, `PORT=3001 pnpm dev:api` — full lifecycle from the M4/M6 slices plus: retail terminal still sells the same product normally; trial balance balances; deposits report ties to ledger. **Run the flow twice** (flag off → confirm cafe/retail unaffected; flag on → rental works).
6. Playwright E2E at `C:\Users\Simon\pos-e2e` (standalone — repo-root install fails; reuse storageState, **never per-test login** — `/auth/login` throttled 10/5min; `text=` engine never matches anchored `^` regexes).

## Repo-specific gotchas

- **OneDrive + prisma generate:** throws EPERM when a node process holds the query-engine dll — kill node first, then generate.
- **Stale dist servers keep ports:** restart after `nest build`; Windows bg-kill orphans child — `netstat -ano | grep LISTENING` + `taskkill -F -PID`.
- **`ORG_SCOPED` is hand-maintained** — the silent cross-tenant leak list. Adding all 19 models there is mandatory, not optional.
- **Do not add `rental` to `OrderType`** — `dine_in/takeaway/delivery` is the service-mode axis; `SaleKind` is the transaction-kind axis.
- **Do not extend `SerialStatus`** with `cleaning/checked_out` — that would break issue/receive for every other product; status lives on `RentalUnit`.
- **`btree_gist` extension** must be in the migration AND available on prod (local PG18 + docker-compose fine; managed cloud PG needs `CREATE EXTENSION` privileges).
- Line numbers in the source design drift — reference symbols.

## Out of scope (this build)

Fixed-asset/depreciation linkage (`RentalUnit.assetId` added, unread), delivery/pickup task assignment, RFID, customer self-booking portal, subscriptions/long-term leases with recurring billing, dynamic pricing. Seams preserved: loyalty accrues via existing invoice-posted event; future Repairs module reuses `custody.*` lifecycle by registering a second definition.

## Open questions for you

1. **Scope of first delivery:** full 8 milestones, or land M0–M4 first (till can hold/checkout/collect deposit) and M5–M8 in a second pass? The flag makes either safe.
2. **Deposit default:** `rental.depositRequired` — always require, or product-level default?
3. **Currency/formatting:** IDR throughout (existing context) — confirm fee product seed prices are placeholders to be set per org.

---

*Saved per plan-mode. Ready to execute — see chat reply for the milestone summary.*
