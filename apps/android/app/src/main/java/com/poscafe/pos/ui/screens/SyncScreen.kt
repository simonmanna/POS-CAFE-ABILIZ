package com.poscafe.pos.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudDone
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.sync.SyncWorker
import com.poscafe.pos.ui.components.PosCard
import com.poscafe.pos.ui.components.PrimaryButton
import com.poscafe.pos.ui.components.StatCard
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Sync status + failed-op review. Mirrors the web's failed-sales dialog and
 * the server's dead-letter philosophy: a rejected money op stays visible
 * until a human retries or discards it.
 */
@HiltViewModel
class SyncViewModel @Inject constructor(private val opQueue: OpQueueDao) : ViewModel() {
    val queued = opQueue.queuedCount().stateIn(viewModelScope, SharingStarted.Eagerly, 0)
    val failedCount = opQueue.failedCount().stateIn(viewModelScope, SharingStarted.Eagerly, 0)
    val failed = opQueue.failed().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList<OpQueueEntity>())

    fun retry(opId: String) = viewModelScope.launch { opQueue.retry(opId) }
}

@Composable
fun SyncScreen(onBack: () -> Unit, vm: SyncViewModel = hiltViewModel()) {
    val context = LocalContext.current
    val queued by vm.queued.collectAsStateWithLifecycle()
    val failedCount by vm.failedCount.collectAsStateWithLifecycle()
    val failed by vm.failed.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
            }
            Text("Sync", style = MaterialTheme.typography.headlineSmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCard("$queued", "Waiting to push", Modifier.weight(1f))
            StatCard(
                "$failedCount", "Rejected",
                Modifier.weight(1f),
                accent = if (failedCount > 0) MaterialTheme.colorScheme.error else null,
            )
        }
        Spacer(Modifier.height(12.dp))
        PrimaryButton(
            text = "Sync now",
            onClick = { SyncWorker.syncNow(context) },
            modifier = Modifier.fillMaxWidth(),
            height = 48.dp,
        )
        Spacer(Modifier.height(16.dp))
        if (failed.isEmpty()) {
            Column(
                Modifier.fillMaxWidth().padding(top = 48.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Outlined.CloudDone, null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(40.dp),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Nothing needs attention",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Text(
                "Rejected by server — review each one",
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(10.dp))
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 16.dp),
            ) {
                items(failed, key = { it.opId }) { op ->
                    PosCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(op.type, style = MaterialTheme.typography.titleSmall)
                                StatusPill(
                                    "seq ${op.deviceSeq}",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    container = MaterialTheme.colorScheme.surfaceContainerHigh,
                                )
                            }
                            Text(
                                op.lastError ?: "Rejected",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            TextButton(onClick = { vm.retry(op.opId) }) { Text("Retry") }
                        }
                    }
                }
            }
        }
    }
}
