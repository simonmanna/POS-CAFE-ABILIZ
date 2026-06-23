package com.cafe.pos.data.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Triggers [SyncWorker] on the right schedule.
 *
 *  - [kickNow] — fire-and-forget one-shot run; used by the manual
 *    "Sync now" button in the UI and by the connectivity-restored
 *    callback in [com.cafe.pos.data.connectivity.NetworkConnectivityMonitor].
 *  - [schedulePeriodic] — registers the every-15-minutes background sweep
 *    (KEEP policy so a second call doesn't reset the existing schedule).
 *  - [cancel] — for tests and the "sign out" flow.
 *
 * The constraint `CONNECTED` ensures WorkManager only runs us when
 * there's a real network — the worker itself also re-checks via
 * [com.cafe.pos.data.connectivity.NetworkConnectivityMonitor].
 */
@Singleton
class SyncScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    fun kickNow() {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniqueWork(
            SyncWorker.UNIQUE_NAME + "_now",
            ExistingWorkPolicy.REPLACE,
            req,
        )
    }

    fun schedulePeriodic() {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniquePeriodicWork(
            SyncWorker.UNIQUE_NAME + "_periodic",
            ExistingPeriodicWorkPolicy.KEEP,
            req,
        )
    }

    fun cancelAll() {
        workManager.cancelUniqueWork(SyncWorker.UNIQUE_NAME + "_now")
        workManager.cancelUniqueWork(SyncWorker.UNIQUE_NAME + "_periodic")
    }
}