package com.cafe.pos.data.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.cafe.pos.data.local.CafePosDatabase
import com.cafe.pos.data.connectivity.NetworkConnectivityMonitor
import com.cafe.pos.data.repository.PosRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Background drain of the [PendingSaleEntity] queue. Triggered by:
 *  1. App start (one-shot, fired from [com.cafe.pos.CafePosApplication.onCreate])
 *  2. Connectivity restored (fired by [com.cafe.pos.data.connectivity.NetworkConnectivityMonitor] via [SyncScheduler])
 *  3. Manual "Sync now" tap in the UI
 *  4. Periodic (every 15 min) — set up by [SyncScheduler.schedulePeriodic]
 *
 * For each due row, calls [PosRepository.flushPendingSales] and records
 * success / failure with exponential backoff. Dead rows (≥ 8 attempts)
 * are left in the queue but skipped; the cashier can re-trigger manually
 * after resolving the underlying issue (server down, schema change, etc.).
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val posRepository: PosRepository,
    private val db: CafePosDatabase,
    private val connectivity: NetworkConnectivityMonitor,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (!connectivity.isConnectedNow()) {
            // Re-queue for the next nudge.
            return Result.retry()
        }

        val dao = db.pendingSaleDao()
        val now = System.currentTimeMillis()
        val due = dao.dueForRetry(now)
        if (due.isEmpty()) {
            // No work — caller treats this as success.
            return Result.success()
        }

        val flushed = posRepository.flushPendingSales()
        if (flushed > 0) {
            // Repository already deletes successful rows. Note the success
            // for each one so the UI can show a "last sync" timestamp.
            dao.snapshot().forEach { row ->
                if (row.id !in due.map { it.id }) {
                    dao.recordSuccess(row.id, System.currentTimeMillis())
                }
            }
        }

        // If anything failed, schedule another retry.
        val stillFailing = dao.snapshot().any { it.attempts > 0 && !SyncBackoff.isDead(it.attempts) }
        return if (stillFailing) Result.retry() else Result.success()
    }

    companion object {
        const val UNIQUE_NAME = "cafe_pos_sync"
    }
}