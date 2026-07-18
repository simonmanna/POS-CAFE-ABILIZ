package com.poscafe.pos.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Sales captured on-device. Append-only facts (conflict rule: device wins for
 * its own sales). `serverInvoiceId`/`finalInvoiceNumber` are filled in when
 * the push response returns the mapping; until then receipts print the
 * provisional number with an OFFLINE marker.
 */
@Entity(tableName = "local_sales")
data class LocalSaleEntity(
    /** Client-minted uuid; also the op id pushed to the server. */
    @PrimaryKey val id: String,
    val occurredAt: Long,
    val actorUserId: String,
    val cashSessionLocalId: String?,
    val tableId: String?,
    val orderType: String,
    /** D<n>-NNNNNN printed on the offline receipt. */
    val provisionalNumber: String,
    val subtotal: Double,
    val taxAmount: Double,
    val total: Double,
    val tendersJson: String,
    val linesJson: String,
    /** queued | pushed | failed */
    val syncStatus: String,
    val serverInvoiceId: String?,
    val finalInvoiceNumber: String?,
    val lastError: String?,
)

/**
 * Cash sessions run on-device. The local id is client-minted and sent as
 * `clientId` in the open op so queued sales can reference the session before
 * the server ever hears about it.
 */
@Entity(tableName = "local_cash_sessions")
data class LocalCashSessionEntity(
    @PrimaryKey val id: String,
    val cashRegisterId: String,
    val actorUserId: String,
    val openedAt: Long,
    val closedAt: Long?,
    val openingFloat: Double,
    val closingCounted: Double?,
    val varianceReason: String?,
    val status: String, // open | closed
    val syncStatus: String, // queued | pushed | failed
    val serverId: String?,
)

@Entity(tableName = "local_cash_movements")
data class LocalCashMovementEntity(
    @PrimaryKey val id: String,
    val sessionLocalId: String,
    val movementType: String, // pay_in | pay_out | adjustment
    val amount: Double,
    val reason: String?,
    val occurredAt: Long,
    val syncStatus: String,
)

/**
 * The push queue. One row per op, strictly ordered by deviceSeq. Never
 * deleted on failure — failed ops flip to `failed` and surface in the sync
 * screen (mirror of the server's dead-letter philosophy).
 */
@Entity(tableName = "op_queue")
data class OpQueueEntity(
    @PrimaryKey val opId: String,
    val deviceSeq: Long,
    val type: String,
    val actorUserId: String,
    val occurredAt: Long,
    val payloadJson: String,
    val status: String, // queued | pushed | failed
    val attempts: Int,
    val lastError: String?,
)
