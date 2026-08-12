package com.poscafe.pos.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.poscafe.pos.data.local.entity.ConversationEntity
import com.poscafe.pos.data.local.entity.ConversationReadStateEntity
import com.poscafe.pos.data.local.entity.MessageEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface ConversationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<ConversationEntity>)

    @Query("SELECT * FROM conversations ORDER BY lastMessageAt DESC")
    fun observeAll(): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun byId(id: String): ConversationEntity?

    @Query("DELETE FROM conversations WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE conversations SET lastMessageAt = :at, lastMessagePreview = :preview WHERE id = :id")
    suspend fun touch(id: String, at: Long, preview: String)
}

@Dao
interface MessageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<MessageEntity>)

    /** Ordered by user-facing chronology (occurredAt), NOT seq. */
    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY occurredAt ASC")
    fun observeThread(conversationId: String): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun byId(id: String): MessageEntity?

    @Query("UPDATE messages SET deliveryState = :state, lastError = :error WHERE id = :id")
    suspend fun markState(id: String, state: String, error: String?)

    @Query("UPDATE messages SET seq = :seq, deliveryState = 'sent', lastError = NULL WHERE id = :id")
    suspend fun markSent(id: String, seq: Long?)

    /** Unread inbound messages after the read cursor, for the badge. */
    @Query(
        "SELECT COUNT(*) FROM messages m " +
            "LEFT JOIN conversation_read_state r ON r.conversationId = m.conversationId AND r.userId = :userId " +
            "WHERE m.conversationId = :conversationId AND m.direction = 'inbound' " +
            "AND m.occurredAt > COALESCE(r.lastReadAt, 0)",
    )
    fun observeUnread(conversationId: String, userId: String): Flow<Int>

    @Query("DELETE FROM messages WHERE occurredAt < :before")
    suspend fun pruneOlderThan(before: Long)

    /** Keep at most :keep newest messages per conversation (retention on a shared till). */
    @Query(
        "DELETE FROM messages WHERE id IN (" +
            "SELECT id FROM messages WHERE conversationId = :conversationId " +
            "ORDER BY occurredAt DESC LIMIT -1 OFFSET :keep)",
    )
    suspend fun trimConversation(conversationId: String, keep: Int)
}

@Dao
interface ConversationReadStateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(row: ConversationReadStateEntity)

    @Query("SELECT lastReadAt FROM conversation_read_state WHERE conversationId = :conversationId AND userId = :userId")
    suspend fun lastReadAt(conversationId: String, userId: String): Long?
}
