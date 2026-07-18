package com.poscafe.pos.data.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * The device side of the P1 sync protocol (apps/api/src/modules/sync).
 * Transport auth = X-Device-Token (added by an OkHttp interceptor).
 */
interface SyncApi {

    @GET("sync/pull")
    suspend fun pull(
        @Query("cursor") cursor: String?,
        @Query("scopes") scopes: String? = null,
    ): PullResponse

    @POST("sync/push")
    suspend fun push(
        @Header("Idempotency-Key") batchId: String,
        @Body body: PushRequest,
    ): PushResponse
}

@Serializable
data class PullResponse(
    /** scope name → raw rows; parsed per-scope by SyncRepository. */
    val data: Map<String, List<JsonObject>>,
    val cursor: String,
    val serverTime: String,
)

@Serializable
data class PushOp(
    val opId: String,
    val deviceSeq: Long,
    val type: String,
    val actorUserId: String,
    val occurredAt: String,
    val payload: JsonElement,
)

@Serializable
data class PushRequest(
    val deviceId: String,
    val ops: List<PushOp>,
)

@Serializable
data class PushOpResult(
    val opId: String,
    val status: String, // applied | replayed | failed
    val httpStatus: Int,
    val error: String? = null,
    val mapping: Map<String, String>? = null,
    val finalNumbers: Map<String, String>? = null,
)

@Serializable
data class PushResponse(
    val results: List<PushOpResult>,
    val lastPushSeq: Long,
    val serverTime: String,
)
