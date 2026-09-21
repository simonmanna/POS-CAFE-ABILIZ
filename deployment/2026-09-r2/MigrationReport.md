# Account mapping report

Generated 2026-09-17T19:50:21.522Z (apply)

- accounts: **29**
- from template: **24**
- group nodes (categoryId NULL, isPostable false): **5**
- from type map: 0
- already categorized: 0
- **unmapped postable: 0**
- needs review (coarse old type): 0

| Code | Name | Old type | New category | Normal balance | Postable | Control | Source |
|---|---|---|---|---|---|---|---|
| 1000 | Assets | asset | (none - group) | debit | false | - | template-group |
| 1100 | Cash | cash | cash | debit | true | - | template |
| 1200 | Bank | bank | bank | debit | true | - | template |
| 1300 | Accounts Receivable | receivable | receivable | debit | true | ar | template |
| 1400 | Inventory / Stock Valuation | asset | inventory | debit | true | inventory | template |
| 1450 | Input VAT Receivable | asset | current_asset | debit | true | - | template |
| 1900 | Cash Clearing (Suspense) | asset | current_asset | debit | true | - | template |
| 2000 | Liabilities | liability | (none - group) | debit | false | - | template-group |
| 2100 | Accounts Payable | payable | payable | credit | true | ap | template |
| 2150 | Goods Received Not Invoiced (GRNI) | liability | current_liability | credit | true | - | template |
| 2200 | Tax Payable | tax | tax | credit | true | - | template |
| 2300 | Store Credit Liability | liability | current_liability | credit | true | - | template |
| 3000 | Equity | equity | (none - group) | debit | false | - | template-group |
| 3100 | Retained Earnings | equity | equity | credit | true | - | template |
| 4000 | Revenue | revenue | (none - group) | debit | false | - | template-group |
| 4100 | Sales Revenue | revenue | revenue | credit | true | - | template |
| 4200 | Stock Adjustment Income | revenue | other_income | credit | true | - | template |
| 4900 | Sales Discounts | revenue | contra_revenue | debit | true | - | template |
| 5000 | Expenses | expense | (none - group) | debit | false | - | template-group |
| 5100 | Cost of Goods Sold | cost_of_goods_sold | cost_of_goods_sold | debit | true | - | template |
| 5200 | Operating Expenses | expense | operating_expense | debit | true | - | template |
| 5300 | Stock Adjustment Expense | expense | operating_expense | debit | true | - | template |
| 5400 | Cash Short & Over | expense | operating_expense | debit | true | - | template |
| 5500 | Bad Debt Expense | expense | operating_expense | debit | true | - | template |
| BANK-DEFAULT | Bank Account 1 | bank | bank | debit | true | - | template |
| CASH-DEFAULT | Cash Drawer | cash | cash | debit | true | - | template |
| MOMO-AIRTEL | Airtel Money | mobile_money | mobile_money | debit | true | - | template |
| MOMO-MTN | MTN Mobile Money | mobile_money | mobile_money | debit | true | - | template |
| PETTY | Petty Cash | petty_cash | petty_cash | debit | true | - | template |