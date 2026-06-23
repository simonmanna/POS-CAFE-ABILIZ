package com.cafe.pos.data.repository

import com.cafe.pos.data.api.ApiErrorMapper
import com.cafe.pos.data.api.AuthApi
import com.cafe.pos.data.auth.TokenStore
import com.cafe.pos.data.model.LoginRequest
import com.cafe.pos.data.model.LoginResponse
import com.cafe.pos.data.model.MfaLoginRequest
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Login / logout / token refresh wrapper. Stores credentials in [TokenStore]
 * so the rest of the app can react via [TokenStore.accessTokenFlow].
 */
@Singleton
class AuthRepository @Inject constructor(
    private val api: AuthApi,
    private val tokenStore: TokenStore,
) {

    val accessTokenFlow: Flow<String?> = tokenStore.accessTokenFlow
    val userEmailFlow: Flow<String?> = tokenStore.userEmailFlow
    val userNameFlow: Flow<String?> = tokenStore.userNameFlow

    suspend fun login(orgCode: String, email: String, password: String): LoginResponse {
        return try {
            val res = api.login(LoginRequest(orgCode, email, password))
            handleLoginResult(res)
            res
        } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }

    suspend fun verifyMfa(mfaToken: String, code: String): LoginResponse {
        return try {
            val res = api.mfaLogin(MfaLoginRequest(mfaToken, code))
            handleLoginResult(res)
            res
        } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }

    suspend fun logout() {
        tokenStore.clear()
    }

    private suspend fun handleLoginResult(res: LoginResponse) {
        if (res.accessToken != null) {
            tokenStore.saveTokens(res.accessToken, res.refreshToken)
            res.user?.let {
                tokenStore.saveUser(
                    id = it.id,
                    email = it.email,
                    name = listOfNotNull(it.firstName, it.lastName).joinToString(" ").ifBlank { it.email },
                    orgCode = null,
                )
            }
        }
    }
}