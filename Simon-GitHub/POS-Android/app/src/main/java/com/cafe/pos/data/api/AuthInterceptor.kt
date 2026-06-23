package com.cafe.pos.data.api

import com.cafe.pos.data.auth.TokenStore
import com.cafe.pos.data.model.RefreshRequest
import com.cafe.pos.di.RefreshApi
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.Route
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton

/**
 * Adds the `Authorization: Bearer <access>` header to every outbound request when
 * a token is present. Public endpoints (login, refresh) skip this naturally because
 * no token is cached yet.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val tokenStore: TokenStore,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val token = tokenStore.currentAccessToken()
        val request = if (token != null && original.header("Authorization") == null) {
            original.newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        } else original
        return chain.proceed(request)
    }
}

/**
 * Handles 401 by swapping in a refreshed access token once. If refresh also 401s,
 * the caller sees the original 401 and the UI prompts re-login.
 */
@Singleton
class TokenAuthenticator @Inject constructor(
    private val tokenStore: TokenStore,
    private val refreshApi: Provider<RefreshApi>,
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): okhttp3.Request? {
        if (response.request.url.encodedPath.endsWith("/auth/refresh")) return null
        if (responseCount(response) >= 2) return null

        val refresh = tokenStore.currentRefreshToken() ?: return null
        val newAccess = runBlocking {
            try {
                val response = refreshApi.get().refresh(RefreshRequest(refresh))
                tokenStore.saveTokens(response.accessToken, response.refreshToken ?: refresh)
                response.accessToken
            } catch (t: Throwable) { null }
        } ?: return null

        return response.request.newBuilder()
            .header("Authorization", "Bearer $newAccess")
            .build()
    }

    private fun responseCount(response: Response): Int {
        var r: Response? = response.priorResponse
        var c = 1
        while (r != null) { c++; r = r.priorResponse }
        return c
    }
}