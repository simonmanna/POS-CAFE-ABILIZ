package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.PosDatabase
import com.poscafe.pos.data.local.entity.*
import com.poscafe.pos.data.remote.PushOp
import com.poscafe.pos.data.remote.PushRequest
import com.poscafe.pos.data.remote.SyncApi
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The device end of the sync protocol.
 *
 * PULL: incremental catalog download (per-scope updatedAt cursors, opaque to
 * us). Rows with deletedAt are tombstones → local delete. MenuItem arrives as
 * a full aggregate: children are wiped + re-inserted per item.
 *
 * PUSH: the op queue drains FIFO in one batch. Results:
 *   applied/replayed → mark pushed, store invoice mapping + final numbers
 *   failed           → mark failed locally (visible in sync screen); the
 *                      server has dead-lettered it — never re-pushed blindly.
 */
@Singleton
class SyncRepository @Inject constructor(
    private val api: SyncApi,
    private val db: PosDatabase,
    private val config: DeviceConfig,
) {
    suspend fun pull() {
        val state = db.syncStateDao().get()
        val res = api.pull(cursor = state?.cursor)

        res.data["menuCategories"]?.let { applyCategories(it) }
        res.data["taxes"]?.let { applyTaxes(it) }
        res.data["modifierGroups"]?.let { applyModifierGroups(it) }
        res.data["menuItems"]?.let { applyMenuItems(it) }
        res.data["posTables"]?.let { applyTables(it) }
        res.data["cashRegisters"]?.let { applyRegisters(it) }
        res.data["staff"]?.let { applyStaff(it) }
        res.data["settings"]?.let { applySettings(it) }
        res.data["products"]?.let { applyProducts(it) }
        res.data["productCategories"]?.let { applyProductCategories(it) }
        res.data["productPackagings"]?.let { applyProductPackagings(it) }
        res.data["partners"]?.let { applyPartners(it) }
        res.data["reservations"]?.let { applyReservations(it) }
        res.data["conversations"]?.let { applyConversations(it) }
        res.data["messages"]?.let { applyMessages(it) }
        // Cash & inventory reference data (full snapshots, except stock/suppliers).
        res.data["paymentMethods"]?.let { applyPaymentMethods(it) }
        res.data["ledgerAccounts"]?.let { applyLedgerAccounts(it) }
        res.data["expenseCategories"]?.let { applyExpenseCategories(it) }
        res.data["stockLocations"]?.let { applyStockLocations(it) }
        res.data["stockLevels"]?.let { applyStockLevels(it) }
        res.data["suppliers"]?.let { applySuppliers(it) }

        db.syncStateDao().put(
            SyncStateEntity(
                cursor = res.cursor,
                lastPullAt = Instant.now().toEpochMilli(),
                lastPushAt = state?.lastPushAt,
            ),
        )
    }

    /** @return number of ops that remain queued or failed after this push. */
    suspend fun push(): Int {
        val deviceId = config.deviceId ?: error("Device not enrolled")
        val ops = db.opQueueDao().nextBatch()
        if (ops.isEmpty()) return 0

        val request = PushRequest(
            deviceId = deviceId,
            ops = ops.map { op ->
                PushOp(
                    opId = op.opId,
                    deviceSeq = op.deviceSeq,
                    type = op.type,
                    actorUserId = op.actorUserId,
                    occurredAt = Instant.ofEpochMilli(op.occurredAt).toString(),
                    payload = Json.parseToJsonElement(op.payloadJson),
                )
            },
        )
        // Batch id doubles as the HTTP-level idempotency key; per-op keys are
        // the opIds, enforced server-side.
        val response = api.push(batchId = UUID.randomUUID().toString(), body = request)

        var unresolved = 0
        for (result in response.results) {
            when (result.status) {
                "applied", "replayed" -> {
                    db.opQueueDao().mark(result.opId, "pushed", null)
                    applyMapping(result.opId, result.mapping, result.finalNumbers)
                }
                else -> {
                    unresolved += 1
                    db.opQueueDao().mark(result.opId, "failed", result.error)
                    // The opId belongs to exactly one of these tables; the other
                    // updates are harmless no-ops (WHERE id = opId matches none).
                    db.saleDao().markSync(result.opId, "failed", null, null, result.error)
                    db.refundDao().markSync(result.opId, "failed", null, result.error)
                    // message.send opId == the message id; flip its bubble to failed.
                    db.messageDao().markState(result.opId, "failed", result.error)
                    // Expense / purchase ops are keyed by their row id too.
                    db.expenseDao().markSync(result.opId, "failed", result.error)
                    db.purchaseDao().markSync(result.opId, "failed")
                }
            }
        }

        val state = db.syncStateDao().get()
        db.syncStateDao().put(
            SyncStateEntity(
                cursor = state?.cursor,
                lastPullAt = state?.lastPullAt,
                lastPushAt = Instant.now().toEpochMilli(),
            ),
        )
        return unresolved
    }

    private suspend fun applyMapping(opId: String, mapping: Map<String, String>?, finalNumbers: Map<String, String>?) {
        val invoiceId = mapping?.get("invoiceId")
        val invoiceNumber = finalNumbers?.get("invoiceNumber")
        if (invoiceId != null || invoiceNumber != null) {
            // opId keys a sale (sale.checkout) OR a refund (sale.refund/void) —
            // whichever it isn't, the update is a no-op.
            db.saleDao().markSync(opId, "pushed", invoiceId, invoiceNumber, null)
            db.refundDao().markSync(opId, "pushed", invoiceId, null)
        }
        // cash_session.open ops key the map by the session's clientId (== opId).
        mapping?.get(opId)?.let { serverId ->
            db.cashSessionDao().markSync(opId, "pushed", serverId)
        }
        // customer.upsert applied — the local row now mirrors the server.
        mapping?.get("customerId")?.let { db.customerDao().markSynced(it) }
        // reservation.* applied — mark the booking synced (keyed by its id, not
        // the opId, since seat/cancel/no-show ops have their own uuid).
        mapping?.get("reservationId")?.let { db.reservationDao().markSync(it, "synced") }
        // message.send applied — flip the optimistic bubble to 'sent'. The
        // authoritative seq arrives on the next pull (applyMessages).
        mapping?.get("messageId")?.let { db.messageDao().markState(it, "sent", null) }
        // expense.create / a drawer pay-out for an expense, and a purchase's stock.in —
        // all keyed by the local row id (== opId). No-ops for every other op.
        db.expenseDao().markSync(opId, "pushed", null)
        db.purchaseDao().markSync(opId, "pushed")
    }

    // ---------------------- pull-apply per scope ----------------------

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
    private fun JsonObject.int(key: String): Int? = num(key)?.toInt()
    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
    private fun JsonObject.deleted(): Boolean = this["deletedAt"]?.let { it !is JsonNull } == true

    private suspend fun applyCategories(rows: List<JsonObject>) {
        val dao = db.menuDao()
        val pending = pendingIds("menuCategory.upsert", "menuCategory.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            if (row.deleted()) { dao.deleteCategory(id); continue }
            dao.upsertCategories(
                listOf(
                    MenuCategoryEntity(
                        id = id,
                        name = row.str("name") ?: "",
                        sortOrder = row.int("sortOrder") ?: 0,
                        isActive = row.bool("isActive") ?: true,
                    ),
                ),
            )
        }
    }

    private suspend fun applyTaxes(rows: List<JsonObject>) {
        val dao = db.menuDao()
        val pending = pendingIds("tax.upsert", "tax.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            if (row.deleted()) { dao.deleteTax(id); continue }
            dao.upsertTaxes(
                listOf(
                    TaxEntity(
                        id = id,
                        name = row.str("name") ?: "",
                        rate = row.num("rate") ?: 0.0,
                        isActive = row.bool("isActive") ?: true,
                    ),
                ),
            )
        }
    }

    private suspend fun applyModifierGroups(rows: List<JsonObject>) {
        val dao = db.menuDao()
        val pending = pendingIds("modifierGroup.upsert", "modifierGroup.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            if (row.deleted()) { dao.deleteModifierGroup(id); continue }
            dao.upsertModifierGroups(
                listOf(
                    ModifierGroupEntity(
                        id = id,
                        name = row.str("name") ?: "",
                        groupType = row.str("groupType") ?: "ADD_ON",
                        minSelect = row.int("minSelect") ?: 0,
                        maxSelect = row.int("maxSelect") ?: 1,
                        sortOrder = row.int("sortOrder") ?: 0,
                        isActive = row.bool("isActive") ?: true,
                    ),
                ),
            )
            (row["modifiers"] as? JsonArray)?.let { mods ->
                dao.upsertModifiers(
                    mods.filterIsInstance<JsonObject>().mapNotNull { m ->
                        val mid = m.str("id") ?: return@mapNotNull null
                        ModifierEntity(
                            id = mid,
                            groupId = id,
                            name = m.str("name") ?: "",
                            kitchenPrintName = m.str("kitchenPrintName"),
                            priceDelta = m.num("priceDelta") ?: 0.0,
                            isDefault = m.bool("isDefault") ?: false,
                            sortOrder = m.int("sortOrder") ?: 0,
                            isActive = m.bool("isActive") ?: true,
                        )
                    },
                )
            }
        }
    }

    private suspend fun applyMenuItems(rows: List<JsonObject>) {
        val dao = db.menuDao()
        val pending = pendingIds("menuItem.upsert", "menuItem.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            // MenuItem "delete" is isAvailable=false — still an upsert.
            dao.upsertItems(
                listOf(
                    MenuItemEntity(
                        id = id,
                        code = row.str("code"),
                        name = row.str("name") ?: "",
                        description = row.str("description"),
                        categoryId = row.str("categoryId"),
                        basePriceMajor = CartEngine.basePriceToMajor(row.num("basePrice")),
                        taxId = row.str("taxId"),
                        image = row.str("image"),
                        isAvailable = row.bool("isAvailable") ?: true,
                        displayOrder = row.int("displayOrder") ?: 0,
                    ),
                ),
            )
            // Children arrive as the full aggregate → replace wholesale.
            dao.clearVariants(id)
            (row["variants"] as? JsonArray)?.let { variants ->
                dao.upsertVariants(
                    variants.filterIsInstance<JsonObject>().mapNotNull { v ->
                        val vid = v.str("id") ?: return@mapNotNull null
                        MenuItemVariantEntity(
                            id = vid,
                            menuItemId = id,
                            name = v.str("name") ?: "",
                            price = v.num("price") ?: 0.0,
                            sortOrder = v.int("sortOrder") ?: 0,
                            isActive = v.bool("isActive") ?: true,
                        )
                    },
                )
            }
            dao.clearItemModifierJoins(id)
            (row["modifierGroups"] as? JsonArray)?.let { joins ->
                dao.upsertItemModifierJoins(
                    joins.filterIsInstance<JsonObject>().mapNotNull { j ->
                        val gid = j.str("modifierGroupId") ?: (j["modifierGroup"] as? JsonObject)?.str("id")
                            ?: return@mapNotNull null
                        MenuItemModifierGroupEntity(menuItemId = id, modifierGroupId = gid, sortOrder = j.int("sortOrder") ?: 0)
                    },
                )
                // Groups embedded in the aggregate keep the local group tables warm.
                applyModifierGroups(joins.filterIsInstance<JsonObject>().mapNotNull { it["modifierGroup"] as? JsonObject })
            }
            dao.clearItemAccompanimentJoins(id)
            (row["accompanimentGroups"] as? JsonArray)?.let { joins ->
                for (j in joins.filterIsInstance<JsonObject>()) {
                    val group = j["accompanimentGroup"] as? JsonObject ?: continue
                    val gid = group.str("id") ?: continue
                    dao.upsertItemAccompanimentJoins(
                        listOf(MenuItemAccompanimentGroupEntity(menuItemId = id, accompanimentGroupId = gid, sortOrder = j.int("sortOrder") ?: 0)),
                    )
                    dao.upsertAccompanimentGroups(
                        listOf(
                            AccompanimentGroupEntity(
                                id = gid,
                                name = group.str("name") ?: "",
                                isRequired = group.bool("isRequired") ?: true,
                                minSelect = group.int("minSelect") ?: 1,
                                maxSelect = group.int("maxSelect") ?: 1,
                                sortOrder = group.int("sortOrder") ?: 0,
                                isActive = group.bool("isActive") ?: true,
                            ),
                        ),
                    )
                    (group["options"] as? JsonArray)?.let { options ->
                        dao.upsertAccompanimentOptions(
                            options.filterIsInstance<JsonObject>().mapNotNull { o ->
                                val oid = o.str("id") ?: return@mapNotNull null
                                AccompanimentOptionEntity(
                                    id = oid,
                                    groupId = gid,
                                    name = o.str("name") ?: "",
                                    priceImpact = o.num("priceImpact") ?: 0.0,
                                    isDefault = o.bool("isDefault") ?: false,
                                    sortOrder = o.int("sortOrder") ?: 0,
                                    isActive = o.bool("isActive") ?: true,
                                )
                            },
                        )
                    }
                }
            }
        }
    }

    private suspend fun applyTables(rows: List<JsonObject>) {
        val pending = pendingIds("posTable.upsert", "posTable.delete")
        db.tableDao().upsertAll(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                if (id in pending) return@mapNotNull null
                PosTableEntity(
                    id = id,
                    number = row.str("number") ?: "",
                    name = row.str("name"),
                    status = row.str("status") ?: "available",
                    sortOrder = row.int("sortOrder") ?: 0,
                )
            },
        )
    }

    private suspend fun applyRegisters(rows: List<JsonObject>) {
        // Skip registers with an un-pushed local edit, and preserve the
        // device-local isActive/sortOrder (the server has no such columns).
        val pending = pendingIds("cashRegister.upsert", "cashRegister.delete")
        val existing = db.registerDao().all().associateBy { it.id }
        db.registerDao().upsertAll(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                if (id in pending) return@mapNotNull null
                val local = existing[id]
                CashRegisterEntity(
                    id = id,
                    code = row.str("code") ?: local?.code ?: "",
                    name = row.str("name") ?: local?.name,
                    isActive = local?.isActive ?: true,
                    sortOrder = local?.sortOrder ?: 0,
                    defaultAccountId = row.str("defaultAccountId") ?: local?.defaultAccountId,
                    locationId = row.str("locationId") ?: local?.locationId,
                )
            },
        )
    }

    private suspend fun applyStaff(rows: List<JsonObject>) {
        val dao = db.staffDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (row.deleted()) { dao.delete(id); continue }
            val permissions = (row["roles"] as? JsonArray)
                ?.filterIsInstance<JsonObject>()
                ?.flatMap { r -> (r["permissions"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList() }
                ?.toSet()
                ?: emptySet()
            dao.upsertAll(
                listOf(
                    StaffEntity(
                        id = id,
                        firstName = row.str("firstName") ?: "",
                        lastName = row.str("lastName"),
                        email = row.str("email") ?: "",
                        pinHash = row.str("pinHash"),
                        permissions = permissions.joinToString(","),
                        isActive = row.bool("isActive") ?: true,
                    ),
                ),
            )
        }
    }

    private suspend fun applySettings(rows: List<JsonObject>) {
        // Keys with a queued setting.set op are mid-flight device edits — the
        // pull must not flip them back before the push lands (server wins once
        // the op is applied and the next pull re-delivers the merged value).
        val pendingKeys = db.opQueueDao().queuedOfType("setting.set")
            .mapNotNull { op -> parsePayload(op.payloadJson)?.str("key") }
            .toSet()
        db.settingsDao().upsertAll(
            rows.mapNotNull { row ->
                val key = row.str("key") ?: return@mapNotNull null
                if (key in pendingKeys) return@mapNotNull null
                SettingEntity(key = key, valueJson = row["value"]?.toString() ?: "null")
            },
        )
    }

    /**
     * Server customers (Partner rows, isCustomer only). Rows with a queued
     * local edit are skipped so an offline change isn't clobbered by a pull
     * that raced its push. Tombstones delete locally.
     */
    private suspend fun applyPartners(rows: List<JsonObject>) {
        val dao = db.customerDao()
        val pendingIds = (db.opQueueDao().queuedOfType("customer.upsert") + db.opQueueDao().queuedOfType("customer.delete"))
            .mapNotNull { op -> parsePayload(op.payloadJson)?.let { it.str("id") ?: it.str("clientId") } }
            .toSet()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pendingIds) continue
            if (row.deleted()) { dao.delete(id); continue }
            val customFields = row["customFields"] as? JsonObject
            dao.upsert(
                CustomerEntity(
                    id = id,
                    name = row.str("name") ?: "",
                    phone = row.str("phone"),
                    email = row.str("email"),
                    note = row.str("notes"),
                    loyaltyPoints = customFields?.int("loyaltyPoints") ?: 0,
                    createdAt = parseEpoch(row.str("createdAt")),
                    updatedAt = parseEpoch(row.str("updatedAt")),
                    syncStatus = "synced",
                ),
            )
        }
    }

    /**
     * Bookings for the floor. Terminal statuses (cancelled/no_show/completed)
     * are tombstones — dropped locally. Rows with a queued local op are skipped
     * so an offline booking/seat isn't clobbered by a pull that raced its push.
     */
    private suspend fun applyReservations(rows: List<JsonObject>) {
        val dao = db.reservationDao()
        val pendingIds = (
            db.opQueueDao().queuedOfType("reservation.create") +
                db.opQueueDao().queuedOfType("reservation.seat") +
                db.opQueueDao().queuedOfType("reservation.cancel") +
                db.opQueueDao().queuedOfType("reservation.noShow")
            ).mapNotNull { op -> parsePayload(op.payloadJson)?.let { it.str("reservationId") ?: it.str("id") } }
            .toSet()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pendingIds) continue
            val status = row.str("status") ?: "pending"
            if (status == "cancelled" || status == "no_show" || status == "completed") {
                dao.delete(id); continue
            }
            val tableId = row.str("tableId") ?: continue
            dao.upsert(
                ReservationEntity(
                    id = id,
                    tableId = tableId,
                    customerName = row.str("customerName") ?: "",
                    phone = row.str("phone"),
                    partySize = row.int("partySize") ?: 2,
                    startAt = parseEpoch(row.str("startAt")),
                    endAt = parseEpoch(row.str("endAt")),
                    status = status,
                    notes = row.str("notes"),
                    seatedOrderId = row.str("seatedOrderId"),
                    syncStatus = "synced",
                    updatedAt = parseEpoch(row.str("updatedAt")),
                ),
            )
        }
    }

    private fun parsePayload(payloadJson: String): JsonObject? =
        runCatching { Json.parseToJsonElement(payloadJson) as? JsonObject }.getOrNull()

    /**
     * Ids of rows with a still-queued master-data op of the given types. A pull
     * that raced an un-pushed local edit must NOT overwrite these — the server
     * wins only once the op has applied and the next pull re-delivers it.
     */
    private suspend fun pendingIds(vararg types: String): Set<String> =
        types.flatMap { db.opQueueDao().queuedOfType(it) }
            .mapNotNull { op -> parsePayload(op.payloadJson)?.str("id") }
            .toSet()

    private suspend fun applyProducts(rows: List<JsonObject>) {
        val dao = db.productDao()
        val pending = pendingIds("product.upsert", "product.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            if (row.deleted()) { dao.delete(id); continue }
            val category = row["category"] as? JsonObject
            val uom = row["uom"] as? JsonObject
            val tax = row["tax"] as? JsonObject
            dao.upsertAll(
                listOf(
                    ProductEntity(
                        id = id,
                        code = row.str("code"),
                        sku = row.str("sku"),
                        barcode = row.str("barcode"),
                        name = row.str("name") ?: "",
                        description = row.str("description"),
                        image = row.str("image"),
                        salesPrice = row.num("salesPrice") ?: 0.0,
                        costPrice = row.num("costPrice") ?: 0.0,
                        categoryId = row.str("categoryId"),
                        categoryName = category?.str("name"),
                        uomName = uom?.str("name"),
                        taxId = row.str("taxId"),
                        taxRate = tax?.num("rate") ?: 0.0,
                        taxInclusive = row.bool("taxInclusive") ?: false,
                        isActive = row.bool("isActive") ?: true,
                        isService = row.bool("isService") ?: false,
                        updatedAt = parseEpoch(row.str("updatedAt")),
                    ),
                ),
            )
        }
    }

    private suspend fun applyProductPackagings(rows: List<JsonObject>) {
        val dao = db.productPackagingDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
            // No deletedAt on this model — a deactivated pack is removed locally.
            if (row.bool("isActive") == false) { dao.delete(id); continue }
            val productId = row.str("productId") ?: continue
            dao.upsertAll(
                listOf(
                    ProductPackagingEntity(
                        id = id,
                        productId = productId,
                        name = row.str("name") ?: "",
                        quantity = row.num("quantity") ?: 1.0,
                        barcode = row.str("barcode"),
                        isActive = true,
                    ),
                ),
            )
        }
    }

    private suspend fun applyProductCategories(rows: List<JsonObject>) {
        val dao = db.productCategoryDao()
        val pending = pendingIds("productCategory.upsert", "productCategory.delete")
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            if (row.deleted()) { dao.delete(id); continue }
            dao.upsertAll(
                listOf(
                    ProductCategoryEntity(
                        id = id,
                        name = row.str("name") ?: "",
                        parentId = row.str("parentId"),
                    ),
                ),
            )
        }
    }

    /** Device-visible channels only (server already filtered by syncToDevices). */
    private suspend fun applyConversations(rows: List<JsonObject>) {
        val dao = db.conversationDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (row.deleted()) { dao.delete(id); continue }
            val name = row.str("name") ?: row.str("kind") ?: "Channel"
            val updatedAt = parseEpoch(row.str("updatedAt"))
            dao.upsert(
                listOf(
                    ConversationEntity(
                        id = id,
                        title = name,
                        type = row.str("kind") ?: "channel",
                        // Preserve any newer local activity; a fresh row starts at updatedAt.
                        lastMessageAt = (dao.byId(id)?.lastMessageAt ?: 0L).coerceAtLeast(updatedAt),
                        lastMessagePreview = dao.byId(id)?.lastMessagePreview,
                        updatedAt = updatedAt,
                    ),
                ),
            )
        }
    }

    /**
     * Append-only messages, keyed by the seq cursor server-side. Guards:
     *  • skip ids with a still-queued local `message.send` (un-pushed optimistic
     *    bubble) so the pull can't clobber a mid-flight send;
     *  • preserve a locally-composed message's `outbound` direction on echo-back;
     *  • set the authoritative `seq` and flip to `sent`.
     * Retention (shared till): prune >30 days and keep ≤500 per conversation.
     */
    private suspend fun applyMessages(rows: List<JsonObject>) {
        val mDao = db.messageDao()
        val pending = pendingIdsByKey("message.send", "clientId", "id")
        val touched = mutableSetOf<String>()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (id in pending) continue
            val conversationId = row.str("conversationId") ?: continue
            val existing = mDao.byId(id)
            val senderUserId = row.str("senderUserId")
            val senderName = existing?.senderName
                ?: senderUserId?.let { db.staffDao().byId(it)?.let { s -> listOfNotNull(s.firstName, s.lastName).joinToString(" ").trim() } }
                ?: (row.str("senderType") ?: "Staff")
            val occurredAt = parseEpoch(row.str("occurredAt"))
            mDao.upsert(
                listOf(
                    MessageEntity(
                        id = id,
                        conversationId = conversationId,
                        senderUserId = senderUserId,
                        senderName = senderName.ifBlank { "Staff" },
                        // A message we composed here keeps its outbound identity on echo-back.
                        direction = existing?.direction ?: "inbound",
                        body = row.str("body") ?: "",
                        occurredAt = occurredAt,
                        seq = row.str("syncSequence")?.toLongOrNull() ?: existing?.seq,
                        deliveryState = "sent",
                        lastError = null,
                    ),
                ),
            )
            db.conversationDao().touch(conversationId, occurredAt, (row.str("body") ?: "").take(80))
            touched += conversationId
        }
        // Retention.
        mDao.pruneOlderThan(Instant.now().toEpochMilli() - 30L * 24 * 60 * 60 * 1000)
        for (cid in touched) mDao.trimConversation(cid, 500)
    }

    // ---------------------- cash & inventory reference data ----------------------

    private suspend fun applyPaymentMethods(rows: List<JsonObject>) {
        db.cashInventoryDao().replacePaymentMethods(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                if (row.bool("isActive") == false) return@mapNotNull null
                PaymentMethodEntity(
                    id = id,
                    code = row.str("code") ?: id,
                    label = row.str("label") ?: row.str("kind") ?: "Tender",
                    kind = row.str("kind") ?: "cash",
                    accountId = row.str("accountId"),
                    accountName = row.str("accountName"),
                    requiresReference = row.bool("requiresReference") ?: false,
                    trackInShift = row.bool("trackInShift") ?: false,
                    sortOrder = row.int("sortOrder") ?: 0,
                )
            },
        )
    }

    private suspend fun applyLedgerAccounts(rows: List<JsonObject>) {
        db.cashInventoryDao().replaceAccounts(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                LedgerAccountEntity(
                    id = id,
                    code = row.str("code") ?: "",
                    name = row.str("name") ?: "",
                    categoryKey = row.str("categoryKey"),
                    classification = row.str("classification"),
                    isCashEquivalent = row.bool("isCashEquivalent") ?: false,
                    balance = row.num("balance"),
                    roles = (row["roles"] as? JsonArray)
                        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                        ?.joinToString(",") ?: "",
                )
            },
        )
    }

    private suspend fun applyExpenseCategories(rows: List<JsonObject>) {
        db.cashInventoryDao().replaceExpenseCategories(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                ExpenseCategoryEntity(id = id, name = row.str("name") ?: "", accountId = row.str("accountId"))
            },
        )
    }

    private suspend fun applyStockLocations(rows: List<JsonObject>) {
        db.cashInventoryDao().replaceLocations(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                StockLocationEntity(id = id, code = row.str("code") ?: "", name = row.str("name") ?: "", type = row.str("type") ?: "warehouse")
            },
        )
    }

    private suspend fun applyStockLevels(rows: List<JsonObject>) {
        db.cashInventoryDao().upsertStockLevels(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                StockLevelEntity(
                    id = id,
                    productId = row.str("productId") ?: return@mapNotNull null,
                    variantId = row.str("variantId"),
                    locationId = row.str("locationId") ?: return@mapNotNull null,
                    quantity = row.num("quantity") ?: 0.0,
                    updatedAt = parseEpoch(row.str("updatedAt")),
                )
            },
        )
    }

    /** Server suppliers merge into the device supplier list (device-made ones stay). */
    private suspend fun applySuppliers(rows: List<JsonObject>) {
        val dao = db.supplierDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
            if (row.deleted()) { dao.delete(id); continue }
            dao.upsert(
                SupplierEntity(
                    id = id,
                    name = row.str("name") ?: "",
                    phone = row.str("phone"),
                    note = row.str("notes"),
                    createdAt = dao.byId(id)?.createdAt ?: parseEpoch(row.str("updatedAt")),
                ),
            )
        }
    }

    /** Like pendingIds but reads the id from any of the given payload keys in order. */
    private suspend fun pendingIdsByKey(type: String, vararg keys: String): Set<String> =
        db.opQueueDao().queuedOfType(type)
            .mapNotNull { op -> parsePayload(op.payloadJson)?.let { p -> keys.firstNotNullOfOrNull { p.str(it) } } }
            .toSet()

    /** Parse ISO-8601 date string or epoch-millis number to Long. */
    private fun parseEpoch(s: String?): Long {
        if (s == null) return 0L
        val n = s.toLongOrNull()
        if (n != null) return n
        return try { java.time.Instant.parse(s).toEpochMilli() } catch (_: Exception) { 0L }
    }
}
