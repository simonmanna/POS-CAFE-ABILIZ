package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.ReservationDao
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.data.local.entity.ReservationEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline table reservations. A booking is written locally (device wins) and a
 * `reservation.create` op replays it; the client-minted id becomes the server
 * row id, so seat/cancel/no-show reference the same id with no remap. Terminal
 * transitions (seat/cancel/no-show) queue their own ops; the server is the
 * authority and a later pull reconciles the true state.
 */
@Singleton
class ReservationRepository @Inject constructor(
    private val dao: ReservationDao,
    private val opQueue: OpQueueDao,
) {
    fun active(): Flow<List<ReservationEntity>> = dao.active()

    suspend fun create(
        actorUserId: String,
        tableId: String,
        customerName: String,
        phone: String?,
        partySize: Int,
        startAt: Long,
        endAt: Long,
        notes: String?,
    ): ReservationEntity {
        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        val row = ReservationEntity(
            id = id,
            tableId = tableId,
            customerName = customerName,
            phone = phone,
            partySize = partySize,
            startAt = startAt,
            endAt = endAt,
            status = "pending",
            notes = notes,
            seatedOrderId = null,
            syncStatus = "queued",
            updatedAt = now.toEpochMilli(),
        )
        dao.upsert(row)
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = id,
                deviceSeq = seq,
                type = "reservation.create",
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject {
                    put("id", id)
                    put("clientId", id) // dependency tracking for later seat/cancel ops
                    put("tableId", tableId)
                    put("customerName", customerName)
                    phone?.let { put("phone", it) }
                    put("partySize", partySize)
                    put("startAt", Instant.ofEpochMilli(startAt).toString())
                    put("endAt", Instant.ofEpochMilli(endAt).toString())
                    notes?.let { put("notes", it) }
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
        return row
    }

    suspend fun seat(actorUserId: String, id: String) = transition(actorUserId, id, "reservation.seat", "seated")
    suspend fun cancel(actorUserId: String, id: String) = transition(actorUserId, id, "reservation.cancel", "cancelled")
    suspend fun noShow(actorUserId: String, id: String) = transition(actorUserId, id, "reservation.noShow", "no_show")

    private suspend fun transition(actorUserId: String, reservationId: String, opType: String, newStatus: String) {
        val now = Instant.now()
        // Optimistic local status; a failed op is re-reconciled by the next pull.
        dao.setStatus(reservationId, newStatus, null, "queued", now.toEpochMilli())
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = UUID.randomUUID().toString(),
                deviceSeq = seq,
                type = opType,
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject { put("reservationId", reservationId) }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }
}
