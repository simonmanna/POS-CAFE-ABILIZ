package com.cafe.pos.data.sync

/**
 * Exponential-backoff policy for failed sync attempts.
 *
 * Schedule: 1s, 5s, 30s, 2min, 10min, 30min, 1h, 1h, 1h (capped).
 * After 8 attempts the row is considered "dead" and the SyncWorker surfaces
 * a "manual recovery needed" message in the UI rather than retrying.
 */
object SyncBackoff {

    const val MAX_ATTEMPTS = 8

    /** Delay until the next attempt, in milliseconds.
     *  1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s — caps out at 128s (2min).
     *  Past attempt 8 the row is dead and the worker stops retrying,
     *  so we don't need to define anything beyond that. */
    fun delayMs(attempts: Int): Long {
        val safe = attempts.coerceIn(0, MAX_ATTEMPTS - 1)
        return 1_000L * (1L shl safe)
    }

    fun nextAttemptAt(attempts: Int, now: Long = System.currentTimeMillis()): Long =
        now + delayMs(attempts)

    fun isDead(attempts: Int): Boolean = attempts >= MAX_ATTEMPTS
}