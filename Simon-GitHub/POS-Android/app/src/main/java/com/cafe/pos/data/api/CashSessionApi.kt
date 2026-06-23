package com.cafe.pos.data.api

import com.cafe.pos.data.model.CashSessionDto
import com.cafe.pos.data.model.CloseSessionRequest
import com.cafe.pos.data.model.ExpectedCashDto
import com.cafe.pos.data.model.OpenSessionRequest
import com.cafe.pos.data.model.PaginatedCashRegisters
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Cash session / shift endpoints (modules/accounting/treasury).
 *
 *  - GET  /cash-registers?isActive=true   — list active registers
 *  - GET  /cash-sessions/open             — get the cashier's currently-open session (any register)
 *  - POST /cash-sessions/open             — open a session {cashRegisterId, openingFloat, notes}
 *  - POST /cash-sessions/close            — close {closingCounted, notes}
 *  - GET  /cash-sessions/{id}/expected    — expected cash for variance calc
 */
interface CashSessionApi {

    @GET("cash-registers")
    suspend fun registers(
        @Query("isActive") isActive: Boolean? = true,
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 50,
    ): PaginatedCashRegisters

    @GET("cash-sessions/open")
    suspend fun openSession(): CashSessionDto?

    @POST("cash-sessions/open")
    suspend fun openSession(@Body body: OpenSessionRequest): CashSessionDto

    @POST("cash-sessions/close")
    suspend fun closeSession(@Body body: CloseSessionRequest): CashSessionDto

    @GET("cash-sessions/{id}/expected")
    suspend fun expectedCash(@Path("id") sessionId: String): ExpectedCashDto
}