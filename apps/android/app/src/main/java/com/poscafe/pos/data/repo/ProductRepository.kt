package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.ProductCategoryDao
import com.poscafe.pos.data.local.dao.ProductDao
import com.poscafe.pos.data.local.entity.ProductCategoryEntity
import com.poscafe.pos.data.local.entity.ProductEntity
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Authoring write-layer for retail products + their categories. Local-first
 * like [CatalogRepository]: writes Room, then enqueues product.upsert /
 * productCategory.upsert on connected devices (no-op standalone).
 */
@Singleton
class ProductRepository @Inject constructor(
    private val productDao: ProductDao,
    private val categoryDao: ProductCategoryDao,
    private val sync: MasterDataSync,
) {
    suspend fun saveProduct(row: ProductEntity) {
        productDao.upsertAll(listOf(row))
        sync.enqueue("product.upsert", buildJsonObject {
            put("id", row.id)
            row.code?.let { put("code", it) }
            put("name", row.name)
            row.sku?.let { put("sku", it) }
            row.barcode?.let { put("barcode", it) }
            row.description?.let { put("description", it) }
            row.categoryId?.let { put("categoryId", it) }
            row.taxId?.let { put("taxId", it) }
            put("salesPrice", row.salesPrice)
            put("costPrice", row.costPrice)
            row.image?.let { put("image", it) }
            put("isActive", row.isActive)
        })
    }

    suspend fun deleteProduct(id: String) {
        productDao.delete(id)
        sync.enqueue("product.delete", buildJsonObject { put("id", id) })
    }

    suspend fun saveCategory(row: ProductCategoryEntity) {
        categoryDao.upsertAll(listOf(row))
        sync.enqueue("productCategory.upsert", buildJsonObject {
            put("id", row.id)
            put("name", row.name)
            row.parentId?.let { put("parentId", it) }
        })
    }

    suspend fun deleteCategory(id: String) {
        categoryDao.delete(id)
        sync.enqueue("productCategory.delete", buildJsonObject { put("id", id) })
    }
}
