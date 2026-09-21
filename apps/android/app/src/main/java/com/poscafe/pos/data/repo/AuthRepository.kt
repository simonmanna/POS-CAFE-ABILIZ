package com.poscafe.pos.data.repo

import at.favre.lib.crypto.bcrypt.BCrypt
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.StaffDao
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.data.local.entity.StaffEntity
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
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
    private val opQueue: OpQueueDao,
    private val config: DeviceConfig,
) {
    data class LoggedIn(val userId: String, val displayName: String, val permissions: Set<String>)

    private val failedAttempts = mutableMapOf<String, Int>()

    @Volatile
    var current: LoggedIn? = null
        private set

    suspend fun staffList(): List<StaffEntity> = staffDao.all().filter { it.isActive && it.pinHash != null }

    suspend fun loginWithPin(userId: String, pin: String): Result<LoggedIn> = runCatching {
        val user = staffDao.byId(userId)
            ?: return@runCatching Result.failure(IllegalArgumentException("Unknown user"))
        // Revocation, checked explicitly rather than relying on the server
        // having nulled the hash. A suspended or terminated employee must not
        // be able to open a shift on a terminal that is still offline.
        if (!user.isActive) {
            return@runCatching Result.failure(IllegalStateException("This account has been deactivated"))
        }
        val hash = user.pinHash
            ?: return@runCatching Result.failure(IllegalStateException("No PIN set for this user"))

        val attempts = failedAttempts.getOrDefault(userId, 0)
        if (attempts >= MAX_FAILED_ATTEMPTS) {
            return@runCatching Result.failure(IllegalStateException("Account locked after $MAX_FAILED_ATTEMPTS failed attempts — sync online to unlock"))
        }

        val ok = try {
            BCrypt.verifyer().verify(pin.toCharArray(), hash.toCharArray()).verified
        } catch (t: Throwable) {
            return@runCatching Result.failure(IllegalStateException("PIN verification error: ${t.message ?: t.javaClass.simpleName}"))
        }
        if (ok) {
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
    }.fold({ it }, { failure -> Result.failure(failure) })

    fun logout() {
        current = null
    }

    /**
     * Self-service PIN change. Verifies the current PIN against the synced
     * bcrypt hash, hashes the new PIN locally, updates the local row so the
     * cashier can log in again immediately, and (on enrolled devices) queues a
     * `staff.pinChange` op so the new hash reaches the server — the next pull
     * then fans it out to every device. The server never sees the plaintext.
     */
    suspend fun changePin(userId: String, currentPin: String, newPin: String): Result<Unit> = runCatching {
        val user = staffDao.byId(userId)
            ?: return@runCatching Result.failure(IllegalArgumentException("Unknown user"))
        val hash = user.pinHash
            ?: return@runCatching Result.failure(IllegalStateException("No PIN set for this user"))
        val ok = try {
            BCrypt.verifyer().verify(currentPin.toCharArray(), hash.toCharArray()).verified
        } catch (t: Throwable) {
            return@runCatching Result.failure(IllegalStateException("PIN verification error: ${t.message ?: t.javaClass.simpleName}"))
        }
        if (!ok) return@runCatching Result.failure(IllegalArgumentException("Current PIN is incorrect"))
        if (currentPin == newPin) return@runCatching Result.failure(IllegalArgumentException("New PIN must be different"))

        val newHash = BCrypt.withDefaults().hashToString(10, newPin.toCharArray())
        staffDao.upsertAll(listOf(user.copy(pinHash = newHash)))

        if (!config.standalone) {
            val payload = buildJsonObject {
                put("userId", userId)
                put("newPinHash", newHash)
            }
            opQueue.enqueueNext { seq ->
                OpQueueEntity(
                    opId = UUID.randomUUID().toString(),
                    deviceSeq = seq,
                    type = "staff.pinChange",
                    actorUserId = userId,
                    occurredAt = System.currentTimeMillis(),
                    payloadJson = payload.toString(),
                    status = "queued",
                    attempts = 0,
                    lastError = null,
                )
            }
        }
        Result.success(Unit)
    }.fold({ it }, { failure -> Result.failure(failure) })

    data class Override(val userId: String, val displayName: String)

    /**
     * Verify a manager override PIN for a refund/void WITHOUT touching the
     * logged-in cashier. Returns the manager when the PIN matches an active
     * staff member holding `pos:override` — the same permission the server's
     * assertCanOverride requires. Runs on-device against the synced bcrypt
     * hashes; the server re-validates on replay (its authority is final).
     */
    suspend fun verifyOverridePin(pin: String): Result<Override> = verifyPinFor(pin, "pos:override")

    /** Does the signed-in cashier hold [permission] (as last synced)? */
    fun currentHas(permission: String): Boolean = current?.permissions?.contains(permission) == true

    /**
     * Verify an approver's PIN for an action gated by [permission] — shift-close
     * variances (`cash_session:approve_variance`), stock movements
     * (`inventory_doc:approve`). Excludes the signed-in cashier when
     * [excludeCurrent]: the server forbids approving your own work.
     */
    suspend fun verifyPinFor(pin: String, permission: String, excludeCurrent: Boolean = false): Result<Override> = runCatching {
        val managers = staffDao.all().filter { staff ->
            staff.isActive && staff.pinHash != null &&
                !(excludeCurrent && staff.id == current?.userId) &&
                permission in staff.permissions.split(',').map { it.trim() }
        }
        for (m in managers) {
            val ok = try {
                BCrypt.verifyer().verify(pin.toCharArray(), m.pinHash!!.toCharArray()).verified
            } catch (t: Throwable) {
                continue
            }
            if (ok) return@runCatching Result.success(Override(m.id, listOfNotNull(m.firstName, m.lastName).joinToString(" ")))
        }
        Result.failure(IllegalArgumentException("PIN not recognised for a manager holding $permission"))
    }.fold({ it }, { failure -> Result.failure(failure) })

    companion object {
        const val MAX_FAILED_ATTEMPTS = 10
    }
}
