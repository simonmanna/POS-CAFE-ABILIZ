package com.poscafe.pos.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.repo.SyncRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * Background sync: push the op queue first (money before catalog), then pull
 * incremental catalog changes. Scheduled three ways:
 *   - periodic (15 min, network-required),
 *   - one-shot on connectivity regain / app foreground,
 *   - manual from the sync screen.
 * WorkManager guarantees at most one run at a time via unique work names.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val sync: SyncRepository,
    private val config: DeviceConfig,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!config.isEnrolled) return Result.success()
        return try {
            sync.push()
            sync.pull()
            Result.success()
        } catch (e: Exception) {
            // Connectivity or server trouble — retry with backoff. Failed OPS
            // (server rejections) are already parked locally + dead-lettered
            // server-side; retry only re-attempts queued ones.
            Result.retry()
        }
    }

    companion object {
        private const val PERIODIC = "pos-sync-periodic"
        private const val ONESHOT = "pos-sync-now"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(constraints)
                    .build(),
            )
        }

        fun syncNow(context: Context) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints).build(),
            )
        }
    }
}
