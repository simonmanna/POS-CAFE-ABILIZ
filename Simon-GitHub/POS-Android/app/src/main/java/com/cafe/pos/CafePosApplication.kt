package com.cafe.pos

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.cafe.pos.data.cart.CartPersistence
import com.cafe.pos.data.connectivity.NetworkConnectivityMonitor
import com.cafe.pos.data.sync.SyncScheduler
import com.cafe.pos.data.sync.SyncWorker
import com.cafe.pos.domain.cart.CartStore
import com.cafe.pos.telemetry.CrashReporter
import com.cafe.pos.ui.security.SessionLockController
import com.cafe.pos.ui.security.SessionLockStatic
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Hilt application root. Bootstraps WorkManager (Hilt-aware) and wires the
 * connectivity-restored callback to the sync scheduler.
 *
 * Manual [androidx.work.WorkManager.initialize] is required when using
 * [androidx.hilt.work.HiltWorkerFactory] (the on-demand init path doesn't
 * see the factory). [Configuration.Provider] is implemented below.
 */
@HiltAndroidApp
class CafePosApplication : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var syncScheduler: SyncScheduler
    @Inject lateinit var connectivity: NetworkConnectivityMonitor
    @Inject lateinit var crashReporter: CrashReporter
    @Inject lateinit var sessionLockController: SessionLockController
    @Inject lateinit var cartStore: CartStore
    @Inject lateinit var cartPersistence: CartPersistence

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()

        // Wire the static bridge for MainActivity.onUserInteraction → controller.
        SessionLockStatic.bind(sessionLockController)

        // Restore the last cart so process death doesn't lose the cashier's
        // active sale. DataStore, so no IO on the main thread.
        appScope.launch { cartPersistence.restore(cartStore) }

        // Auto-save the cart to DataStore on every change. `drop(1)` skips
        // the initial value (we just restored it; no need to write back).
        appScope.launch {
            cartStore.state.drop(1).distinctUntilChanged().collect {
                cartPersistence.saveDebounced(cartStore)
            }
        }

        // Install the uncaught-exception handler before anything else can crash.
        // We chain to the default handler so the OS still kills the process;
        // our job is to make sure the crash is recorded before death.
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            crashReporter.report(throwable, mapOf("thread" to thread.name, "fatal" to "true"))
            previous?.uncaughtException(thread, throwable)
        }

        // Periodic 15-min drain. KEEP policy so re-launching doesn't reset.
        syncScheduler.schedulePeriodic()
        // Kick once on startup so any offline-queued sales get a chance
        // to drain as soon as we're alive.
        syncScheduler.kickNow()
        // When connectivity comes back, retry immediately.
        appScope.launch {
            connectivity.isConnected.collect { connected ->
                if (connected) syncScheduler.kickNow()
            }
        }
    }
}