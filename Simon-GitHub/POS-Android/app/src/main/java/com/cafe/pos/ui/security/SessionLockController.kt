package com.cafe.pos.ui.security

import com.cafe.pos.data.auth.TokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Process-wide controller for the session lock.
 *
 *  - [isLocked] is `true` after [IDLE_TIMEOUT_MS] of no
 *    [onUserInteraction] events, on every fresh launch, and after an
 *    explicit [lockNow] (e.g. from the top app bar).
 *  - The biometric / password prompt itself is owned by
 *    [SessionLockOverlay] (it needs the Activity). This controller only
 *    tracks the timer and exposes the locked flag.
 *
 *  - The locked state is published as a [StateFlow] so any Composable
 *    can react.
 */
@Singleton
class SessionLockController @Inject constructor(
    @Suppress("unused") private val tokenStore: TokenStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _isLocked = MutableStateFlow(true)
    val isLocked: StateFlow<Boolean> = _isLocked.asStateFlow()

    private val _lastInteractionMs = MutableStateFlow(System.currentTimeMillis())
    val lastInteractionMs: StateFlow<Long> = _lastInteractionMs.asStateFlow()

    private var watchdogJob: Job? = null

    init {
        startWatchdog()
    }

    /** Called by [com.cafe.pos.MainActivity.onUserInteraction] on every touch/key. */
    fun onUserInteraction() {
        _lastInteractionMs.value = System.currentTimeMillis()
    }

    /** Called by the lock screen after a successful biometric or password re-auth. */
    fun unlock() {
        _lastInteractionMs.value = System.currentTimeMillis()
        _isLocked.value = false
    }

    /** User-initiated lock (e.g., top-app-bar action). */
    fun lockNow() {
        _isLocked.value = true
    }

    fun idleMs(): Long = System.currentTimeMillis() - _lastInteractionMs.value

    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            while (true) {
                delay(WATCHDOG_INTERVAL_MS)
                if (!_isLocked.value && idleMs() >= IDLE_TIMEOUT_MS) {
                    _isLocked.value = true
                }
            }
        }
    }

    companion object {
        /** 5 minutes. Future versions can read this from a setting. */
        const val IDLE_TIMEOUT_MS: Long = 5L * 60L * 1000L

        /** Watchdog poll interval. Polling (not a single delayed job) means
         *  an interaction instantly extends the lock window. */
        const val WATCHDOG_INTERVAL_MS: Long = 15_000L
    }
}

/** Static bridge for [com.cafe.pos.MainActivity.onUserInteraction]. */
object SessionLockStatic {
    @Volatile private var ref: SessionLockController? = null
    fun bind(c: SessionLockController) { ref = c }
    fun onUserInteraction() { ref?.onUserInteraction() }
}