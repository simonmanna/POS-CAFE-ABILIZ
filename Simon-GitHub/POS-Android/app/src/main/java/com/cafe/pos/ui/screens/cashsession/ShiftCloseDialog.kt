package com.cafe.pos.ui.screens.cashsession

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PowerOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.CashSessionDto
import com.cafe.pos.data.model.ExpectedCashDto
import com.cafe.pos.data.model.XReport
import com.cafe.pos.data.repository.CashSessionRepository
import com.cafe.pos.data.repository.PosRepository
import com.cafe.pos.domain.session.ShiftSessionStore
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.ZReport
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ShiftCloseUiState(
    val session: CashSessionDto? = null,
    val expected: ExpectedCashDto? = null,
    val counted: String = "",
    val notes: String = "",
    val loading: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val closed: CashSessionDto? = null,
)

@HiltViewModel
class ShiftCloseViewModel @Inject constructor(
    private val repository: CashSessionRepository,
    private val posRepository: PosRepository,
    private val printer: PrinterManager,
    private val store: ShiftSessionStore,
) : ViewModel() {

    private val _state = MutableStateFlow(ShiftCloseUiState())
    val state: StateFlow<ShiftCloseUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        val s = store.current.value
        if (s == null) {
            _state.update { it.copy(error = "No open shift to close") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, session = s, error = null) }
            try {
                val exp = repository.expectedCash(s.id)
                _state.update { it.copy(loading = false, expected = exp) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message ?: "Failed to fetch expected cash") }
            }
        }
    }

    fun setCounted(v: String) = _state.update { it.copy(counted = v.filter { c -> c.isDigit() || c == '.' }) }
    fun setNotes(v: String) = _state.update { it.copy(notes = v) }

    fun close(onDone: (CashSessionDto) -> Unit) {
        val s = _state.value.session ?: return
        val counted = _state.value.counted.toDoubleOrNull()
        if (counted == null || counted < 0) {
            _state.update { it.copy(error = "Counted cash must be a non-negative number") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(submitting = true, error = null) }
            try {
                val closed = repository.closeSession(counted, _state.value.notes.ifBlank { null })
                store.clear()
                _state.update { it.copy(submitting = false, closed = closed) }

                // Fetch the canonical Z-report and push it to the printer.
                // Errors here don't block the close — the cashier can re-print
                // from the X/Z screen.
                tryPrintZReport(s, closed, counted)

                onDone(closed)
            } catch (t: Throwable) {
                _state.update { it.copy(submitting = false, error = t.message ?: "Failed to close shift") }
            }
        }
    }

    private suspend fun tryPrintZReport(
        session: CashSessionDto,
        closed: CashSessionDto,
        counted: Double,
    ) {
        if (!printer.isConnected()) return
        val report: XReport? = try {
            posRepository.zReport(closed.id)
        } catch (_: Throwable) { null } ?: try {
            posRepository.xReport(closed.id)
        } catch (_: Throwable) { null }
        if (report == null) return
        val totals = report.totals
        val z = ZReport(
            storeName = "Cafe POS",
            storeAddress = null,
            invoiceNumber = "Z-${closed.id.takeLast(6).uppercase()}",
            cashier = null,
            openedAt = session.openedAt,
            closedAt = closed.closedAt,
            openingFloat = session.openingFloat.toDoubleOrNull() ?: 0.0,
            salesCount = totals.saleCount,
            salesTotal = totals.salesTotal.toDoubleOrNull() ?: 0.0,
            refundsTotal = totals.refundsTotal.toDoubleOrNull() ?: 0.0,
            netSales = totals.netSales.toDoubleOrNull() ?: 0.0,
            overridesTotal = totals.overridesTotal.toDoubleOrNull() ?: 0.0,
            payInsTotal = totals.payInsTotal.toDoubleOrNull() ?: 0.0,
            payOutsTotal = totals.payOutsTotal.toDoubleOrNull() ?: 0.0,
            expectedCash = totals.expectedCash.toDoubleOrNull() ?: 0.0,
            closingCounted = counted,
            variance = closed.closingDifference?.toDoubleOrNull(),
            byMethod = report.byMethod,
            byCategory = report.byCategory,
            footer = "Z-report — keep for records",
        )
        runCatching { printer.printReceipt(z.toReceiptJob()) }
    }
}

private fun formatMoney(d: Double): String = "%,.0f".format(d)

@Composable
fun ShiftCloseDialog(
    onDismiss: () -> Unit,
    onClosed: (CashSessionDto) -> Unit,
    viewModel: ShiftCloseViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    val session = state.session
    if (session == null) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Close shift") },
            text = { Text(state.error ?: "No open shift.", color = MaterialTheme.colorScheme.error) },
            confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        )
        return
    }

    val expected = state.expected?.expectedCash?.toDoubleOrNull() ?: session.openingFloat.toDoubleOrNull() ?: 0.0
    val countedNum = state.counted.toDoubleOrNull()
    val variance = if (countedNum != null) countedNum - expected else 0.0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.PowerOff, contentDescription = null,
                    tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.padding(4.dp))
                Text("Close shift")
            }
        },
        text = {
            Column {
                Text(
                    "Count the cash in the drawer and enter the total. Variance is recorded in the Z-report.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Surface(
                    tonalElevation = 1.dp,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(modifier = Modifier.fillMaxWidth()) {
                            Text("Opening float", style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f))
                            Text(formatMoney(session.openingFloat.toDoubleOrNull() ?: 0.0),
                                style = MaterialTheme.typography.bodyMedium)
                        }
                        HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp))
                        Row(modifier = Modifier.fillMaxWidth()) {
                            Text("Expected cash", style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f))
                            Text(formatMoney(expected),
                                style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = state.counted,
                    onValueChange = viewModel::setCounted,
                    label = { Text("Counted cash") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (countedNum != null && countedNum >= 0) {
                    Spacer(Modifier.height(8.dp))
                    val (bg, fg, icon, label) = when {
                        variance == 0.0 -> Quad(
                            MaterialTheme.colorScheme.secondaryContainer,
                            MaterialTheme.colorScheme.onSecondaryContainer,
                            Icons.Default.CheckCircle,
                            "Drawer balanced",
                        )
                        variance > 0.0 -> Quad(
                            MaterialTheme.colorScheme.primaryContainer,
                            MaterialTheme.colorScheme.onPrimaryContainer,
                            Icons.Default.Warning,
                            "Cashier is over",
                        )
                        else -> Quad(
                            MaterialTheme.colorScheme.errorContainer,
                            MaterialTheme.colorScheme.onErrorContainer,
                            Icons.Default.Warning,
                            "Cashier is short",
                        )
                    }
                    Surface(color = bg, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
                        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(icon, contentDescription = null, tint = fg)
                            Spacer(Modifier.padding(4.dp))
                            Text("Variance: ${if (variance >= 0) "+" else ""}${formatMoney(variance)}",
                                color = fg, style = MaterialTheme.typography.titleSmall)
                            Spacer(Modifier.padding(4.dp))
                            Text(label, color = fg, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.notes,
                    onValueChange = viewModel::setNotes,
                    label = { Text("Notes (optional)") },
                    placeholder = { Text("e.g. Took 20k for bread run") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                state.error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !state.submitting,
                onClick = { viewModel.close(onClosed) },
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                if (state.submitting) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp).height(16.dp))
                Text(if (state.submitting) "Closing…" else "Close shift & print Z")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)