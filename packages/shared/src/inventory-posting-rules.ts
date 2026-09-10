import type { InventoryMovementType } from './enums';

/**
 * Canonical default inventory posting rules.
 *
 * One source of truth shared by org bootstrap (OrganizationsService) and the
 * operator-facing "restore defaults" action on the Posting Rules screen. Orgs
 * created before the rule engine existed have an EMPTY rule table, which makes
 * every valued inventory movement throw "No posting rule configured" at post
 * time — restoring these defaults is what makes such an org postable again.
 *
 * Each entry is a movement-type default (no productId/categoryId), resolved
 * through AccountMapping keys so a single mapping change re-points every rule.
 */
export interface DefaultPostingRule {
  movementType: InventoryMovementType;
  lineIndex: number;
  debitOrCredit: 'debit' | 'credit';
  accountSource: 'account_mapping' | 'literal' | 'category_field' | 'product_field';
  accountMappingKey: string;
}

export const DEFAULT_INVENTORY_POSTING_RULES: readonly DefaultPostingRule[] = [
  // STOCK_IN (e.g. purchase receipt) → Dr Stock Valuation / Cr GRNI
  { movementType: 'STOCK_IN', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'STOCK_IN', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'grni_accrued' },
  // STOCK_OUT (e.g. sale/issue) → Dr COGS / Cr Stock Valuation
  { movementType: 'STOCK_OUT', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'cogs' },
  { movementType: 'STOCK_OUT', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // RETURN_RESTOCK (customer return) → Dr Stock Valuation / Cr COGS
  { movementType: 'RETURN_RESTOCK', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'RETURN_RESTOCK', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'cogs' },
  // ADJUSTMENT_GAIN (positive count diff) → Dr Stock Valuation / Cr Adj Income
  { movementType: 'ADJUSTMENT_GAIN', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'ADJUSTMENT_GAIN', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_adjustment_income' },
  // ADJUSTMENT_LOSS (negative count diff) → Dr Adj Expense / Cr Stock Valuation
  { movementType: 'ADJUSTMENT_LOSS', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_adjustment_expense' },
  { movementType: 'ADJUSTMENT_LOSS', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // WASTE → Dr Adj Expense / Cr Stock Valuation
  { movementType: 'WASTE', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_adjustment_expense' },
  { movementType: 'WASTE', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // EXPIRY_WRITE_OFF → Dr Expiry / Cr Stock Valuation (uses category_field fallback)
  { movementType: 'EXPIRY_WRITE_OFF', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'category_field', accountMappingKey: 'stock_adjustment_expense' },
  { movementType: 'EXPIRY_WRITE_OFF', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // INTERNAL_CONSUMPTION → Dr Internal Use / Cr Stock Valuation (uses category_field fallback)
  { movementType: 'INTERNAL_CONSUMPTION', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'category_field', accountMappingKey: 'stock_adjustment_expense' },
  { movementType: 'INTERNAL_CONSUMPTION', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // PROMO_SAMPLE → Dr Promo Expense / Cr Stock Valuation (uses category_field fallback)
  { movementType: 'PROMO_SAMPLE', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'category_field', accountMappingKey: 'stock_adjustment_expense' },
  { movementType: 'PROMO_SAMPLE', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // STOCK_TRANSFER — same account both sides, so the JE nets to zero by design.
  { movementType: 'STOCK_TRANSFER_OUT', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'STOCK_TRANSFER_OUT', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'STOCK_TRANSFER_IN', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'STOCK_TRANSFER_IN', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // RETURN_TO_SUPPLIER → Dr GRNI / Cr Stock Valuation
  { movementType: 'RETURN_TO_SUPPLIER', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'grni_accrued' },
  { movementType: 'RETURN_TO_SUPPLIER', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // PRODUCTION_CONSUME → Dr WIP / Cr Stock Valuation
  { movementType: 'PRODUCTION_CONSUME', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'wip' },
  { movementType: 'PRODUCTION_CONSUME', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  // PRODUCTION_OUTPUT → Dr Stock Valuation / Cr WIP
  { movementType: 'PRODUCTION_OUTPUT', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'PRODUCTION_OUTPUT', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'wip' },
  // REVALUATION → Dr/Cr Stock Valuation / Dr/Cr Revaluation Surplus
  { movementType: 'REVALUATION', lineIndex: 0, debitOrCredit: 'debit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
  { movementType: 'REVALUATION', lineIndex: 1, debitOrCredit: 'credit', accountSource: 'account_mapping', accountMappingKey: 'stock_valuation' },
];
