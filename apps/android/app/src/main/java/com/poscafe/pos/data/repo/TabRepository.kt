package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.TabDao
import com.poscafe.pos.data.local.entity.LocalTabEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline dine-in tabs. A tab is just a persisted cart bound to a table, so a
 * cashier can leave the order and come back, add rounds, fire the kitchen, and
 * settle later. Nothing touches the server until settle — settle reuses the
 * ordinary `sale.checkout` op (see [SaleRepository]); a split settles each bill
 * as its own `sale.checkout`. No new server op is needed.
 */
@Singleton
class TabRepository @Inject constructor(
    private val tabDao: TabDao,
) {
    data class Tab(
        val tableId: String,
        val lines: List<CartEngine.CartLine>,
        val guestCount: Int,
        val partnerId: String?,
        val firedLineIds: Set<String>,
    )

    private val json = Json { encodeDefaults = false; ignoreUnknownKeys = true }
    private val lineSer = ListSerializer(CartEngine.CartLine.serializer())
    private val idSer = ListSerializer(String.serializer())

    /** Table ids with an open tab, for badging the floor plan. */
    fun openTableIds(): Flow<List<String>> = tabDao.openTableIds()

    suspend fun load(tableId: String): Tab? {
        val e = tabDao.byTable(tableId) ?: return null
        return Tab(
            tableId = e.tableId,
            lines = runCatching { json.decodeFromString(lineSer, e.linesJson) }.getOrDefault(emptyList()),
            guestCount = e.guestCount,
            partnerId = e.partnerId,
            firedLineIds = runCatching { json.decodeFromString(idSer, e.firedLineIdsJson) }.getOrDefault(emptyList()).toSet(),
        )
    }

    /** Persist the tab. An empty line set deletes the tab (frees the table). */
    suspend fun save(
        tableId: String,
        lines: List<CartEngine.CartLine>,
        guestCount: Int,
        partnerId: String?,
        firedLineIds: Set<String>,
        actorUserId: String?,
    ) {
        if (lines.isEmpty()) {
            tabDao.delete(tableId)
            return
        }
        val now = System.currentTimeMillis()
        val existing = tabDao.byTable(tableId)
        // Only keep fire markers for lines that still exist on the tab.
        val liveFired = firedLineIds.intersect(lines.map { it.lineId }.toSet())
        tabDao.upsert(
            LocalTabEntity(
                tableId = tableId,
                linesJson = json.encodeToString(lineSer, lines),
                guestCount = guestCount,
                partnerId = partnerId,
                firedLineIdsJson = json.encodeToString(idSer, liveFired.toList()),
                openedAt = existing?.openedAt ?: now,
                updatedAt = now,
                actorUserId = actorUserId,
            ),
        )
    }

    suspend fun clear(tableId: String) = tabDao.delete(tableId)
}
