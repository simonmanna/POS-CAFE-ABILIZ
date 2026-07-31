package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.serialization.json.JsonObject
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Central enqueue for master-data authoring ops (menu, products, taxes,
 * registers, tables, …). Editors always write Room locally first; this only
 * decides whether the edit ALSO travels to the server:
 *
 *   - standalone device → no-op (there is nothing to sync to), and
 *   - connected device  → queue an op in the shared FIFO op-queue so the
 *     server applies the same edit (client-minted UUID == server id, no remap).
 *
 * Mirrors the local-first + `!config.standalone` gate already used by
 * [CustomerRepository]. An op needs a PIN-verified actor to be attributable;
 * without one it stays local until the next signed-in edit.
 */
@Singleton
class MasterDataSync @Inject constructor(
    private val opQueue: OpQueueDao,
    private val config: DeviceConfig,
    private val auth: AuthRepository,
) {
    /** True on connected devices with a signed-in cashier — i.e. ops will queue. */
    val syncing: Boolean get() = !config.standalone && auth.current != null

    /** Queue one master-data op. Silently skipped in standalone / when signed out. */
    suspend fun enqueue(type: String, payload: JsonObject) {
        if (config.standalone) return
        val actor = auth.current?.userId ?: return
        val now = System.currentTimeMillis()
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = UUID.randomUUID().toString(),
                deviceSeq = seq,
                type = type,
                actorUserId = actor,
                occurredAt = now,
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }
}
