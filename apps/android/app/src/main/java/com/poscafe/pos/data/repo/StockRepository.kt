package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.CashInventoryDao
import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.InventoryDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.dao.SettingsDao
import com.poscafe.pos.data.local.dao.SyncStateDao
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.data.local.entity.StockLocationEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Server-synced inventory for retail products.
 *
 * Every device movement still lands as a local `inventory_movements` row (the
 * till's own ledger), and — for products on an enrolled device — is queued as
 * the matching server op, with the same attribution the back office demands:
 *
 *   purchase / adjust + → `stock.in`   (unit cost optional)
 *   waste / adjust −    → `stock.out`
 *   physical count      → `stock.count` (server spot count, variances need a reason)
 *
 * Stock in/out is posted immediately on the server, so it needs an approver:
 * the cashier self-approves when they hold `inventory_doc:approve`, otherwise a
 * manager's PIN travels with the op and is re-verified on replay.
 *
 * Menu items are not stock items on the server (their ingredients are, via
 * recipes), so menu-item movements stay device-local as before.
 */
@Singleton
class StockRepository @Inject constructor(
    private val inventoryDao: InventoryDao,
    private val refs: CashInventoryDao,
    private val registerDao: RegisterDao,
    private val cashSessionDao: CashSessionDao,
    private val settingsDao: SettingsDao,
    private val syncStateDao: SyncStateDao,
    private val opQueue: OpQueueDao,
    private val auth: AuthRepository,
    private val config: DeviceConfig,
) {
    /** Approver of an immediately-posting stock movement. Null pin = self-approval. */
    data class Approval(val approverId: String, val pin: String?)

    /**
     * Where this till sells from: the open shift's register location, else any
     * register's, else the org's `pos.stockLocationId`, else the only location.
     * Mirrors the server's resolvePosStockLocation — it never guesses between two.
     */
    suspend fun location(): StockLocationEntity? {
        val locations = refs.locations()
        if (locations.isEmpty()) return null
        val registers = registerDao.all()
        val sessionRegister = cashSessionDao.open()?.cashRegisterId
        val preferred = registers.firstOrNull { it.id == sessionRegister }?.locationId
            ?: registers.firstOrNull { it.isActive && it.locationId != null }?.locationId
            ?: settingsDao.byKey("pos.stockLocationId")?.valueJson?.let { v ->
                runCatching { (Json.parseToJsonElement(v) as? JsonPrimitive)?.contentOrNull }.getOrNull()
            }
        return locations.firstOrNull { it.id == preferred }
            ?: locations.filter { it.type == "warehouse" }.singleOrNull()
    }

    /** True when stock movements for products reach the server from this device. */
    val syncsStock: Boolean get() = !config.standalone

    /** The approval the cashier can give themselves, if they hold the permission. */
    fun selfApproval(): Approval? =
        auth.current?.takeIf { auth.currentHas(APPROVE_PERMISSION) }?.let { Approval(it.userId, null) }

    /**
     * Product on-hand as the till should show it: the server's figure at this
     * location plus device movements made since the last pull (not yet in it).
     */
    suspend fun productOnHand(): Map<String, Double> {
        val loc = location() ?: return emptyMap()
        val lastPull = syncStateDao.get()?.lastPullAt ?: 0L
        val server = refs.stockAtNow(loc.id).associate { it.productId to it.quantity }
        val local = inventoryDao.since(lastPull)
            .filter { it.productId != null }
            .groupBy { it.productId!! }
            .mapValues { (_, ms) -> ms.sumOf { it.qtyDelta } }
        return (server.keys + local.keys).associateWith { (server[it] ?: 0.0) + (local[it] ?: 0.0) }
    }

    /**
     * Record a manual movement. [qty] is positive; [type] sets the sign
     * (purchase +, waste/transfer −, adjustment carries [direction]).
     */
    suspend fun record(
        menuItemId: String,
        productId: String?,
        type: String,
        qty: Double,
        direction: Int,
        unitCost: Double?,
        supplierId: String?,
        reason: String?,
        approval: Approval?,
    ) {
        require(qty > 0) { "Enter a quantity" }
        val actor = auth.current?.userId ?: error("Sign in to record stock")
        val signed = when (type) {
            "purchase" -> qty
            "waste", "transfer" -> -qty
            else -> qty * direction
        }
        val synced = productId != null && syncsStock
        val loc = if (synced) location() ?: error("Sync first — this device has no stock location") else null
        if (synced) {
            require(type != "transfer") { "Transfers between locations are done in the back office" }
            require(approval != null) { "An approver is required for this stock movement" }
            require(!reason.isNullOrBlank()) { "Enter a reason" }
        }

        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        inventoryDao.insert(
            InventoryMovementEntity(
                id = id,
                menuItemId = menuItemId,
                type = type,
                qtyDelta = signed,
                unitCost = unitCost,
                supplierId = supplierId,
                reason = reason?.takeIf { it.isNotBlank() },
                saleLocalId = null,
                actorUserId = actor,
                occurredAt = now,
                productId = productId,
            ),
        )
        if (!synced) return
        val label = when (type) {
            "purchase" -> "Purchase"
            "waste" -> "Waste"
            else -> "Adjustment"
        }
        enqueue(id, if (signed > 0) "stock.in" else "stock.out", actor, now, buildJsonObject {
            put("locationId", loc!!.id)
            put("responsibleById", actor)
            put("approvedById", approval!!.approverId)
            approval.pin?.let { put("approverPin", it) }
            put("notes", "$label: ${reason!!.trim()}")
            putJsonArray("items") {
                addJsonObject {
                    put("productId", productId)
                    put("quantity", kotlin.math.abs(signed))
                    if (signed > 0) unitCost?.let { put("unitCost", it) }
                    put("notes", reason.trim())
                }
            }
        })
    }

    /** A received purchase's product lines as one server stock-in. */
    suspend fun receivePurchase(
        purchaseId: String,
        lines: List<Triple<String, Double, Double>>, // productId, qty, unitCost
        notes: String,
        approval: Approval,
    ) {
        val actor = auth.current?.userId ?: error("Sign in to receive stock")
        val loc = location() ?: error("Sync first — this device has no stock location")
        enqueue(purchaseId, "stock.in", actor, System.currentTimeMillis(), buildJsonObject {
            put("locationId", loc.id)
            put("responsibleById", actor)
            put("approvedById", approval.approverId)
            approval.pin?.let { put("approverPin", it) }
            put("notes", notes)
            putJsonArray("items") {
                lines.forEach { (productId, qty, cost) ->
                    addJsonObject {
                        put("productId", productId)
                        put("quantity", qty)
                        put("unitCost", cost)
                    }
                }
            }
        })
    }

    data class CountLine(val menuItemId: String?, val productId: String?, val onHand: Double, val counted: Double)

    /**
     * Post a physical count: device-local reconciling adjustments for every
     * changed row, plus one server spot count for the product rows (the server
     * recomputes system quantities, so every counted product is sent, changed
     * or not). @return the number of rows that changed.
     */
    suspend fun postCount(lines: List<CountLine>, reason: String): Int {
        val actor = auth.current?.userId ?: error("Sign in to post a count")
        val now = System.currentTimeMillis()
        val changed = lines.filter { it.counted != it.onHand }
        inventoryDao.insertAll(
            changed.map { e ->
                InventoryMovementEntity(
                    id = UUID.randomUUID().toString(),
                    menuItemId = e.menuItemId ?: "",
                    productId = e.productId,
                    type = "adjustment",
                    qtyDelta = e.counted - e.onHand,
                    unitCost = null,
                    supplierId = null,
                    reason = "Physical count",
                    saleLocalId = null,
                    actorUserId = actor,
                    occurredAt = now,
                )
            },
        )
        val products = lines.filter { it.productId != null }
        if (syncsStock && products.isNotEmpty()) {
            val loc = location() ?: error("Sync first — this device has no stock location")
            enqueue(UUID.randomUUID().toString(), "stock.count", actor, now, buildJsonObject {
                put("locationId", loc.id)
                put("reason", reason.ifBlank { "Physical count" })
                put("notes", "Device count")
                putJsonArray("lines") {
                    products.forEach { l ->
                        addJsonObject {
                            put("productId", l.productId)
                            put("countedQty", l.counted)
                        }
                    }
                }
            })
        }
        return changed.size
    }

    private suspend fun enqueue(opId: String, type: String, actor: String, at: Long, payload: JsonObject) {
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = opId,
                deviceSeq = seq,
                type = type,
                actorUserId = actor,
                occurredAt = at,
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }

    companion object {
        /** Server permission an approver of direct stock in/out must hold. */
        const val APPROVE_PERMISSION = "inventory_doc:approve"
    }
}
