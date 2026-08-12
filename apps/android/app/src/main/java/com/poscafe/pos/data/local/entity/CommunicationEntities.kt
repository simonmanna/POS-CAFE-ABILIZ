package com.poscafe.pos.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Offline messaging (Phase 5). Only device-visible channels sync here — a shared
 * till never holds DMs or customer threads. Text-only in v1.
 */
@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val title: String,
    val type: String, // channel (v1)
    val lastMessageAt: Long,
    val lastMessagePreview: String?,
    val updatedAt: Long,
)

/**
 * A message. The PK is client-minted on send and IS the server id, so a replay
 * upserts. `seq` is null until the server assigns one (local-only messages sort
 * last). `deliveryState` is a projection of the op-queue status, NOT a second
 * outbox — the op_queue is the outbox.
 */
@Entity(
    tableName = "messages",
    indices = [Index("conversationId"), Index("seq"), Index("occurredAt")],
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val senderUserId: String?,
    val senderName: String,
    val direction: String, // outbound | inbound
    val body: String,
    val occurredAt: Long,
    /** Server sync sequence; null for a message composed locally and not yet synced. */
    val seq: Long?,
    /** sending | sent | delivered | read | failed — a projection of the op status. */
    val deliveryState: String,
    val lastError: String?,
)

/** Per-user read cursor, computed on-device (the pull has no user identity). */
@Entity(tableName = "conversation_read_state", primaryKeys = ["conversationId", "userId"])
data class ConversationReadStateEntity(
    val conversationId: String,
    val userId: String,
    val lastReadAt: Long,
)
