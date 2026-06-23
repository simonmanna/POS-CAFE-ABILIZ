package com.cafe.pos.data.session

import com.cafe.pos.data.repository.CashSessionRepository
import com.cafe.pos.domain.session.ShiftSessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * App-level bootstrap for the cash session.
 *
 * On startup we ask the server "is there already an open session for this
 * cashier?" and seed the [ShiftSessionStore]. If the cashier wasn't logged
 * in yet, we do this after they hit the terminal — the [com.cafe.pos.ui.navigation.CafePosNavHost]
 * triggers it via [refresh].
 *
 * Also called when the user comes back from a successful login.
 */
@Singleton
class ShiftSessionBootstrap @Inject constructor(
    private val repository: CashSessionRepository,
    private val store: ShiftSessionStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun refresh() {
        scope.launch {
            try {
                val active = repository.activeSession()
                store.set(active)
            } catch (_: Throwable) {
                // Network blip / unauthorized — leave the store as-is. The terminal
                // will re-prompt for an open shift on its first render.
            }
        }
    }
}