package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.entity.LocalCashMovementEntity
import com.poscafe.pos.data.local.entity.LocalCashSessionEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline cash sessions. The device runs its OWN register (one CashRegister
 * per device — structurally no cross-device session conflicts). GL posting
 * happens exclusively on the server when the ops replay in order:
 * open → sales → movements → close.
 */
@Singleton
class CashSessionRepository @Inject constructor(
    private val dao: CashSessionDao,
    private val saleDao: SaleDao,
    private val opQueue: OpQueueDao,
) {
    fun openSession(): Flow<LocalCashSessionEntity?> = dao.openFlow()

    suspend fun open(actorUserId: String, cashRegisterId: String, openingFloat: Double): LocalCashSessionEntity {
        check(dao.open() == null) { "A session is already open on this device" }
        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        val session = LocalCashSessionEntity(
            id = id,
            cashRegisterId = cashRegisterId,
            actorUserId = actorUserId,
            openedAt = now.toEpochMilli(),
            closedAt = null,
            openingFloat = openingFloat,
            closingCounted = null,
            varianceReason = null,
            status = "open",
            syncStatus = "queued",
            serverId = null,
        )
        dao.insert(session)
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = id,
                deviceSeq = seq,
                type = "cash_session.open",
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject {
                    put("cashRegisterId", cashRegisterId)
                    put("openingFloat", openingFloat)
                    put("clientId", id)
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
        return session
    }

    suspend fun recordMovement(actorUserId: String, movementType: String, amount: Double, reason: String?) {
        val session = dao.open() ?: error("No open session")
        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        dao.insertMovement(
            LocalCashMovementEntity(
                id = id,
                sessionLocalId = session.id,
                movementType = movementType,
                amount = amount,
                reason = reason,
                occurredAt = now.toEpochMilli(),
                syncStatus = "queued",
            ),
        )
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = id,
                deviceSeq = seq,
                type = "cash_session.movement",
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject {
                    put("sessionId", session.id) // clientId — resolved server-side
                    put("movementType", movementType)
                    put("amount", amount)
                    reason?.let { put("reason", it) }
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }

    suspend fun close(actorUserId: String, closingCounted: Double, varianceReason: String?) {
        val session = dao.open() ?: error("No open session")
        val now = Instant.now()
        dao.close(session.id, now.toEpochMilli(), closingCounted, varianceReason)
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = UUID.randomUUID().toString(),
                deviceSeq = seq,
                type = "cash_session.close",
                actorUserId = actorUserId,
                occurredAt = now.toEpochMilli(),
                payloadJson = buildJsonObject {
                    put("closingCounted", closingCounted)
                    varianceReason?.let { put("varianceReason", it) }
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }

    /** Local X-report: computed from Room, no server needed. */
    data class LocalXReport(val salesCount: Int, val salesTotal: Double, val openingFloat: Double, val expectedCash: Double)

    suspend fun xReport(): LocalXReport? {
        val session = dao.open() ?: return null
        val total = saleDao.sessionTotal(session.id)
        val count = saleDao.sessionCount(session.id)
        val movements = dao.movements(session.id)
        val movementNet = movements.sumOf {
            when (it.movementType) {
                "pay_in" -> it.amount
                "pay_out" -> -it.amount
                else -> it.amount
            }
        }
        return LocalXReport(
            salesCount = count,
            salesTotal = total,
            openingFloat = session.openingFloat,
            expectedCash = session.openingFloat + total + movementNet,
        )
    }
}
