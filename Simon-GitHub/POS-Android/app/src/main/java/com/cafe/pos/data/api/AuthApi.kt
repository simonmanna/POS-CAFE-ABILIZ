package com.cafe.pos.data.api

import com.cafe.pos.data.model.LoginRequest
import com.cafe.pos.data.model.LoginResponse
import com.cafe.pos.data.model.MfaLoginRequest
import com.cafe.pos.data.model.RefreshRequest
import com.cafe.pos.data.model.AuthUser
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

/**
 * Auth endpoints (kernel/auth). Matches `/auth/{path}` on the NestJS server.
 */
interface AuthApi {

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("auth/mfa-login")
    suspend fun mfaLogin(@Body body: MfaLoginRequest): LoginResponse

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): LoginResponse

    @GET("auth/me")
    suspend fun me(@Header("Authorization") bearer: String): AuthUser
}