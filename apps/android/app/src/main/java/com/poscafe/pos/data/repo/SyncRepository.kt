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
        res.data["partners"]?.let { applyPartners(it) }

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
                    db.saleDao().markSync(result.opId, "failed", null, null, result.error)
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
            db.saleDao().markSync(opId, "pushed", invoiceId, invoiceNumber, null)
        }
        // cash_session.open ops key the map by the session's clientId (== opId).
        mapping?.get(opId)?.let { serverId ->
            db.cashSessionDao().markSync(opId, "pushed", serverId)
        }
        // customer.upsert applied — the local row now mirrors the server.
        mapping?.get("customerId")?.let { db.customerDao().markSynced(it) }
    }

    // ---------------------- pull-apply per scope ----------------------

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
    private fun JsonObject.int(key: String): Int? = num(key)?.toInt()
    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
    private fun JsonObject.deleted(): Boolean = this["deletedAt"]?.let { it !is JsonNull } == true

    private suspend fun applyCategories(rows: List<JsonObject>) {
        val dao = db.menuDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
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
        for (row in rows) {
            val id = row.str("id") ?: continue
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
        for (row in rows) {
            val id = row.str("id") ?: continue
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
        for (row in rows) {
            val id = row.str("id") ?: continue
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
        db.tableDao().upsertAll(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
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
        db.registerDao().upsertAll(
            rows.mapNotNull { row ->
                val id = row.str("id") ?: return@mapNotNull null
                CashRegisterEntity(id = id, code = row.str("code") ?: "", name = row.str("name"))
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

    private fun parsePayload(payloadJson: String): JsonObject? =
        runCatching { Json.parseToJsonElement(payloadJson) as? JsonObject }.getOrNull()

    private suspend fun applyProducts(rows: List<JsonObject>) {
        val dao = db.productDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
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

    private suspend fun applyProductCategories(rows: List<JsonObject>) {
        val dao = db.productCategoryDao()
        for (row in rows) {
            val id = row.str("id") ?: continue
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

    /** Parse ISO-8601 date string or epoch-millis number to Long. */
    private fun parseEpoch(s: String?): Long {
        if (s == null) return 0L
        val n = s.toLongOrNull()
        if (n != null) return n
        return try { java.time.Instant.parse(s).toEpochMilli() } catch (_: Exception) { 0L }
    }
}
