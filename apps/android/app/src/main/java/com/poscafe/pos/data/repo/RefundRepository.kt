package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.InventoryDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.RefundDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.LocalRefundEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline refunds & voids. Mirrors [SaleRepository]:
 *   1. Write the LocalRefundEntity (device wins for its own money records),
 *   2. Reverse the movement-based stock (+qty back, best-effort, never blocks),
 *   3. Enqueue a `sale.refund` / `sale.void` op whose payload is the online
 *      RefundDto body. The server reverses the invoice GL, restocks, and
 *      returns drawer cash when the op replays.
 *
 * A void is a full refund with a MANDATORY manager override — the manager PIN
 * is verified on-device (bcrypt, like cashier login) before we ever enqueue.
 *
 * Partial (line-level) refunds are not yet supported offline: the device never
 * receives server invoice-item ids, so it cannot address individual lines.
 */
@Singleton
class RefundRepository @Inject constructor(
    private val refundDao: RefundDao,
    private val saleDao: SaleDao,
    private val cashSessionDao: CashSessionDao,
    private val opQueue: OpQueueDao,
    private val inventoryDao: InventoryDao,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Full refund of a settled sale. [overrideById] is the manager who
     * approved it (PIN-verified on-device); passing it lets the server attribute
     * and re-validate the override via assertCanOverride.
     */
    suspend fun refund(actorUserId: String, saleLocalId: String, reason: String?, overrideById: String?): LocalRefundEntity =
        record(actorUserId, saleLocalId, type = "refund", reason = reason, overrideById = overrideById)

    /**
     * Void = full refund with a mandatory manager override. [overrideById] is
     * the manager whose PIN was verified on-device.
     */
    suspend fun void(actorUserId: String, saleLocalId: String, reason: String?, overrideById: String): LocalRefundEntity =
        record(actorUserId, saleLocalId, type = "void", reason = reason, overrideById = overrideById)

    private suspend fun record(
        actorUserId: String,
        saleLocalId: String,
        type: String,
        reason: String?,
        overrideById: String?,
    ): LocalRefundEntity {
        val sale = saleDao.byId(saleLocalId) ?: error("Sale not found")
        require(refundDao.forSale(saleLocalId).isEmpty()) { "Sale already refunded" }

        val session = cashSessionDao.open()
        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        // Real server invoice id when the sale already synced; otherwise the
        // sale's local id — the server resolves it via the batch clientId map.
        val invoiceRef = sale.serverInvoiceId ?: sale.id
        // Prefer the current open session's server id so the refund cash-out
        // lands on the drawer that is physically open; resolved server-side if
        // the session was opened earlier in the same push batch.
        val cashSessionRef = session?.let { it.serverId ?: it.id }

        val row = LocalRefundEntity(
            id = id,
            saleLocalId = saleLocalId,
            serverInvoiceId = invoiceRef,
            type = type,
            reason = reason,
            amount = sale.total,
            overrideById = overrideById,
            cashSessionLocalId = session?.id,
            occurredAt = now.toEpochMilli(),
            syncStatus = "queued",
            lastError = null,
        )
        refundDao.insert(row)

        // Reverse movement-based stock: add each catalog/product line's qty back.
        runCatching {
            val lines = json.parseToJsonElement(sale.linesJson) as? JsonArray ?: JsonArray(emptyList())
            val movements = lines.filterIsInstance<JsonObject>().mapNotNull { l ->
                val menuItemId = l["menuItemId"]?.jsonPrimitive?.contentOrNull
                val productId = l["productId"]?.jsonPrimitive?.contentOrNull
                val qty = l["quantity"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: return@mapNotNull null
                if (menuItemId == null && productId == null) return@mapNotNull null
                InventoryMovementEntity(
                    id = UUID.randomUUID().toString(),
                    menuItemId = menuItemId ?: "",
                    productId = productId,
                    type = "refund",
                    qtyDelta = qty, // add back
                    unitCost = null,
                    supplierId = null,
                    reason = "Refund ${sale.provisionalNumber}",
                    saleLocalId = saleLocalId,
                    actorUserId = actorUserId,
                    occurredAt = now.toEpochMilli(),
                )
            }
            if (movements.isNotEmpty()) inventoryDao.insertAll(movements)
        }

        val opType = if (type == "void") "sale.void" else "sale.refund"
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = id,
                deviceSeq = seq,
                type = opType,
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject {
                    put("invoiceId", invoiceRef)
                    reason?.let { put("reason", it) }
                    cashSessionRef?.let { put("cashSessionId", it) }
                    overrideById?.let { put("overrideById", it) }
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
        return row
    }
}
