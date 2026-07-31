package com.poscafe.pos.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Device-owned records (standalone mode or local bookkeeping). Unlike the
 * catalog mirrors these are writable on the device; when cloud sync is later
 * extended to cover them they will push through the same op-queue pattern as
 * sales.
 */
@Entity(tableName = "customers")
data class CustomerEntity(
    @PrimaryKey val id: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val note: String?,
    val loyaltyPoints: Int,
    val createdAt: Long,
    val updatedAt: Long = 0,
    /** local = has un-pushed edits, synced = mirrors the server Partner row. */
    val syncStatus: String = "local",
)

@Entity(tableName = "suppliers")
data class SupplierEntity(
    @PrimaryKey val id: String,
    val name: String,
    val phone: String?,
    val note: String?,
    val createdAt: Long,
)

/**
 * A table booking. Synced from the reservations pull scope AND device-writable
 * (bookings taken offline). The id is client-minted on offline create and the
 * server honours it as the row id, so seat/cancel/no-show reference the same id
 * with no remap and a pull never duplicates a device-created booking.
 */
@Entity(tableName = "reservations", indices = [Index("tableId"), Index("startAt")])
data class ReservationEntity(
    @PrimaryKey val id: String,
    val tableId: String,
    val customerName: String,
    val phone: String?,
    val partySize: Int,
    val startAt: Long,
    val endAt: Long,
    /** pending | seated | cancelled | no_show | completed */
    val status: String,
    val notes: String?,
    val seatedOrderId: String?,
    /** synced | queued | failed */
    val syncStatus: String,
    val updatedAt: Long,
)

/**
 * Movement-based inventory: on-hand is always SUM(qtyDelta), never a stored
 * counter. Types: purchase, sale, waste, adjustment, transfer.
 * qtyDelta carries the sign (+ receive, − issue).
 */
@Entity(
    tableName = "inventory_movements",
    indices = [Index("menuItemId"), Index("productId"), Index("occurredAt")],
)
data class InventoryMovementEntity(
    @PrimaryKey val id: String,
    val menuItemId: String,
    val productId: String?,
    val type: String,
    val qtyDelta: Double,
    val unitCost: Double?,
    val supplierId: String?,
    val reason: String?,
    val saleLocalId: String?,
    /** Set when the movement was posted by receiving a purchase document. */
    val purchaseId: String? = null,
    val actorUserId: String?,
    val occurredAt: Long,
)

/**
 * A stock purchase / goods-received note. Receiving it posts one
 * `inventory_movements` row per line (type=purchase, +qty), so on-hand still
 * derives from movements — the document is just the human-facing grouping.
 */
@Entity(tableName = "purchases", indices = [Index("occurredAt")])
data class PurchaseEntity(
    @PrimaryKey val id: String,
    val supplierId: String?,
    val reference: String?,
    val status: String, // received (draft reserved for later)
    val totalCost: Double,
    val note: String?,
    val actorUserId: String?,
    val occurredAt: Long,
    val createdAt: Long,
)

@Entity(tableName = "purchase_items", indices = [Index("purchaseId")])
data class PurchaseItemEntity(
    @PrimaryKey val id: String,
    val purchaseId: String,
    val menuItemId: String,
    val productId: String?,
    val name: String,
    val quantity: Double,
    val unitCost: Double,
    val lineTotal: Double,
)

/**
 * Operating expense. When paid in cash against an open session it also writes
 * a drawer pay_out movement so cash reconciliation stays honest; the expense
 * row is the record used by the expense report.
 */
/**
 * Device-owned augmentation of a (possibly server-authoritative) menu item.
 * Menu items themselves are replaced wholesale by /sync/pull, so per-item cost
 * and reorder point — which the server has no column for — live here where the
 * pull never touches them. Keyed by the menu item id.
 */
@Entity(tableName = "menu_item_local")
data class MenuItemLocalEntity(
    @PrimaryKey val menuItemId: String,
    /** Unit cost in MAJOR units, for COGS / margin reporting. */
    val costMajor: Double? = null,
    /** Low-stock threshold (on-hand units); null/0 = no alert. */
    val reorderPoint: Double? = null,
)

@Entity(tableName = "expenses", indices = [Index("occurredAt")])
data class ExpenseEntity(
    @PrimaryKey val id: String,
    val category: String,
    val description: String?,
    val amount: Double,
    val paymentMethod: String, // cash | bank | mobile_money
    val supplierId: String?,
    val cashSessionLocalId: String?,
    val actorUserId: String?,
    val occurredAt: Long,
    val createdAt: Long,
)
