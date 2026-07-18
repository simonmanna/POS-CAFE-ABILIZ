package com.poscafe.pos.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import com.poscafe.pos.data.local.entity.*
import kotlinx.coroutines.flow.Flow

@Dao
interface MenuDao {
    @Query("SELECT * FROM menu_categories WHERE isActive = 1 ORDER BY sortOrder")
    fun categories(): Flow<List<MenuCategoryEntity>>

    @Query("SELECT * FROM menu_items WHERE isAvailable = 1 AND (:categoryId IS NULL OR categoryId = :categoryId) ORDER BY displayOrder, name")
    fun items(categoryId: String?): Flow<List<MenuItemEntity>>

    @Query("SELECT * FROM menu_item_variants WHERE menuItemId = :menuItemId AND isActive = 1 ORDER BY sortOrder")
    suspend fun variants(menuItemId: String): List<MenuItemVariantEntity>

    @Query(
        "SELECT mg.* FROM modifier_groups mg JOIN menu_item_modifier_groups j ON j.modifierGroupId = mg.id " +
            "WHERE j.menuItemId = :menuItemId AND mg.isActive = 1 ORDER BY j.sortOrder",
    )
    suspend fun modifierGroupsFor(menuItemId: String): List<ModifierGroupEntity>

    @Query("SELECT * FROM modifiers WHERE groupId = :groupId AND isActive = 1 ORDER BY sortOrder")
    suspend fun modifiers(groupId: String): List<ModifierEntity>

    @Query(
        "SELECT ag.* FROM accompaniment_groups ag JOIN menu_item_accompaniment_groups j ON j.accompanimentGroupId = ag.id " +
            "WHERE j.menuItemId = :menuItemId AND ag.isActive = 1 ORDER BY j.sortOrder",
    )
    suspend fun accompanimentGroupsFor(menuItemId: String): List<AccompanimentGroupEntity>

    @Query("SELECT * FROM accompaniment_options WHERE groupId = :groupId AND isActive = 1 ORDER BY sortOrder")
    suspend fun accompanimentOptions(groupId: String): List<AccompanimentOptionEntity>

    @Query("SELECT * FROM accompaniment_options WHERE id IN (:ids)")
    suspend fun accompanimentOptionsByIds(ids: List<String>): List<AccompanimentOptionEntity>

    @Query("SELECT * FROM menu_items WHERE id = :id")
    suspend fun itemById(id: String): MenuItemEntity?

    @Query("SELECT * FROM menu_items ORDER BY displayOrder, name")
    fun allItemsIncludingUnavailable(): Flow<List<MenuItemEntity>>

    @Query("SELECT * FROM menu_categories ORDER BY sortOrder")
    fun allCategoriesIncludingInactive(): Flow<List<MenuCategoryEntity>>

    @Query("SELECT name FROM menu_categories WHERE id = :id")
    suspend fun categoryName(id: String): String?

    @Query("SELECT * FROM taxes WHERE id = :id")
    suspend fun tax(id: String): TaxEntity?

    // -- pull-apply (wholesale upserts; aggregate children replaced per item) --
    @Upsert suspend fun upsertCategories(rows: List<MenuCategoryEntity>)
    @Upsert suspend fun upsertItems(rows: List<MenuItemEntity>)
    @Upsert suspend fun upsertVariants(rows: List<MenuItemVariantEntity>)
    @Upsert suspend fun upsertModifierGroups(rows: List<ModifierGroupEntity>)
    @Upsert suspend fun upsertModifiers(rows: List<ModifierEntity>)
    @Upsert suspend fun upsertItemModifierJoins(rows: List<MenuItemModifierGroupEntity>)
    @Upsert suspend fun upsertAccompanimentGroups(rows: List<AccompanimentGroupEntity>)
    @Upsert suspend fun upsertAccompanimentOptions(rows: List<AccompanimentOptionEntity>)
    @Upsert suspend fun upsertItemAccompanimentJoins(rows: List<MenuItemAccompanimentGroupEntity>)
    @Upsert suspend fun upsertTaxes(rows: List<TaxEntity>)

