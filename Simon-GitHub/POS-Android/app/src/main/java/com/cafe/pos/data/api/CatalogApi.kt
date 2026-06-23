package com.cafe.pos.data.api

import com.cafe.pos.data.model.CategoryDto
import com.cafe.pos.data.model.PaginatedProducts
import com.cafe.pos.data.model.ProductDto
import retrofit2.http.GET
import retrofit2.http.Query

/**
 * Catalog endpoints (modules/core/product). The POS terminal wants the *full* active
 * catalog; we paginate with a large page size to keep the request shape identical
 * to the web client.
 */
interface CatalogApi {

    @GET("products")
    suspend fun products(
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 500,
        @Query("search") search: String? = null,
        @Query("isActive") isActive: Boolean? = true,
        @Query("categoryId") categoryId: String? = null,
    ): PaginatedProducts

    @GET("products/{id}")
    suspend fun product(@retrofit2.http.Path("id") id: String): ProductDto

    @GET("product-categories")
    suspend fun categories(): List<CategoryDto>

    @GET("pos/lookup")
    suspend fun lookup(@Query("sku") sku: String): List<ProductDto>
}