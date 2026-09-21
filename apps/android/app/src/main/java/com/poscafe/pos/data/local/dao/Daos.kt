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

    // ---- authoring: lists for editors/pickers ----
    @Query("SELECT * FROM taxes WHERE isActive = 1 ORDER BY name")
    fun taxes(): Flow<List<TaxEntity>>

    @Query("SELECT * FROM taxes ORDER BY name")
    fun allTaxesIncludingInactive(): Flow<List<TaxEntity>>

    @Query("SELECT * FROM modifier_groups WHERE isActive = 1 ORDER BY sortOrder, name")
    fun allModifierGroups(): Flow<List<ModifierGroupEntity>>

    @Query("SELECT * FROM modifiers WHERE groupId = :groupId AND isActive = 1 ORDER BY sortOrder")
    fun modifiersFlow(groupId: String): Flow<List<ModifierEntity>>

    @Query("SELECT * FROM accompaniment_groups WHERE isActive = 1 ORDER BY sortOrder, name")
    fun allAccompanimentGroups(): Flow<List<AccompanimentGroupEntity>>

    @Query("SELECT * FROM accompaniment_options WHERE groupId = :groupId AND isActive = 1 ORDER BY sortOrder")
    fun optionsFlow(groupId: String): Flow<List<AccompanimentOptionEntity>>

    @Query("SELECT * FROM menu_item_variants WHERE menuItemId = :menuItemId AND isActive = 1 ORDER BY sortOrder")
    suspend fun variantsAll(menuItemId: String): List<MenuItemVariantEntity>

    @Query("SELECT modifierGroupId FROM menu_item_modifier_groups WHERE menuItemId = :menuItemId")
    suspend fun assignedModifierGroupIds(menuItemId: String): List<String>

    @Query("SELECT accompanimentGroupId FROM menu_item_accompaniment_groups WHERE menuItemId = :menuItemId")
    suspend fun assignedAccompanimentGroupIds(menuItemId: String): List<String>

    // ---- device-local menu-item cost/reorder (pull never touches these) ----
    @Query("SELECT * FROM menu_item_local WHERE menuItemId = :id")
    suspend fun localMeta(id: String): MenuItemLocalEntity?

    @Query("SELECT * FROM menu_item_local")
    fun allLocalMeta(): Flow<List<MenuItemLocalEntity>>

    @Upsert suspend fun upsertLocalMeta(row: MenuItemLocalEntity)

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
    @Query("DELETE FROM modifiers WHERE id = :id") suspend fun deleteModifier(id: String)
    @Query("DELETE FROM modifiers WHERE groupId = :groupId") suspend fun clearModifiers(groupId: String)
    @Query("DELETE FROM accompaniment_groups WHERE id = :id") suspend fun deleteAccompanimentGroup(id: String)
    @Query("DELETE FROM accompaniment_options WHERE id = :id") suspend fun deleteAccompanimentOption(id: String)
    @Query("DELETE FROM accompaniment_options WHERE groupId = :groupId") suspend fun clearAccompanimentOptions(groupId: String)
    @Query("DELETE FROM menu_item_variants WHERE id = :id") suspend fun deleteVariant(id: String)
    @Query("DELETE FROM taxes WHERE id = :id") suspend fun deleteTax(id: String)
}

@Dao
interface StaffDao {
    @Query("SELECT * FROM staff WHERE isActive = 1")
    suspend fun all(): List<StaffEntity>

    @Query("SELECT * FROM staff WHERE id = :id LIMIT 1")
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

    @Query("SELECT * FROM cash_registers WHERE isActive = 1 ORDER BY sortOrder, code")
    suspend fun active(): List<CashRegisterEntity>

    @Query("SELECT * FROM cash_registers ORDER BY sortOrder, code")
    fun allFlow(): Flow<List<CashRegisterEntity>>

    @Upsert suspend fun upsertAll(rows: List<CashRegisterEntity>)
    @Upsert suspend fun upsert(row: CashRegisterEntity)
    @Query("DELETE FROM cash_registers WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface SettingsDao {
    @Query("SELECT * FROM settings WHERE `key` = :key")
    suspend fun byKey(key: String): SettingEntity?

    @Query("SELECT * FROM settings WHERE `key` = :key")
    fun byKeyFlow(key: String): Flow<SettingEntity?>

    @Upsert suspend fun upsertAll(rows: List<SettingEntity>)
    @Upsert suspend fun upsert(row: SettingEntity)
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

    @Query("SELECT * FROM local_sales WHERE cashSessionLocalId = :sessionLocalId")
    suspend fun forSession(sessionLocalId: String): List<LocalSaleEntity>
}

@Dao
interface RefundDao {
    @Insert suspend fun insert(refund: LocalRefundEntity)