    @Query("DELETE FROM menu_item_variants WHERE menuItemId = :menuItemId") suspend fun clearVariants(menuItemId: String)
    @Query("DELETE FROM menu_item_modifier_groups WHERE menuItemId = :menuItemId") suspend fun clearItemModifierJoins(menuItemId: String)
    @Query("DELETE FROM menu_item_accompaniment_groups WHERE menuItemId = :menuItemId") suspend fun clearItemAccompanimentJoins(menuItemId: String)
    @Query("DELETE FROM menu_items WHERE id = :id") suspend fun deleteItem(id: String)
    @Query("DELETE FROM menu_categories WHERE id = :id") suspend fun deleteCategory(id: String)
    @Query("DELETE FROM modifier_groups WHERE id = :id") suspend fun deleteModifierGroup(id: String)
    @Query("DELETE FROM taxes WHERE id = :id") suspend fun deleteTax(id: String)
}

@Dao
interface StaffDao {
    @Query("SELECT * FROM staff WHERE isActive = 1")
    suspend fun all(): List<StaffEntity>

    @Query("SELECT * FROM staff WHERE id = :id")
    suspend fun byId(id: String): StaffEntity?

    @Upsert suspend fun upsertAll(rows: List<StaffEntity>)
    @Query("DELETE FROM staff WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface TableDao {
    @Query("SELECT * FROM pos_tables ORDER BY sortOrder, number")
    fun tables(): Flow<List<PosTableEntity>>

    @Upsert suspend fun upsertAll(rows: List<PosTableEntity>)
    @Query("DELETE FROM pos_tables WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface RegisterDao {
    @Query("SELECT * FROM cash_registers")
    suspend fun all(): List<CashRegisterEntity>

    @Upsert suspend fun upsertAll(rows: List<CashRegisterEntity>)
}

@Dao
interface SettingsDao {
    @Query("SELECT * FROM settings WHERE `key` = :key")
    suspend fun byKey(key: String): SettingEntity?

    @Upsert suspend fun upsertAll(rows: List<SettingEntity>)
}

@Dao
interface SyncStateDao {
    @Query("SELECT * FROM sync_state WHERE id = 1")
    suspend fun get(): SyncStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(state: SyncStateEntity)
}

@Dao
interface SaleDao {
    @Insert suspend fun insert(sale: LocalSaleEntity)

    @Query("SELECT * FROM local_sales ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 50): Flow<List<LocalSaleEntity>>

    @Query("SELECT * FROM local_sales WHERE id = :id")
    suspend fun byId(id: String): LocalSaleEntity?

    @Query("SELECT * FROM local_sales WHERE occurredAt >= :since ORDER BY occurredAt DESC")
    suspend fun since(since: Long): List<LocalSaleEntity>

    @Query("UPDATE local_sales SET syncStatus = :status, serverInvoiceId = :serverInvoiceId, finalInvoiceNumber = :finalNumber, lastError = :error WHERE id = :id")
    suspend fun markSync(id: String, status: String, serverInvoiceId: String?, finalNumber: String?, error: String?)

    /** Local X-report style totals for the open session, straight from Room. */
    @Query("SELECT COALESCE(SUM(total), 0) FROM local_sales WHERE cashSessionLocalId = :sessionLocalId")
    suspend fun sessionTotal(sessionLocalId: String): Double

    @Query("SELECT COUNT(*) FROM local_sales WHERE cashSessionLocalId = :sessionLocalId")
    suspend fun sessionCount(sessionLocalId: String): Int
}

@Dao
interface CashSessionDao {
    @Insert suspend fun insert(session: LocalCashSessionEntity)

    @Query("SELECT * FROM local_cash_sessions WHERE status = 'open' LIMIT 1")
    suspend fun open(): LocalCashSessionEntity?

    @Query("SELECT * FROM local_cash_sessions WHERE status = 'open' LIMIT 1")
    fun openFlow(): Flow<LocalCashSessionEntity?>

    @Query("UPDATE local_cash_sessions SET status = 'closed', closedAt = :closedAt, closingCounted = :counted, varianceReason = :reason WHERE id = :id")
    suspend fun close(id: String, closedAt: Long, counted: Double, reason: String?)

    @Query("UPDATE local_cash_sessions SET syncStatus = :status, serverId = :serverId WHERE id = :id")
    suspend fun markSync(id: String, status: String, serverId: String?)

    @Insert suspend fun insertMovement(movement: LocalCashMovementEntity)

    @Query("SELECT * FROM local_cash_movements WHERE sessionLocalId = :sessionLocalId ORDER BY occurredAt")
    suspend fun movements(sessionLocalId: String): List<LocalCashMovementEntity>

    @Query("SELECT * FROM local_cash_movements WHERE occurredAt >= :since ORDER BY occurredAt DESC")
    suspend fun movementsSince(since: Long): List<LocalCashMovementEntity>
}

@Dao
interface CustomerDao {
    @Query("SELECT * FROM customers ORDER BY name")
    fun all(): Flow<List<CustomerEntity>>

    @Upsert suspend fun upsert(row: CustomerEntity)
    @Query("DELETE FROM customers WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface SupplierDao {
    @Query("SELECT * FROM suppliers ORDER BY name")
    fun all(): Flow<List<SupplierEntity>>

    @Upsert suspend fun upsert(row: SupplierEntity)
    @Query("DELETE FROM suppliers WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface InventoryDao {
    data class StockLevel(val menuItemId: String, val onHand: Double)

    @Query("SELECT menuItemId, SUM(qtyDelta) AS onHand FROM inventory_movements GROUP BY menuItemId")
    fun stockLevels(): Flow<List<StockLevel>>

    @Query("SELECT * FROM inventory_movements ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 200): Flow<List<InventoryMovementEntity>>

    @Query("SELECT * FROM inventory_movements WHERE occurredAt >= :since")
    suspend fun since(since: Long): List<InventoryMovementEntity>

    @Insert suspend fun insert(row: InventoryMovementEntity)
    @Insert suspend fun insertAll(rows: List<InventoryMovementEntity>)
}

@Dao
interface PurchaseDao {
    @Query("SELECT * FROM purchases ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 200): Flow<List<PurchaseEntity>>

    @Query("SELECT * FROM purchases WHERE occurredAt >= :since")
    suspend fun since(since: Long): List<PurchaseEntity>

    @Query("SELECT * FROM purchase_items WHERE purchaseId = :purchaseId")
    suspend fun items(purchaseId: String): List<PurchaseItemEntity>

    @Insert suspend fun insert(row: PurchaseEntity)
    @Insert suspend fun insertItems(rows: List<PurchaseItemEntity>)
}

@Dao
interface ExpenseDao {
    @Query("SELECT * FROM expenses ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 200): Flow<List<ExpenseEntity>>

    @Query("SELECT * FROM expenses WHERE occurredAt >= :since")
    suspend fun since(since: Long): List<ExpenseEntity>

    @Insert suspend fun insert(row: ExpenseEntity)
    @Query("DELETE FROM expenses WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface OpQueueDao {
    @Insert suspend fun enqueue(op: OpQueueEntity)

    @Query("SELECT * FROM op_queue WHERE status = 'queued' ORDER BY deviceSeq LIMIT :limit")
    suspend fun nextBatch(limit: Int = 100): List<OpQueueEntity>

    @Query("SELECT COUNT(*) FROM op_queue WHERE status = 'queued'")
    fun queuedCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM op_queue WHERE status = 'failed'")
    fun failedCount(): Flow<Int>

    @Query("SELECT * FROM op_queue WHERE status = 'failed' ORDER BY deviceSeq")
    fun failed(): Flow<List<OpQueueEntity>>

    @Query("UPDATE op_queue SET status = :status, attempts = attempts + 1, lastError = :error WHERE opId = :opId")
    suspend fun mark(opId: String, status: String, error: String?)

    @Query("UPDATE op_queue SET status = 'queued', lastError = NULL WHERE opId = :opId")
    suspend fun retry(opId: String)

    @Query("SELECT COALESCE(MAX(deviceSeq), 0) FROM op_queue")
    suspend fun maxSeq(): Long

    @Transaction
    suspend fun enqueueNext(build: (nextSeq: Long) -> OpQueueEntity) {
        enqueue(build(maxSeq() + 1))
    }
}
