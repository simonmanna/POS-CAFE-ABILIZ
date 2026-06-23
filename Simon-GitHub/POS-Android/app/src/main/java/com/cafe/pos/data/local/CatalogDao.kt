package com.cafe.pos.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/**
 * Cached product rows for offline-first browsing on the terminal. The web client
 * uses TanStack Query's offline-queue for the same purpose; we use Room here
 * because Android needs a real on-disk cache to survive process death.
 */
@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "code") val code: String,
    @ColumnInfo(name = "sku") val sku: String?,
    @ColumnInfo(name = "name") val name: String,
    @ColumnInfo(name = "productType") val productType: String,
    @ColumnInfo(name = "salesPrice") val salesPrice: String?,
    @ColumnInfo(name = "categoryId") val categoryId: String?,
    @ColumnInfo(name = "categoryName") val categoryName: String?,
    @ColumnInfo(name = "isActive") val isActive: Boolean,
)

@Dao
interface CatalogDao {
    @Query("SELECT * FROM products ORDER BY name")
    fun observeAll(): Flow<List<ProductEntity>>

    @Query("SELECT * FROM products ORDER BY name")
    suspend fun snapshot(): List<ProductEntity>

    @Query("SELECT * FROM products WHERE sku = :sku LIMIT 1")
    suspend fun findBySku(sku: String): ProductEntity?

    @Query("SELECT * FROM products WHERE id = :id LIMIT 1")
    suspend fun findById(id: String): ProductEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<ProductEntity>)

    @Query("DELETE FROM products")
    suspend fun clear()

    @Transaction
    suspend fun replaceAll(rows: List<ProductEntity>) {
        clear()
        upsert(rows)
    }
}