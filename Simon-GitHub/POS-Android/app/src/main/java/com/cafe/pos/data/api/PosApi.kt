package com.cafe.pos.data.api

import com.cafe.pos.data.model.CheckoutLineDto
import com.cafe.pos.data.model.CheckoutRequest
import com.cafe.pos.data.model.CheckoutResult
import com.cafe.pos.data.model.PosHoldDto
import com.cafe.pos.data.model.CreateHoldRequest
import com.cafe.pos.data.model.UpdateHoldNotesRequest
import com.cafe.pos.data.model.OverrideVerifyRequest
import com.cafe.pos.data.model.OverrideVerifyResult
import com.cafe.pos.data.model.RefundRequest
import com.cafe.pos.data.model.ProductDto
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * POS endpoints (modules/pos/{path}). Mirrors the web client's API hooks.
 *
 * The [Header] Idempotency-Key is generated client-side per write — the server
 * uses it to deduplicate retries (network blip, accidental double-tap).
 */
interface PosApi {

    /* ---- core checkout / refund / void ---- */

    @POST("pos/checkout")
    suspend fun checkout(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body body: CheckoutRequest,
    ): CheckoutResult

    @POST("pos/refund")
    suspend fun refund(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body body: RefundRequest,
    ): CheckoutResult

    @POST("pos/sales/{id}/void")
    suspend fun voidSale(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Path("id") invoiceId: String,
        @Body body: Map<String, String>,
    ): CheckoutResult

    @GET("pos/lookup")
    suspend fun lookup(@Query("sku") sku: String): List<ProductDto>

    /* ---- holds ---- */

    @POST("pos/holds")
    suspend fun createHold(@Body body: CreateHoldRequest): PosHoldDto

    @GET("pos/holds")
    suspend fun holds(@Query("status") status: String = "open"): List<PosHoldDto>

    @GET("pos/holds/{id}")
    suspend fun hold(@Path("id") id: String): PosHoldDto

    @POST("pos/holds/{id}/recall")
    suspend fun recallHold(@Path("id") id: String): PosHoldDto

    @DELETE("pos/holds/{id}")
    suspend fun cancelHold(@Path("id") id: String): Map<String, Any>

    @PATCH("pos/holds/{id}/notes")
    suspend fun updateHoldNotes(
        @Path("id") id: String,
        @Body body: UpdateHoldNotesRequest,
    ): PosHoldDto

    /* ---- manager override ---- */

    @POST("pos/override/pin")
    suspend fun setOverridePin(@Body body: Map<String, String>): Map<String, Any>

    @POST("pos/override/verify")
    suspend fun verifyOverride(@Body body: OverrideVerifyRequest): OverrideVerifyResult

    /* ---- reports ---- */

    @GET("pos/reports/x-report")
    suspend fun xReport(@Query("cashSessionId") cashSessionId: String? = null): com.cafe.pos.data.model.XReport

    @GET("pos/reports/z-report")
    suspend fun zReport(@Query("cashSessionId") cashSessionId: String? = null): com.cafe.pos.data.model.XReport

    @GET("pos/reports/sales-by-hour")
    suspend fun salesByHour(@Query("date") date: String): com.cafe.pos.data.model.HourlyReport

    @GET("pos/reports/top-items")
    suspend fun topItems(
        @Query("fromDate") fromDate: String,
        @Query("toDate") toDate: String,
        @Query("limit") limit: Int = 20,
    ): List<com.cafe.pos.data.model.TopItemRow>

    /* ---- modifiers / combos ---- */

    @GET("pos/modifiers/groups")
    suspend fun modifierGroups(): List<com.cafe.pos.data.model.ModifierGroupDto>

    @GET("pos/modifiers/combos")
    suspend fun combos(): List<com.cafe.pos.data.model.ComboDto>

    /* ---- KDS ---- */

    @GET("pos/kds/tickets")
    suspend fun kdsTickets(@Query("status") status: String? = null): List<com.cafe.pos.data.model.KdsTicketDto>

    @POST("pos/kds/tickets/{id}/transition")
    suspend fun kdsTransition(
        @Path("id") ticketId: String,
        @Body body: com.cafe.pos.data.model.KdsTransitionRequest,
    ): com.cafe.pos.data.model.KdsTicketDto

    /* ---- loyalty ---- */

    @GET("pos/loyalty/program")
    suspend fun loyaltyProgram(): com.cafe.pos.data.model.LoyaltyProgramDto

    @GET("pos/loyalty/balance/{partnerId}")
    suspend fun loyaltyBalance(@Path("partnerId") partnerId: String): com.cafe.pos.data.model.LoyaltyBalanceDto

    @POST("pos/loyalty/earn")
    suspend fun loyaltyEarn(@Body body: com.cafe.pos.data.model.LoyaltyEarnRequest): com.cafe.pos.data.model.LoyaltyBalanceDto

    @POST("pos/loyalty/redeem")
    suspend fun loyaltyRedeem(@Body body: com.cafe.pos.data.model.LoyaltyRedeemRequest): com.cafe.pos.data.model.LoyaltyBalanceDto
}