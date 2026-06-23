package com.cafe.pos.data.repository

import com.cafe.pos.data.api.ApiErrorMapper
import com.cafe.pos.data.api.CatalogApi
import com.cafe.pos.data.local.CatalogDao
import com.cafe.pos.data.local.ProductEntity
import com.cafe.pos.data.model.ProductDto
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Wraps the catalog endpoints + Room cache. The terminal wants the full active
 * catalog with a sub-200ms perceived load, so we serve cached rows first, then
 * silently refresh in the background.
 */
@Singleton
class CatalogRepository @Inject constructor(
    private val api: CatalogApi,
    private val dao: CatalogDao,
) {

    /** Stream of cached products. Empty until first refresh. */
    val cachedProducts: Flow<List<ProductDto>> =
        dao.observeAll().map { rows -> rows.map { it.toDto() } }

    suspend fun refresh(search: String? = null, categoryId: String? = null): List<ProductDto> {
        val res = try {
            api.products(search = search?.ifBlank { null }, categoryId = categoryId)
        } catch (t: Throwable) {
            // Fall through with cached rows if offline; do not throw.
            return dao.snapshot().map { it.toDto() }
        }
        val products = res.data
        dao.replaceAll(products.map { it.toEntity() })
        return products
    }

    suspend fun lookupSku(sku: String): ProductDto? {
        return try {
            api.lookup(sku).firstOrNull()
        } catch (t: Throwable) {
            // Cached lookup fallback
            dao.findBySku(sku)?.toDto()
        }
    }

    suspend fun productById(id: String): ProductDto? =
        dao.findById(id)?.toDto() ?: try { api.product(id) } catch (t: Throwable) { null }
}

private fun ProductDto.toEntity() = ProductEntity(
    id = id,
    code = code,
    sku = sku,
    name = name,
    productType = productType,
    salesPrice = salesPrice,
    categoryId = categoryId,
    categoryName = category?.name,
    isActive = isActive,
)

private fun ProductEntity.toDto() = ProductDto(
    id = id,
    code = code,
    sku = sku,
    name = name,
    productType = productType,
    salesPrice = salesPrice,
    categoryId = categoryId,
    category = categoryName?.let { com.cafe.pos.data.model.CategoryDto(id = categoryId ?: "", name = it) },
    isActive = isActive,
)