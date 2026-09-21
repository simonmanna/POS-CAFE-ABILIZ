package com.poscafe.pos.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import com.poscafe.pos.data.local.entity.ExpenseCategoryEntity
import com.poscafe.pos.data.local.entity.LedgerAccountEntity
import com.poscafe.pos.data.local.entity.PaymentMethodEntity
import com.poscafe.pos.data.local.entity.StockLevelEntity
import com.poscafe.pos.data.local.entity.StockLocationEntity
import kotlinx.coroutines.flow.Flow

/**
 * Server-owned cash & inventory reference data. The config-shaped scopes arrive
 * as full snapshots, so each is replaced wholesale ([replacePaymentMethods] …);
 * stock levels arrive as deltas and are upserted.
 */
@Dao
interface CashInventoryDao {
    // ---- payment methods ----
    @Query("SELECT * FROM payment_methods ORDER BY sortOrder, label")
    suspend fun paymentMethods(): List<PaymentMethodEntity>

    @Query("SELECT * FROM payment_methods ORDER BY sortOrder, label")
    fun paymentMethodsFlow(): Flow<List<PaymentMethodEntity>>

    @Query("DELETE FROM payment_methods") suspend fun clearPaymentMethods()
    @Upsert suspend fun upsertPaymentMethods(rows: List<PaymentMethodEntity>)

    @Transaction
    suspend fun replacePaymentMethods(rows: List<PaymentMethodEntity>) {
        clearPaymentMethods(); upsertPaymentMethods(rows)
    }

    // ---- ledger accounts ----
    @Query("SELECT * FROM ledger_accounts ORDER BY code")
    suspend fun accounts(): List<LedgerAccountEntity>

    @Query("SELECT * FROM ledger_accounts WHERE id = :id")
    suspend fun account(id: String): LedgerAccountEntity?

    @Query("DELETE FROM ledger_accounts") suspend fun clearAccounts()
    @Upsert suspend fun upsertAccounts(rows: List<LedgerAccountEntity>)

    @Transaction
    suspend fun replaceAccounts(rows: List<LedgerAccountEntity>) {
        clearAccounts(); upsertAccounts(rows)
    }

    // ---- expense categories ----
    @Query("SELECT * FROM expense_categories ORDER BY name")
    fun expenseCategories(): Flow<List<ExpenseCategoryEntity>>

    @Query("SELECT * FROM expense_categories WHERE id = :id")
    suspend fun expenseCategory(id: String): ExpenseCategoryEntity?

    @Query("DELETE FROM expense_categories") suspend fun clearExpenseCategories()
    @Upsert suspend fun upsertExpenseCategories(rows: List<ExpenseCategoryEntity>)

    @Transaction
    suspend fun replaceExpenseCategories(rows: List<ExpenseCategoryEntity>) {
        clearExpenseCategories(); upsertExpenseCategories(rows)
    }

    // ---- stock locations ----
    @Query("SELECT * FROM stock_locations ORDER BY code")
    suspend fun locations(): List<StockLocationEntity>

    @Query("DELETE FROM stock_locations") suspend fun clearLocations()
    @Upsert suspend fun upsertLocations(rows: List<StockLocationEntity>)

    @Transaction
    suspend fun replaceLocations(rows: List<StockLocationEntity>) {
        clearLocations(); upsertLocations(rows)
    }

    // ---- stock levels ----
    @Upsert suspend fun upsertStockLevels(rows: List<StockLevelEntity>)

    @Query("SELECT * FROM stock_levels WHERE locationId = :locationId AND variantId IS NULL")
    fun stockAt(locationId: String): Flow<List<StockLevelEntity>>

    @Query("SELECT * FROM stock_levels WHERE locationId = :locationId AND variantId IS NULL")
    suspend fun stockAtNow(locationId: String): List<StockLevelEntity>

    @Query("SELECT * FROM stock_levels WHERE locationId = :locationId AND productId = :productId AND variantId IS NULL LIMIT 1")
    suspend fun stockOf(locationId: String, productId: String): StockLevelEntity?
}