    @Query("SELECT * FROM local_refunds ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 50): Flow<List<LocalRefundEntity>>

    @Query("SELECT * FROM local_refunds WHERE saleLocalId = :saleLocalId")
    suspend fun forSale(saleLocalId: String): List<LocalRefundEntity>

    /** Sum of refunds/voids on a session — drawer cash that left for refunds. */
    @Query("SELECT COALESCE(SUM(amount), 0) FROM local_refunds WHERE cashSessionLocalId = :sessionLocalId")
    suspend fun sessionRefundTotal(sessionLocalId: String): Double

    @Query("SELECT * FROM local_refunds WHERE cashSessionLocalId = :sessionLocalId")
    suspend fun forSession(sessionLocalId: String): List<LocalRefundEntity>

    @Query("UPDATE local_refunds SET syncStatus = :status, serverInvoiceId = COALESCE(:serverInvoiceId, serverInvoiceId), lastError = :error WHERE id = :id")
    suspend fun markSync(id: String, status: String, serverInvoiceId: String?, error: String?)
}

@Dao
interface CashSessionDao {
    @Insert suspend fun insert(session: LocalCashSessionEntity)

    @Query("SELECT * FROM local_cash_sessions WHERE status = 'open' LIMIT 1")
    suspend fun open(): LocalCashSessionEntity?

    @Query("SELECT * FROM local_cash_sessions WHERE status = 'open' LIMIT 1")
    fun openFlow(): Flow<LocalCashSessionEntity?>

    @Query("SELECT * FROM local_cash_sessions ORDER BY openedAt DESC LIMIT :limit")
    fun recent(limit: Int = 60): Flow<List<LocalCashSessionEntity>>

    @Query("SELECT * FROM local_cash_sessions WHERE id = :id")
    suspend fun byId(id: String): LocalCashSessionEntity?

    @Query("UPDATE local_cash_sessions SET status = 'closed', closedAt = :closedAt, closingCounted = :counted, varianceReason = :reason, closingAccountsJson = :closingAccountsJson WHERE id = :id")
    suspend fun close(id: String, closedAt: Long, counted: Double, reason: String?, closingAccountsJson: String? = null)

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

    @Query("SELECT * FROM customers WHERE id = :id")
    suspend fun byId(id: String): CustomerEntity?

    @Query("UPDATE customers SET syncStatus = 'synced' WHERE id = :id")
    suspend fun markSynced(id: String)

    @Upsert suspend fun upsert(row: CustomerEntity)
    @Query("DELETE FROM customers WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface SupplierDao {
    @Query("SELECT * FROM suppliers ORDER BY name")
    fun all(): Flow<List<SupplierEntity>>

    @Upsert suspend fun upsert(row: SupplierEntity)
    @Query("DELETE FROM suppliers WHERE id = :id") suspend fun delete(id: String)
    @Query("SELECT * FROM suppliers WHERE id = :id") suspend fun byId(id: String): SupplierEntity?
}

@Dao
interface InventoryDao {
    data class StockLevel(val menuItemId: String, val onHand: Double)
    data class ProductStockLevel(val productId: String, val onHand: Double)

    @Query("SELECT menuItemId, SUM(qtyDelta) AS onHand FROM inventory_movements WHERE productId IS NULL GROUP BY menuItemId")
    fun stockLevels(): Flow<List<StockLevel>>

    @Query("SELECT productId, SUM(qtyDelta) AS onHand FROM inventory_movements WHERE productId IS NOT NULL GROUP BY productId")
    fun productStockLevels(): Flow<List<ProductStockLevel>>

    @Query("SELECT * FROM inventory_movements ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 200): Flow<List<InventoryMovementEntity>>

    @Query("SELECT * FROM inventory_movements WHERE occurredAt >= :since")
    suspend fun since(since: Long): List<InventoryMovementEntity>

    @Query("SELECT * FROM inventory_movements WHERE menuItemId = :menuItemId AND productId IS NULL ORDER BY occurredAt DESC LIMIT :limit")
    suspend fun forMenuItem(menuItemId: String, limit: Int = 100): List<InventoryMovementEntity>

    @Query("SELECT * FROM inventory_movements WHERE productId = :productId ORDER BY occurredAt DESC LIMIT :limit")
    suspend fun forProduct(productId: String, limit: Int = 100): List<InventoryMovementEntity>

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

    @Query("UPDATE purchases SET syncStatus = :status WHERE id = :id")
    suspend fun markSync(id: String, status: String)
}

@Dao
interface ExpenseDao {
    @Query("SELECT * FROM expenses ORDER BY occurredAt DESC LIMIT :limit")
    fun recent(limit: Int = 200): Flow<List<ExpenseEntity>>

    @Query("SELECT * FROM expenses WHERE occurredAt >= :since")
    suspend fun since(since: Long): List<ExpenseEntity>

    @Insert suspend fun insert(row: ExpenseEntity)
    @Query("DELETE FROM expenses WHERE id = :id") suspend fun delete(id: String)

