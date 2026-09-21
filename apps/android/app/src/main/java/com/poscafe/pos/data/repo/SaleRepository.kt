package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.InventoryDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.LocalSaleEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline checkout. Every sale is:
 *   1. Priced locally (CartEngine — parity with the server via golden vectors),
 *   2. Persisted as a LocalSaleEntity (the device's own record; device wins),
 *   3. Enqueued as a `sale.checkout` op whose payload is exactly the online
 *      CheckoutDto body (+ occurredAt, provisionalNumber, clientId refs),
 *   4. Given a provisional receipt number (D<n>-NNNNNN) for the printed ticket.
 *
 * The sale NEVER blocks on the network — the queue pushes when connectivity
 * returns and the server allocates the final invoice number then.
 */
@Singleton
class SaleRepository @Inject constructor(
    private val saleDao: SaleDao,
    private val opQueue: OpQueueDao,
    private val inventoryDao: InventoryDao,
    private val config: DeviceConfig,
) {
    /**
     * One payment leg. [accountId] is the receiving account of the configured
     * payment tile (null = cash drawer / the server's default mapping).
     */
    data class Tender(val method: String, val amount: Double, val reference: String? = null, val accountId: String? = null)

    data class CompletedSale(
        val localId: String,
        val provisionalNumber: String,
        val totals: CartEngine.CartTotals,
        val occurredAt: Instant,
    )

    private val json = Json { encodeDefaults = false }

    suspend fun checkout(
        actorUserId: String,
        lines: List<CartEngine.CartLine>,
        tenders: List<Tender>,
        cashSessionLocalId: String?,
        tableId: String? = null,
        orderType: String = "takeaway",
        transactionDiscountPercent: Double = 0.0,
        partnerId: String? = null,
    ): CompletedSale {
        require(lines.isNotEmpty()) { "Cart is empty" }
        val totals = CartEngine.totals(lines, transactionDiscountPercent)
        val tenderSum = tenders.sumOf { it.amount }
        require(tenderSum >= totals.total - 0.01) { "Tendered $tenderSum < due ${totals.total}" }
        require(tenders.none { it.method == "cash" } || cashSessionLocalId != null) {
            "Open a cash session before taking cash"
        }
        // The server rejects tenders that sum past the amount due — change is
        // carried separately as `amountTendered`. Trim the overpay off the cash
        // legs (last first) so the legs settle exactly the total.
        val applied = settleExactly(tenders, totals.total)
        val cashHanded = if (tenderSum > totals.total + 0.005 && tenders.any { it.method == "cash" }) tenderSum else null

        val localId = UUID.randomUUID().toString()
        val occurredAt = Instant.now()
        val provisionalNumber = config.nextProvisionalNumber()

        val payload = buildJsonObject {
            put("lines", linesToJson(lines))
            put("tenders", buildJsonArray {
                applied.forEach { t ->
                    add(buildJsonObject {
                        put("method", t.method)
                        put("amount", t.amount)
                        t.reference?.let { put("reference", it) }
                        t.accountId?.let { put("accountId", it) }
                    })
                }
            })
            cashHanded?.let { put("amountTendered", it) }
            if (transactionDiscountPercent > 0) put("transactionDiscountPercent", transactionDiscountPercent)
            // clientId of the locally-opened session — the server resolves it
            // to the real session id created earlier in the same push batch.
            cashSessionLocalId?.let { put("cashSessionId", it) }
            tableId?.let { put("tableId", it) }
            partnerId?.let { put("partnerId", it) }
            put("orderType", orderType)
            put("provisionalNumber", provisionalNumber)
            put("clientId", localId)
        }

        saleDao.insert(
            LocalSaleEntity(
                id = localId,
                occurredAt = occurredAt.toEpochMilli(),
                actorUserId = actorUserId,
                cashSessionLocalId = cashSessionLocalId,
                tableId = tableId,
                orderType = orderType,
                provisionalNumber = provisionalNumber,
                subtotal = totals.subtotal,
                taxAmount = totals.taxTotal,
                total = totals.total,
                tendersJson = json.encodeToString(JsonArray.serializer(), payload["tenders"] as JsonArray),
                linesJson = json.encodeToString(JsonArray.serializer(), payload["lines"] as JsonArray),
                syncStatus = "queued",
                serverInvoiceId = null,
                finalInvoiceNumber = null,
                lastError = null,
            ),
        )

        // Movement-based stock: one 'sale' issue per catalog/product line.
        // Best-effort and never blocks the sale; negative on-hand is allowed.
        runCatching {
            inventoryDao.insertAll(
                lines.filter { it.menuItemId != null || it.productId != null }.map { l ->
                    InventoryMovementEntity(
                        id = UUID.randomUUID().toString(),
                        menuItemId = l.menuItemId ?: "",
                        productId = l.productId,
                        type = "sale",
                        qtyDelta = -l.quantity,
                        unitCost = null,
                        supplierId = null,
                        reason = null,
                        saleLocalId = localId,
                        actorUserId = actorUserId,
                        occurredAt = occurredAt.toEpochMilli(),
                    )
                },
            )
        }

        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = localId,
                deviceSeq = seq,
                type = "sale.checkout",
                actorUserId = actorUserId,
                occurredAt = occurredAt.toEpochMilli(),
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }

        return CompletedSale(localId, provisionalNumber, totals, occurredAt)
    }

    /** Legs that pay exactly [total]: any overpay (cash change) comes off the cash legs. */
    private fun settleExactly(tenders: List<Tender>, total: Double): List<Tender> {
        var over = tenders.sumOf { it.amount } - total
        if (over <= 0.005) return tenders
        require(tenders.any { it.method == "cash" }) { "Only cash can be overpaid — reduce the non-cash amount" }
        val out = tenders.toMutableList()
        for (i in out.indices.reversed()) {
            if (over <= 0.005) break
            val t = out[i]
            if (t.method != "cash") continue
            val cut = minOf(t.amount, over)
            out[i] = t.copy(amount = t.amount - cut)
            over -= cut
        }
        require(over <= 0.005) { "Only cash can be overpaid — reduce the non-cash amount" }
        return out.filter { it.amount > 0.005 }
    }

    private fun linesToJson(lines: List<CartEngine.CartLine>): JsonArray = buildJsonArray {
        lines.forEach { l ->
            add(buildJsonObject {
                l.menuItemId?.let { put("menuItemId", it) }
                l.productId?.let { put("productId", it) }
                put("description", l.name)
                put("quantity", l.quantity)
                // The server re-resolves modifier/accompaniment prices from its
                // own DB (anti-tamper), so we send the UN-baked base price and
                // the selections — never the folded unit price.
                put("unitPrice", l.baseUnitPrice)
                if (l.discountPercent > 0) put("discountPercent", l.discountPercent)
                l.variantId?.let { put("variantId", it) }
                if (l.accompaniments.isNotEmpty()) {
                    put("accompanimentOptionIds", buildJsonArray {
                        l.accompaniments.forEach { add(JsonPrimitive(it.optionId)) }
                    })
                }
                if (l.modifiers.isNotEmpty()) {
                    put("modifiers", buildJsonArray {
                        l.modifiers.forEach { m ->
                            add(buildJsonObject {
                                put("modifierId", m.modifierId)
                                put("name", m.name)
                                put("priceDelta", m.priceDelta)
                            })
                        }
                    })
                }
                l.note?.let { put("note", it) }
                if (l.taxInclusive) put("taxInclusive", true)
            })
        }
    }
}
