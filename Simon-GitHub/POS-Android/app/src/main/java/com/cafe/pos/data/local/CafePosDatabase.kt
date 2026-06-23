package com.cafe.pos.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.cafe.pos.data.model.CheckoutLineDto
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.flow.Flow

/**
 * Queue of sales captured while the terminal is offline. Each pending sale
 * carries a client-generated `idempotencyKey`; the server dedupes retries
 * against it. Drain order is FIFO by `createdAt`.
 *
 * Schema v2 adds:
 *   - `nextAttemptAt` — exponential backoff timestamp
 *   - `lastSyncAt`   — last time the SyncWorker attempted this row
 *
 * Migration is non-destructive (adds columns with defaults), so existing
 * queues survive an app upgrade.
 */
@Entity(tableName = "pending_sales")
data class PendingSaleEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "idempotencyKey") val idempotencyKey: String,
    @ColumnInfo(name = "payload") val payload: String,         // JSON CheckoutRequest
    @ColumnInfo(name = "cashSessionId") val cashSessionId: String?,
    @ColumnInfo(name = "createdAt") val createdAt: Long,
    @ColumnInfo(name = "attempts") val attempts: Int = 0,
    @ColumnInfo(name = "lastError") val lastError: String? = null,
    @ColumnInfo(name = "nextAttemptAt", defaultValue = "0") val nextAttemptAt: Long = 0L,
    @ColumnInfo(name = "lastSyncAt") val lastSyncAt: Long? = null,
)

@Dao
interface PendingSaleDao {
    @Query("SELECT * FROM pending_sales ORDER BY createdAt ASC")
    fun observeAll(): Flow<List<PendingSaleEntity>>

    @Query("SELECT * FROM pending_sales ORDER BY createdAt ASC")
    suspend fun snapshot(): List<PendingSaleEntity>

    @Query("SELECT COUNT(*) FROM pending_sales")
    fun observeCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM pending_sales")
    suspend fun count(): Int

    @Query("SELECT * FROM pending_sales WHERE nextAttemptAt <= :now ORDER BY createdAt ASC")
    suspend fun dueForRetry(now: Long): List<PendingSaleEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: PendingSaleEntity)

    @Query("DELETE FROM pending_sales WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE pending_sales SET attempts = attempts + 1, lastError = :err, lastSyncAt = :now, nextAttemptAt = :nextAt WHERE id = :id")
    suspend fun recordFailure(id: String, err: String, now: Long, nextAt: Long)

    @Query("UPDATE pending_sales SET lastSyncAt = :now WHERE id = :id")
    suspend fun recordSuccess(id: String, now: Long)
}

@Database(
    entities = [ProductEntity::class, PendingSaleEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class CafePosDatabase : RoomDatabase() {
    abstract fun catalogDao(): CatalogDao
    abstract fun pendingSaleDao(): PendingSaleDao

    companion object {
        val moshi: Moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
        private val lineListType = Types.newParameterizedType(List::class.java, CheckoutLineDto::class.java)
        val lineListAdapter = moshi.adapter<List<CheckoutLineDto>>(lineListType)

        /** v1 → v2: add `nextAttemptAt` (default 0 = "ready now") and `lastSyncAt`
         *  (nullable) to `pending_sales`. Non-destructive; existing rows survive. */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE pending_sales ADD COLUMN nextAttemptAt INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE pending_sales ADD COLUMN lastSyncAt INTEGER")
            }
        }
    }
}