    @Query("UPDATE expenses SET syncStatus = :status, lastError = :error WHERE id = :id")
    suspend fun markSync(id: String, status: String, error: String?)
}

@Dao
interface ProductDao {
    @Query("SELECT * FROM products WHERE isActive = 1 ORDER BY name")
    fun all(): Flow<List<ProductEntity>>

    @Query("SELECT * FROM products WHERE isActive = 1 AND (:categoryId IS NULL OR categoryId = :categoryId) ORDER BY name")
    fun byCategory(categoryId: String?): Flow<List<ProductEntity>>

    @Query("SELECT * FROM products WHERE isActive = 1 AND (sku = :code OR barcode = :code) LIMIT 1")
    suspend fun byCode(code: String): ProductEntity?

    @Query("SELECT * FROM products WHERE id = :id")
    suspend fun byId(id: String): ProductEntity?

    @Query("SELECT * FROM products WHERE isActive = 1 AND (name LIKE '%' || :query || '%' OR sku LIKE '%' || :query || '%' OR barcode LIKE '%' || :query || '%') ORDER BY name")
    fun search(query: String): Flow<List<ProductEntity>>

    @Upsert suspend fun upsertAll(rows: List<ProductEntity>)
    @Query("DELETE FROM products WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM products") suspend fun deleteAll()
}

@Dao
interface ProductPackagingDao {
    @Query("SELECT * FROM product_packagings WHERE isActive = 1 AND productId = :productId")
    suspend fun forProduct(productId: String): List<ProductPackagingEntity>

    @Query("SELECT * FROM product_packagings WHERE isActive = 1 AND barcode = :barcode LIMIT 1")
    suspend fun byBarcode(barcode: String): ProductPackagingEntity?

    @Upsert suspend fun upsertAll(rows: List<ProductPackagingEntity>)
    @Query("DELETE FROM product_packagings WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM product_packagings") suspend fun deleteAll()
}

@Dao
interface ProductCategoryDao {
    @Query("SELECT * FROM product_categories ORDER BY name")
    fun all(): Flow<List<ProductCategoryEntity>>

    @Upsert suspend fun upsertAll(rows: List<ProductCategoryEntity>)
    @Query("DELETE FROM product_categories WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM product_categories") suspend fun deleteAll()
}

@Dao
interface HoldDao {
    @Query("SELECT * FROM local_holds WHERE syncStatus != 'deleted' ORDER BY createdAt DESC")
    fun all(): Flow<List<LocalHoldEntity>>

    @Query("SELECT * FROM local_holds WHERE id = :id")
    suspend fun byId(id: String): LocalHoldEntity?

    @Insert suspend fun insert(hold: LocalHoldEntity)
    @Query("UPDATE local_holds SET syncStatus = 'deleted' WHERE id = :id")
    suspend fun softDelete(id: String)
}

@Dao
interface ReservationDao {
    @Query("SELECT * FROM reservations WHERE status IN ('pending', 'seated') ORDER BY startAt")
    fun active(): Flow<List<ReservationEntity>>

    @Query("SELECT * FROM reservations WHERE id = :id")
    suspend fun byId(id: String): ReservationEntity?

    @Upsert suspend fun upsert(row: ReservationEntity)

    @Query("UPDATE reservations SET status = :status, seatedOrderId = COALESCE(:seatedOrderId, seatedOrderId), syncStatus = :syncStatus, updatedAt = :updatedAt WHERE id = :id")
    suspend fun setStatus(id: String, status: String, seatedOrderId: String?, syncStatus: String, updatedAt: Long)

    @Query("UPDATE reservations SET syncStatus = :syncStatus WHERE id = :id")
    suspend fun markSync(id: String, syncStatus: String)

    @Query("DELETE FROM reservations WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface TabDao {
    @Query("SELECT * FROM local_tabs ORDER BY updatedAt DESC")
    fun all(): Flow<List<LocalTabEntity>>

    @Query("SELECT * FROM local_tabs WHERE tableId = :tableId")
    suspend fun byTable(tableId: String): LocalTabEntity?

    @Query("SELECT tableId FROM local_tabs")
    fun openTableIds(): Flow<List<String>>

    @Query("SELECT COUNT(*) FROM local_tabs")
    suspend fun openCount(): Int

    @Upsert suspend fun upsert(tab: LocalTabEntity)
    @Query("DELETE FROM local_tabs WHERE tableId = :tableId") suspend fun delete(tableId: String)
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

    @Query("SELECT * FROM op_queue WHERE status = 'queued' AND type = :type")
    suspend fun queuedOfType(type: String): List<OpQueueEntity>

    @Query("SELECT COUNT(*) FROM op_queue WHERE status = 'queued'")
    suspend fun queuedNow(): Int

    @Query("SELECT COUNT(*) FROM op_queue WHERE status = 'failed'")
    suspend fun failedNow(): Int

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
