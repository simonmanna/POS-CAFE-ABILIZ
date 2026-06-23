package com.cafe.pos.data.auth

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

private val Context.tokenDataStore by preferencesDataStore(name = "auth_tokens")

/**
 * Persists access + refresh tokens across launches in DataStore.
 *
 * Tokens never leave the app sandbox. The OkHttp interceptor reads the access token
 * synchronously per request via [currentAccessToken] (volatile cache populated by
 * a background collector on construction).
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val accessKey = stringPreferencesKey("access_token")
    private val refreshKey = stringPreferencesKey("refresh_token")
    private val userIdKey = stringPreferencesKey("user_id")
    private val userEmailKey = stringPreferencesKey("user_email")
    private val userNameKey = stringPreferencesKey("user_name")
    private val orgCodeKey = stringPreferencesKey("org_code")

    val accessTokenFlow: Flow<String?> = context.tokenDataStore.data.map { it[accessKey] }
    val refreshTokenFlow: Flow<String?> = context.tokenDataStore.data.map { it[refreshKey] }
    val userEmailFlow: Flow<String?> = context.tokenDataStore.data.map { it[userEmailKey] }
    val userNameFlow: Flow<String?> = context.tokenDataStore.data.map { it[userNameKey] }
    val orgCodeFlow: Flow<String?> = context.tokenDataStore.data.map { it[orgCodeKey] }

    @Volatile private var cachedAccess: String? = null
    @Volatile private var cachedRefresh: String? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        scope.launch {
            context.tokenDataStore.data.onEach { prefs ->
                cachedAccess = prefs[accessKey]
                cachedRefresh = prefs[refreshKey]
            }.collect { /* no-op terminal */ }
        }
    }

    fun currentAccessToken(): String? = cachedAccess
    fun currentRefreshToken(): String? = cachedRefresh

    suspend fun saveTokens(access: String?, refresh: String?) {
        context.tokenDataStore.edit { prefs ->
            if (access != null) prefs[accessKey] = access else prefs.remove(accessKey)
            if (refresh != null) prefs[refreshKey] = refresh else prefs.remove(refreshKey)
        }
        cachedAccess = access
        cachedRefresh = refresh
    }

    suspend fun saveUser(id: String?, email: String?, name: String?, orgCode: String?) {
        context.tokenDataStore.edit { prefs ->
            if (id != null) prefs[userIdKey] = id else prefs.remove(userIdKey)
            if (email != null) prefs[userEmailKey] = email else prefs.remove(userEmailKey)
            if (name != null) prefs[userNameKey] = name else prefs.remove(userNameKey)
            if (orgCode != null) prefs[orgCodeKey] = orgCode else prefs.remove(orgCodeKey)
        }
    }

    suspend fun clear() {
        context.tokenDataStore.edit { it.clear() }
        cachedAccess = null
        cachedRefresh = null
    }
}