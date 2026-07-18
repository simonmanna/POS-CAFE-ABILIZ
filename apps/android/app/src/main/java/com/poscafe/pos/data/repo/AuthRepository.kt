package com.poscafe.pos.data.repo

import at.favre.lib.crypto.bcrypt.BCrypt
import com.poscafe.pos.data.local.dao.StaffDao
import com.poscafe.pos.data.local.entity.StaffEntity
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Offline PIN login. Verification runs entirely on-device against the synced
 * bcrypt pinHash — no network needed. Lockout mirrors the server's
 * MAX_FAILED_ATTEMPTS=10 so a stolen tablet cannot brute-force PINs through
 * the UI (the DB itself is SQLCipher-encrypted against offline extraction).
 */
@Singleton
class AuthRepository @Inject constructor(
    private val staffDao: StaffDao,
) {
    data class LoggedIn(val userId: String, val displayName: String, val permissions: Set<String>)

    private val failedAttempts = mutableMapOf<String, Int>()

    @Volatile
    var current: LoggedIn? = null
        private set

    suspend fun staffList(): List<StaffEntity> = staffDao.all().filter { it.pinHash != null }

    suspend fun loginWithPin(userId: String, pin: String): Result<LoggedIn> {
        val user = staffDao.byId(userId)
            ?: return Result.failure(IllegalArgumentException("Unknown user"))
        val hash = user.pinHash
            ?: return Result.failure(IllegalStateException("No PIN set for this user"))

        val attempts = failedAttempts.getOrDefault(userId, 0)
        if (attempts >= MAX_FAILED_ATTEMPTS) {
            return Result.failure(IllegalStateException("Account locked after $MAX_FAILED_ATTEMPTS failed attempts — sync online to unlock"))
        }

        val ok = BCrypt.verifyer().verify(pin.toCharArray(), hash.toCharArray()).verified
        return if (ok) {
            failedAttempts.remove(userId)
            val session = LoggedIn(
                userId = user.id,
                displayName = listOfNotNull(user.firstName, user.lastName).joinToString(" "),
                permissions = user.permissions.split(',').filter { it.isNotBlank() }.toSet(),
            )
            current = session
            Result.success(session)
        } else {
            failedAttempts[userId] = attempts + 1
            Result.failure(IllegalArgumentException("Wrong PIN"))
        }
    }

    fun logout() {
        current = null
    }

    companion object {
        const val MAX_FAILED_ATTEMPTS = 10
    }
}
