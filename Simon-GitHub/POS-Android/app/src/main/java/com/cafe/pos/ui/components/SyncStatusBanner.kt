package com.cafe.pos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.SyncProblem
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.cafe.pos.data.sync.SyncStatus

/**
 * Sticky banner shown above the terminal when there are pending sales
 * waiting to sync (or sync is in flight). The cashier can tap "Sync now"
 * to fire an immediate drain.
 */
@Composable
fun SyncStatusBanner(
    status: SyncStatus,
    onSyncNow: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (status == SyncStatus.Idle && status.pendingCount == 0) return

    val (bg, fg, icon, text) = when {
        status.isSyncing -> Quad(
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
            null,  // null icon → use spinner
            "Syncing ${status.pendingCount} pending sale(s)…",
        )
        status.hasFailures -> Quad(
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
            Icons.Default.SyncProblem,
            "Sync error: ${status.lastError ?: "unknown"}",
        )
        status.pendingCount > 0 -> Quad(
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
            Icons.Default.CloudOff,
            "${status.pendingCount} sale(s) waiting to sync",
        )
        else -> Quad(
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
            Icons.Default.CloudDone,
            "All sales synced",
        )
    }

    Surface(color = bg, modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = fg)
            } else {
                CircularProgressIndicator(
                    color = fg,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(text, color = fg, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f))
            if (status.pendingCount > 0 && !status.isSyncing) {
                TextButton(
                    onClick = onSyncNow,
                    colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                        contentColor = fg,
                    ),
                ) { Text("Sync now") }
            }
        }
    }
}

private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)