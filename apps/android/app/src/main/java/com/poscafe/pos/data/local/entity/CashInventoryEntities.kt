package com.poscafe.pos.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Cash & inventory reference data pulled from the server (sync scopes
 * `paymentMethods`, `ledgerAccounts`, `expenseCategories`, `stockLocations`,
 * `stockLevels`). Server-owned: the device never authors these rows, it only
 * reads them to build ops the server will accept (tender accounts, movement
 * counterparts, float funding sources, stock locations).
 */

/** A terminal payment tile, as the web terminal shows it. */
@Entity(tableName = "payment_methods")
data class PaymentMethodEntity(
    @PrimaryKey val id: String,
    val code: String,
    val label: String,
    /** cash | card | mobile_money | bank | store_credit — the tender `method`. */
    val kind: String,
    /** Receiving account; null for cash (the drawer) and unconfigured tiles. */
    val accountId: String?,
    val accountName: String?,
    val requiresReference: Boolean,
    /** Counted at shift close (closingAccounts) — electronic wallets, not cash. */
    val trackInShift: Boolean,
    val sortOrder: Int,
)

/**
 * A GL account the till may book cash against. [roles] is comma-joined:
 * drawer, cash_short_over, default_expense, float_source, pay_in, pay_out,
 * expense_payment — the server's own eligibility rules, pre-evaluated.
 */
@Entity(tableName = "ledger_accounts")
data class LedgerAccountEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
    val categoryKey: String?,
    val classification: String?,
    val isCashEquivalent: Boolean,
    /** Ledger balance at last pull (cash-equivalent accounts only). */
    val balance: Double?,
    val roles: String,
) {
    fun has(role: String): Boolean = role in roles.split(',')
    val label: String get() = "$code · $name"
}

@Entity(tableName = "expense_categories")
data class ExpenseCategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** The expense account a drawer pay-out for this category debits. */
    val accountId: String?,
)

@Entity(tableName = "stock_locations")
data class StockLocationEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
    val type: String,
)

/** Server on-hand per product (non-variant rows only) and location. */
@Entity(tableName = "stock_levels", indices = [Index("productId"), Index("locationId")])
data class StockLevelEntity(
    @PrimaryKey val id: String,
    val productId: String,
    val variantId: String?,
    val locationId: String,
    val quantity: Double,
    val updatedAt: Long,
)
