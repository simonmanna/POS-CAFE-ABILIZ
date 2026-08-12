package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.ConversationDao
import com.poscafe.pos.data.local.dao.ConversationReadStateDao
import com.poscafe.pos.data.local.dao.MessageDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.entity.ConversationEntity
import com.poscafe.pos.data.local.entity.ConversationReadStateEntity
import com.poscafe.pos.data.local.entity.MessageEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline staff messaging. Send is optimistic: the bubble is written locally as
 * `sending` BEFORE any network, and an op is queued. The op_queue IS the outbox
 * (no second outbox table) — SyncRepository flips the bubble to `sent`/`failed`
 * from the push result, and the next pull backfills the authoritative seq.
 *
 * The client-minted message id IS the server id, so a replay upserts. Retry
 * re-queues the SAME id (never a fresh uuid) — a new id after an ambiguous
 * timeout is exactly how a message duplicates.
 */
@Singleton
class MessagingRepository @Inject constructor(
    private val conversations: ConversationDao,
    private val messages: MessageDao,
    private val readState: ConversationReadStateDao,
    private val opQueue: OpQueueDao,
) {
    fun conversations(): Flow<List<ConversationEntity>> = conversations.observeAll()

    fun thread(conversationId: String): Flow<List<MessageEntity>> = messages.observeThread(conversationId)

    fun unread(conversationId: String, userId: String): Flow<Int> = messages.observeUnread(conversationId, userId)

    /** Compose + queue a message. Returns the (client == server) message id. */
    suspend fun send(conversationId: String, body: String, actorUserId: String, actorName: String): String {
        val id = UUID.randomUUID().toString()
        val now = Instant.now().toEpochMilli()
        messages.upsert(
            listOf(
                MessageEntity(
                    id = id,
                    conversationId = conversationId,
                    senderUserId = actorUserId,
                    senderName = actorName,
                    direction = "outbound",
                    body = body,
                    occurredAt = now,
                    seq = null,
                    deliveryState = "sending",
                    lastError = null,
                ),
            ),
        )
        conversations.touch(conversationId, now, body.take(80))
        enqueueSend(id, conversationId, body, actorUserId, now)
        return id
    }

    /** Re-queue a failed message under the SAME id (idempotent server-side). */
    suspend fun retry(messageId: String, actorUserId: String) {
        val m = messages.byId(messageId) ?: return
        messages.markState(messageId, "sending", null)
        enqueueSend(messageId, m.conversationId, m.body, actorUserId, m.occurredAt)
    }

    suspend fun markRead(conversationId: String, userId: String, lastMessageId: String?) {
        readState.put(ConversationReadStateEntity(conversationId, userId, Instant.now().toEpochMilli()))
        if (lastMessageId != null) {
            opQueue.enqueueNext { seq ->
                OpQueueEntity(
                    opId = UUID.randomUUID().toString(),
                    deviceSeq = seq,
                    type = "message.markRead",
                    actorUserId = userId,
                    occurredAt = Instant.now().toEpochMilli(),
                    payloadJson = buildJsonObject {
                        put("conversationId", conversationId)
                        put("messageId", lastMessageId)
                    }.toString(),
                    status = "queued",
                    attempts = 0,
                    lastError = null,
                )
            }
        }
    }

    private suspend fun enqueueSend(id: String, conversationId: String, body: String, actorUserId: String, occurredAt: Long) {
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = id, // opId == messageId == server id
                deviceSeq = seq,
                type = "message.send",
                actorUserId = actorUserId,
                occurredAt = occurredAt,
                payloadJson = buildJsonObject {
                    put("clientId", id)
                    put("conversationId", conversationId)
                    put("body", body)
                }.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }
}
