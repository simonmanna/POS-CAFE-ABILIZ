# Stage 1: money integrity and recovery

Implemented on 3 September 2026. Scope: F01–F09, F17 and F18 from [the original audit](POS_WORKFLOW_UI_READINESS_2026-09-03.md), including separate drawer, bank, card, wallet and customer-credit accounting. Existing working-tree changes were preserved.

**Release assessment: Stage 1 implementation is ready for staging acceptance. The whole POS is not yet certified for production deployment.** The remaining kitchen/inventory findings, runtime tenant isolation, dependency remediation, historical-account review and hardware acceptance remain release gates. No migration was applied to the business database and no live deployment was performed.

## What changed

| Finding | Implemented correction |
| --- | --- |
| F01 — compilation | Repaired the POS component contract and outdated test fixture types. Production build and typecheck results are recorded below. |
| F02 — tender routing | Shared account resolver for POS settlement, invoice collections and linked refunds. Cash uses the selected register account; bank uses a named bank; mobile money uses a named wallet; card uses a bank or configured clearing account. Unsupported/inactive/wrong-currency accounts fail explicitly. Invoices record their original AR account; collections clear that account even if mappings later change. |
| F03 — store credit | Balance locking, availability checks, redemption ledger, allocation and payment occur in the same transaction. Concurrent redemptions cannot overspend the balance. A linked refund restores the original prepaid balance. House-account credit remains a separate receivable. |
| F04 — pricing and authorization | Server catalog/menu/variant/modifier/accompaniment prices; common line/order discount calculation; server quotes and expected total/version checks. Discount rights, reasons and manager threshold checked when billing. Scoped approval grants bind the manager approval to the cashier, organization, operation and payload. Refund/write-off authorization strengthened. Manual price editing is disabled. |
| F05–F06 — refunds | Full and partial refunds use one transaction and reference original payments/allocations/accounts. Duplicate, negative and excess item quantities are rejected. Cumulative refund caps are enforced. Stock disposition is explicit and separate from the financial reversal. |
| F07 — compensation | Removed cancellation/refund compensation from failed checkout and split settlement. Durable business outcomes/checkpoints commit with business writes. Lost responses replay the original result. Split order, invoice, payments and bill status commit atomically. |
| F08 — displayed price | Quote, saved order and invoice use the shared discount/tax calculation. Inclusive VAT is recalculated after discounts. Saved fixed discounts and order discounts survive resume. |
| F09 — unsaved work | Failed saves and version conflicts preserve the cart and block settlement/navigation/split progression. Removed overwrite-on-conflict fallback. Cart signatures include discount/customer context; navigation checks for edits made during save/fetch. Resume restores customer, variants, accompaniments, modifiers, discounts and course. |
| F17 — cash day | Explicit register/cashier, counted float funding, account-backed movements/deposits, physical-cash reconciliation, named financial-account observations, pending-work close gates, variance approval, immutable Z-report and period-close gates. Separate provider settlement records include fees and settlement dates. |
| F18 — recovery | Write-ahead, immutable, organization/operator/terminal-bound sale envelopes; original timestamps/keys; completed-response recovery; proven rejection evidence. Durable cash-operation keys without stored PINs. Cart survives browser restart and operator switching. One active POS tab per browser profile prevents concurrent cart overwrite. |

The core changes are in `apps/api/src/modules/pos/pricing-policy.ts`, `apps/api/src/modules/accounting/treasury/tender-account.ts`, `apps/api/src/modules/pos/billing/refund-operation.ts`, `apps/api/src/modules/accounting/treasury/session-reconciliation.ts` and `apps/api/src/kernel/idempotency/business-outcome.ts`. Browser recovery is in `apps/web/src/features/pos/`.

## Cash operating procedure

1. Configure a distinct physical-cash account for each register. Open the chosen register with a named cashier and counted float. If money is introduced from a safe/bank, select its source account so the transfer is posted. Do not give two live drawers the same ledger account.
2. Select the actual receiving account for each tender. For example, create **Airtel Money — Cafe**, **MTN Mobile Money — Cafe**, **Bank — Operating**, and a separate **Card clearing** account where relevant. The application does not create fictitious provider balances.
3. Record pay-ins, expenses/pay-outs, safe drops and deposits with the appropriate counterpart account and reason. A drawer transfer to another open drawer is rejected rather than creating an unpaired movement.
4. Refund against the original payment chain. Choose `no_return`, `waste` or a supported `restock` disposition. Prepared menu items are not automatically turned back into ingredients. Batch/serial or ambiguous inventory returns require the dedicated stock-return workflow.
5. Resolve open orders, unpaid non-credit invoices, stock-posting failures and unsynced/uncertain payments before close. Compare the physical count with expected physical cash, not total sales. Opening/closing wallet and bank observations are recorded separately; they do not silently adjust the ledger.
6. In Financial Accounts, record the provider statement settlement with source wallet/clearing account, destination bank, gross amount, fee expense, provider reference and date. A later settlement can be posted after drawer reconciliation, subject to its own accounting period. This is manual statement reconciliation; it is not an Airtel/MTN/card-provider API connection.
7. Approve variances with the appropriate independent authority, reconcile the session, and close/lock the accounting period after its outstanding sessions are resolved. Retain the frozen Z-report. Corrections after the report is frozen belong to later authorized transactions.

