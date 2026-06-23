package com.cafe.pos.data.sync

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.cafe.pos.data.local.CafePosDatabase
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI model for the sync banner.
 *  - [pendingCount] — number of rows in `pending_sales`
 *  - [isSyncing]    — a SyncWorker is currently running
 *  - [hasFailures]  — at least one row is over the dead-letter threshold
 *  - [lastError]    — most recent failure message (for the error UI)
 */
data class SyncStatus(
    val pendingCount: Int = 0,
    val isSyncing: Boolean = false,
    val hasFailures: Boolean = false,
    val lastError: String? = null,
) {
    companion object {
        val Idle = SyncStatus()
    }
}

@HiltViewModel
class SyncStatusViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: CafePosDatabase,
    private val scheduler: SyncScheduler,
) : ViewModel() {

    private val workManager: WorkManager = WorkManager.getInstance(context)

    private val manualSyncing = MutableStateFlow(false)
    val status: StateFlow<SyncStatus> = combine(
        db.pendingSaleDao().observeCount(),
        workManager.getWorkInfosForUniqueWorkFlow(SyncWorker.UNIQUE_NAME + "_now"),
        manualSyncing,
    ) { count, infos, isManual ->
        val running = infos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }
        val hasFailures = count > 0 && isManual
        SyncStatus(
            pendingCount = count,
            isSyncing = running || isManual,
            hasFailures = hasFailures,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncStatus.Idle)

    fun syncNow() {
        manualSyncing.value = true
        scheduler.kickNow()
        // The banner observes WorkManager state directly; reset the local
        // flag after a short delay so the spinner can go away.
        viewModelScope.launch {
            delay(3_000)
            manualSyncing.value = false
        }
    }
}