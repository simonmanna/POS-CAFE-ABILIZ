package com.cafe.pos.data.api

import com.cafe.pos.data.model.ApiError
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import retrofit2.HttpException
import java.io.IOException

/**
 * Maps a thrown exception from the API layer to a [PosApiException] with a
 * human-readable message and the HTTP status code (when applicable).
 */
object ApiErrorMapper {

    private val moshi: Moshi = Moshi.Builder().build()

    fun map(t: Throwable): PosApiException = when (t) {
        is PosApiException -> t
        is HttpException -> {
            val raw = try { t.response()?.errorBody()?.string() } catch (_: Throwable) { null }
            val parsed = raw?.let { parseError(it) }
            PosApiException(
                statusCode = t.code(),
                message = parsed?.message?.toString() ?: t.message().ifBlank { "HTTP ${t.code()}" },
                rawBody = raw,
            )
        }
        is IOException -> PosApiException(
            statusCode = null,
            message = "Network error — check your connection",
        )
        else -> PosApiException(statusCode = null, message = t.message ?: "Unknown error")
    }

    private fun parseError(body: String): ApiError? {
        return try {
            val type = Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)
            val adapter = moshi.adapter<Map<String, Any?>>(type)
            val map = adapter.fromJson(body) ?: return null
            val status = (map["statusCode"] as? Number)?.toInt()
            @Suppress("UNCHECKED_CAST")
            val message = when (val m = map["message"]) {
                is String -> m
                is List<*> -> m.joinToString(", ")
                else -> null
            }
            ApiError(
                statusCode = status,
                message = message ?: map["error"]?.toString(),
                error = map["error"] as? String,
            )
        } catch (_: Throwable) { null }
    }
}

class PosApiException(
    val statusCode: Int?,
    override val message: String,
    val rawBody: String? = null,
) : RuntimeException(message)