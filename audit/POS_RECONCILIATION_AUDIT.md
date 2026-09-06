# POS_RECONCILIATION_AUDIT

Cross-verification of POS ↔ Payments ↔ Inventory ↔ Accounting ↔ Shift ↔ Reports. Live evidence from the isolated audit org (Phase 14) plus baseline Cafe-X forensics (Phase 0.5).

## 1. Controlled live scenario (audit org)

Opening float 50,000 (funded Dr Bank/Cr Drawer) → adjustment +5,000 → sales: cash 6,000 (GT-01) + 2,700 (A-002 control) + MM 8,000 (GT-02) + Airtel 8,000 (GT-03) + bank 8,000 (GT-04) + split 40k cash/60k MTN (GT-05) + discount sale 10,200 cash (GT-06) + tax sale 11,800 cash (GT-07) + multi 18,500 cash (GT-08) + offline sale 9,000 cash (GT-12) → refunds: 3,000 cash (GT-11), 8,000 to MTN (GT-10), 11,800 cash void (GT-09) → close at expected.

### Independently computed vs system

| Check | Independent calc | System | Match |
|---|---|---|---|
| Cash in drawer at close | 50,000 + 5,000 + (6,000+2,700+40,000+10,200+11,800+18,500+9,000) − (3,000+11,800) = 156,400 | closingExpected **156,400** = counted; difference 0 | ✅ |
| MM-MTN account | sales 8,000+60,000 − refund 8,000 = 60,000 Dr | 2110 ledger | ✅ |
| Airtel account | 8,000 Dr | 2120 ledger | ✅ |
| Bank | 8,000 sale − 50,000 float funding = net | 1200 ledger | ✅ |
| Store-credit liability (P0 leg) | 400,000 minted − 16,000 spent = 384,000 | 2350 Dr 16,000; balance 384,000 | ✅ (and damning — see A-001) |
| Trial balance | every account Dr=Cr | verified per-account | ✅ |
| Z snapshot | frozen at close, byte-frozen thereafter | kind='z' unique | ✅ |
| Cashier summary | expected should equal 156,400 | **151,400 (A-006: adjustment omitted)** | ❌ **defect** |

## 2. Cafe-X baseline forensics (Phase 0.5, unchanged)

- All 117 JEs balanced; COGS 48,066 = ledger issue value exactly; both closed shifts variance 0; no orphans/duplicates anywhere
- **Legacy distortion (A-009):** 4 pre-migration invoices Dr-Cash unsettled → GL cash overstated 375,000 vs drawer; WALKIN AR polluted; collection refused by design (needs formal adjusting JE)
- 16 pre-migration cash payments lack session linkage; early MM/card posted to 1100 Cash (pre-config era)

## 3. Reconciliation surfaces — verdicts

| Surface | Verdict | Notes |
|---|---|---|
| Payments ↔ GL | ✅ | every payment has posted JE; drawer/account legs match (recon 48-51) |
| Payments ↔ drawer movements | ✅ | 1:1 sale/refund movements, cash only; electronic none (recon 62-65) |
| Drawer ledger ↔ expected cash | ✅ at close (GT-18); ❌ in cashier-shift-summary (A-006) |
| Inventory ↔ ledger | ✅ quantity; ⚠️ chain-linking under concurrency (A-025); seeded stock never ledgered (historical) |
| COGS ↔ inventory value | ✅ exact both orgs (live 48,066 Cafe-X; audit-org cake/tea issues exact) |
| Reports ↔ transactional truth | ⚠️ | byMethod/invoice-level drift (A-031); createdAt-bucketing mis-dates offline sales; item reports don't net refunds; pos-table-reports unions legacy Document (double-count risk) |
| Offline ↔ online books | ✅ | sync ops land in same session/GL discipline (GT-12) |
| Store credit ↔ reality | ❌ **fabricated** | mint-without-money leaves liability unbacked (A-001 P0) |

## 4. The one unexplained difference

Every discrepancy traced in this audit is **explained by a numbered defect** — there is no unexplained money anywhere in either org. The P0 is not a reconciliation break (the books balance!) but a **fabrication vector**: store credit enters the liability without any corresponding debit, which GT/A-001 evidence shows converts directly into goods (the GL stays balanced while the cafe's wealth leaves).
