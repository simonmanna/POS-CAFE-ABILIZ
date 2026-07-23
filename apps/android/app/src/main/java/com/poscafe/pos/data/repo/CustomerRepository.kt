package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.CustomerDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.entity.CustomerEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Device customer book. Writes are local-first; on connected devices every
 * edit also enqueues a `customer.upsert` / `customer.delete` op so the server
 * Partner exists BEFORE any sale that references it — customer ops and sales
 * share the same FIFO op queue (deviceSeq order), so ordering is guaranteed.
 */
@Singleton
class CustomerRepository @Inject constructor(
    private val customerDao: CustomerDao,
    private val opQueue: OpQueueDao,
    private val config: DeviceConfig,
) {
    /** Upsert locally + queue the server op. Returns the stored row. */
    suspend fun save(entity: CustomerEntity, actorUserId: String?): CustomerEntity {
        val now = System.currentTimeMillis()
        val row = entity.copy(updatedAt = now, syncStatus = "local")
        customerDao.upsert(row)
        // Standalone devices never push; without a PIN-verified actor the op
        // cannot be attributed, so it stays local until the next signed-in edit.
        if (config.standalone || actorUserId == null) return row
        val payload = buildJsonObject {
            put("id", row.id)
            put("name", row.name)
            row.phone?.let { put("phone", it) }
            row.email?.let { put("email", it) }
            row.note?.let { put("note", it) }
            put("loyaltyPoints", row.loyaltyPoints)
            put("clientId", row.id)
        }
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = UUID.randomUUID().toString(),
                deviceSeq = seq,
                type = "customer.upsert",
                actorUserId = actorUserId,
                occurredAt = now,
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
        return row
    }

    suspend fun delete(id: String, actorUserId: String?) {
        customerDao.delete(id)
        if (config.standalone || actorUserId == null) return
        val payload = buildJsonObject { put("id", id) }
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = UUID.randomUUID().toString(),
                deviceSeq = seq,
                type = "customer.delete",
                actorUserId = actorUserId,
                occurredAt = System.currentTimeMillis(),
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }
}
