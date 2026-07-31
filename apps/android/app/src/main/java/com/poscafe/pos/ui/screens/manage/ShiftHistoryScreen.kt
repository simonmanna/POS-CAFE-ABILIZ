package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.entity.LocalCashSessionEntity
import com.poscafe.pos.data.repo.CashSessionRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.StatusPill
import com.poscafe.pos.ui.theme.LocalPosAccents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

@HiltViewModel
class ShiftHistoryViewModel @Inject constructor(
    private val sessions: CashSessionRepository,
) : ViewModel() {
    val list: StateFlow<List<LocalCashSessionEntity>> =
        sessions.recentSessions().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var report by mutableStateOf<CashSessionRepository.LocalZReport?>(null); private set

    fun openReport(id: String) {
        viewModelScope.launch { report = sessions.zReport(id) }
    }

    fun clearReport() { report = null }
}

@Composable
fun ShiftHistoryScreen(onBack: () -> Unit, vm: ShiftHistoryViewModel = hiltViewModel()) {
    val list by vm.list.collectAsStateWithLifecycle()
    val timeFmt = remember { DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.systemDefault()) }

    ManageScaffold(title = "Shift history (Z-reports)", onBack = onBack) { _ ->
        if (list.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.ReceiptLong,
                title = "No shifts yet",
                subtitle = "Open and close a cash session to see Z-reports here.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 4.dp),
            ) {
                items(list, key = { it.id }) { s ->
                    val accents = LocalPosAccents.current
                    Surface(
                        onClick = { vm.openReport(s.id) },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(timeFmt.format(Instant.ofEpochMilli(s.openedAt)), style = MaterialTheme.typography.titleSmall)
                                Text(
                                    s.closedAt?.let { "Closed ${timeFmt.format(Instant.ofEpochMilli(it))}" } ?: "Opening float ${Money.bare(s.openingFloat)}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (s.status == "open") {
                                StatusPill("Open", accents.success, accents.successContainer)
                            } else {
                                StatusPill("Closed", MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.surfaceContainerHigh)
                            }
                        }
                    }
                }
            }
        }
    }

    vm.report?.let { z ->
        ZReportDialog(z, onDismiss = { vm.clearReport() })
    }
}

@Composable
private fun ZReportDialog(z: CashSessionRepository.LocalZReport, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Z-report", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KVRow("Sales", "${z.salesCount}")
                KVRow("Takings", Money.format(z.salesTotal))
                if (z.refunds > 0) KVRow("Refunds", "-${Money.format(z.refunds)}", valueColor = MaterialTheme.colorScheme.error)
                KVRow("Opening float", Money.format(z.session.openingFloat))
                if (z.payIn > 0) KVRow("Cash in", Money.format(z.payIn))
                if (z.payOut > 0) KVRow("Cash out", "-${Money.format(z.payOut)}")
                KVRow("Expected cash", Money.format(z.expectedCash), emphasize = true, valueColor = MaterialTheme.colorScheme.primary)
                z.counted?.let { KVRow("Counted", Money.format(it)) }
                z.variance?.let {
                    KVRow(
                        "Variance", Money.format(it),
                        emphasize = true,
                        valueColor = if (it == 0.0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    )
                }
                z.session.varianceReason?.let { Text("Reason: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        },
        confirmButton = { Button(shape = MaterialTheme.shapes.medium, onClick = onDismiss) { Text("Close") } },
    )
}
