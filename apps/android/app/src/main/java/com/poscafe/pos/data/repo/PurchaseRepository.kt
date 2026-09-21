package com.poscafe.pos.data.repo

import androidx.room.withTransaction
import com.poscafe.pos.data.local.PosDatabase
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.PurchaseEntity
import com.poscafe.pos.data.local.entity.PurchaseItemEntity
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stock purchases (goods received). A received purchase is posted atomically:
 * the purchase header, its item lines, and one +qty `inventory_movements` row
 * per line all land in a single transaction — on-hand still derives purely
 * from movements, so a purchase can never leave stock and its audit trail out
 * of step.
 *
 * On an enrolled device the purchase's retail-product lines are also queued as
 * one server `stock.in` (op id = purchase id), carrying the unit costs and the
 * approver the server requires. Menu-item lines stay device-local.
 */
@Singleton
class PurchaseRepository @Inject constructor(
    private val db: PosDatabase,
    private val stock: StockRepository,
) {
    data class Line(val menuItemId: String, val name: String, val quantity: Double, val unitCost: Double, val productId: String? = null)

    suspend fun receive(
        actorUserId: String?,
        supplierId: String?,
        reference: String?,
        note: String?,
        lines: List<Line>,
        approval: StockRepository.Approval? = null,
    ): PurchaseEntity {
        require(lines.isNotEmpty()) { "Add at least one item" }
        val productLines = lines.filter { it.productId != null }
        val syncs = stock.syncsStock && productLines.isNotEmpty()
        if (syncs) {
            requireNotNull(approval) { "An approver is required to receive stock" }
            checkNotNull(stock.location()) { "Sync first — this device has no stock location" }
        }
        val purchaseId = UUID.randomUUID().toString()
        val now = Instant.now().toEpochMilli()
        val total = lines.sumOf { it.quantity * it.unitCost }

        val purchase = PurchaseEntity(
            id = purchaseId,
            supplierId = supplierId,
            reference = reference?.takeIf { it.isNotBlank() },
            status = "received",
            totalCost = total,
            note = note?.takeIf { it.isNotBlank() },
            actorUserId = actorUserId,
            occurredAt = now,
            createdAt = now,
            syncStatus = if (syncs) "queued" else "local",
        )
        val items = lines.map {
            PurchaseItemEntity(
                id = UUID.randomUUID().toString(),
                purchaseId = purchaseId,
                menuItemId = it.menuItemId,
                name = it.name,
                quantity = it.quantity,
                unitCost = it.unitCost,
                lineTotal = it.quantity * it.unitCost,
                productId = it.productId,
            )
        }
        val movements = lines.map {
            InventoryMovementEntity(
                id = UUID.randomUUID().toString(),
                menuItemId = it.menuItemId,
                type = "purchase",
                qtyDelta = it.quantity,
                unitCost = it.unitCost,
                supplierId = supplierId,
                reason = reference?.takeIf { r -> r.isNotBlank() }?.let { r -> "PO $r" },
                saleLocalId = null,
                purchaseId = purchaseId,
                actorUserId = actorUserId,
                occurredAt = now,
                productId = it.productId,
            )
        }

        db.withTransaction {
            db.purchaseDao().insert(purchase)
            db.purchaseDao().insertItems(items)
            db.inventoryDao().insertAll(movements)
        }
        if (syncs) {
            val supplier = supplierId?.let { db.supplierDao().byId(it)?.name }
            val notes = listOfNotNull(
                "Purchase",
                supplier?.let { "from $it" },
                purchase.reference?.let { "ref $it" },
                purchase.note,
            ).joinToString(" · ")
            stock.receivePurchase(
                purchaseId = purchaseId,
                lines = productLines.map { Triple(it.productId!!, it.quantity, it.unitCost) },
                notes = notes,
                approval = approval!!,
            )
        }
        return purchase
    }
}