The expected drawer calculation is:

`opening float + cash receipts + cash pay-ins + adjustments - cash refunds - cash pay-outs`

Card/mobile-money/store-credit collections do not increase this amount. The close check also compares payment accounts and original AR allocations against journal lines, and checks drawer movements against those payments. Balanced journal debits and credits alone do not pass reconciliation.

## Configuration and migration

- Review `20260903000000_pos_money_foundations` before deployment. It adds original-account/refund/session links, refund caps, approval grants, provider settlements and operation identifiers. Apply it through the normal migration process after a verified backup and staging rehearsal. Prisma client generation is required with this schema.
- Set `accounts_receivable`, sales/tax mappings, `store_credit`, `cash_short_over`, and applicable `card_clearing` / `mobile_money` mappings. Use actual named bank/wallet accounts in the payment selector; cash is determined by the register. Required journals must exist.
- POS tender accounts currently use the organization currency. Foreign-currency conversion belongs in treasury before a POS tender is recorded.
- Configure discount approval and cashier/manager permissions. Cashiers must not be able to approve their own reconciliation/variance where separation is required.
- Serve the POS over HTTPS (localhost is acceptable for development). The single-tab safeguard requires browser Web Locks. Preserve browser storage until pending operations are resolved; deleting it destroys the local recovery evidence.
- The migration only backfills a payment's drawer session when its existing movements identify exactly one session. It deliberately does not guess historical AR, revenue or tax accounts. Legacy invoices without verified account snapshots are blocked from affected collection/refund routes until reviewed against their original journals.

A read-only inventory is available with:

```text
pnpm audit:pos:preflight --organization <organization-id>
```

It uses `DATABASE_URL` or the API environment configuration, and reports legacy invoice account gaps, invalid payments, ambiguous drawer links, shared register accounts, unresolved operations, pending stock postings, account mappings and RLS posture. It makes no corrections and does not approve a release. Legacy invoice and pending-stock samples are limited to 100; also inspect browser-local queues and actual provider statements.

## Verification

- Migration deployed successfully to an isolated `pos_stage1_<digits>` PostgreSQL database. No business data was copied into the fixtures. The source database was not reset or migrated.
- Stage 1 API regression run: **51 suites, 416 tests passed**. This includes source unit tests and two real PostgreSQL integration suites.
- Monetary integration evidence: named cash/card/Airtel routing and original AR; actual float transfer; concurrent store-credit redemption; invalid/partial/full mixed-tender refunds; provider fee/net settlement and oversettlement rejection; cash-only count; post-close payment rejection; immutable Z-report after later provider settlement.
- Sale pipeline evidence: counter order/invoice/receipt/GL, cash change, saved-order settlement, discounted inclusive VAT, draft discount save/resume and atomic split settlement. Rejected split tender creates no invoice; repeating the paid split returns the existing result.
- Browser recovery tests cover immutable/concurrent enqueue, original payload/time, background completion and rejection, tenant/operator isolation, pending-cart locking, customer/item/discount restoration, cash-operation and credit-collection retry keys, and exclusion of PINs from persistent recovery.
- Read-only preflight SQL verified on a synthetic organization in the isolated migrated database.
- Final build, typecheck and browser test results are recorded after the final verification run.

Reproduce the scoped API gate by setting `POS_TEST_DATABASE_URL` to a **migrated disposable database named `pos_stage1_<digits>`**, then running `pnpm test:pos:stage1`. The runner refuses a business-database name. Run `pnpm test:pos:recovery`, `pnpm typecheck` and `pnpm build` for the remaining gates.

The broader legacy integration suite is not all green: unrelated ERP/KDS fixtures still need tenant/RLS-aware modernization. The Stage 1 PostgreSQL pipeline uses an explicitly tenant-scoped fixture client; it does not prove production request-to-database tenant context. Automated browser-storage tests do not replace authenticated browser or hardware acceptance.

## Required before a production pilot

1. Complete the remaining audit findings for the intended deployment profile: kitchen lifecycle/dispatch/visibility (F10–F12), menu combos and inventory semantics/transactions (F13–F16), retail scale/scanning (F19), runtime RLS/packaging (F20), dependencies (F21), and any required fiscal integration (F22).
2. In particular, verify production Prisma connections propagate the tenant context for standalone reads/raw queries as well as interactive transactions, using the actual non-bypass application role. The existing RLS setup needs a separate deployment correction and acceptance test. Do not enable policies blindly or use a privileged database role to hide this gap.
3. Review and repair historical monetary records using original journals, allocations, receipts and provider evidence. Do not reinterpret all old sales as drawer cash. Sign off the register/provider opening balances.
4. Apply the migration to staging and execute an authenticated cashier/manager acceptance day: mixed tenders, credit and store credit, lost payment responses, browser restart, stale saved order, partial/full refunds, safe drop/deposit, variance approval, late provider fees, close, reconciliation and period lock. Repeat with the actual printer, cash drawer, scanner and kitchen devices.
5. Complete backup restoration, deployment rollback, queue monitoring and dependency/security remediation. Resolve all unknown/indeterminate monetary operations before cutover.

Combo selling is intentionally paused and manual price overrides are disabled while their safe behavior is unfinished. These restrictions prevent the old divergent paths from silently charging incorrect amounts; they are not a claim that the remaining selling functionality has been completed.
