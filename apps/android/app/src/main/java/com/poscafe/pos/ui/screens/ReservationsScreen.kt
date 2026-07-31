package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.TableDao
import com.poscafe.pos.data.local.entity.PosTableEntity
import com.poscafe.pos.data.local.entity.ReservationEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.ReservationRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

@HiltViewModel
class ReservationsViewModel @Inject constructor(
    private val reservations: ReservationRepository,
    tableDao: TableDao,
    private val auth: AuthRepository,
) : ViewModel() {
    val list: StateFlow<List<ReservationEntity>> =
        reservations.active().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val tables: StateFlow<List<PosTableEntity>> =
        tableDao.tables().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var error by mutableStateOf<String?>(null); private set

    fun create(
        tableId: String,
        customerName: String,
        phone: String?,
        partySize: Int,
        startAt: Long,
        endAt: Long,
        notes: String?,
        onDone: () -> Unit,
    ) {
        val user = auth.current ?: return
        viewModelScope.launch {
            error = null
            runCatching {
                reservations.create(user.userId, tableId, customerName, phone, partySize, startAt, endAt, notes)
            }.onSuccess { onDone() }.onFailure { error = it.message }
        }
    }

    fun seat(id: String) = act { u -> reservations.seat(u, id) }
    fun cancel(id: String) = act { u -> reservations.cancel(u, id) }
    fun noShow(id: String) = act { u -> reservations.noShow(u, id) }

    private inline fun act(crossinline block: suspend (String) -> Unit) {
        val user = auth.current ?: return
        viewModelScope.launch { runCatching { block(user.userId) }.onFailure { error = it.message } }
    }
}

@Composable
fun ReservationsDialog(onDismiss: () -> Unit, vm: ReservationsViewModel = hiltViewModel()) {
    val list by vm.list.collectAsStateWithLifecycle()
    val tables by vm.tables.collectAsStateWithLifecycle()
    var creating by remember { mutableStateOf(false) }
    val timeFmt = remember { DateTimeFormatter.ofPattern("EEE HH:mm").withZone(ZoneId.systemDefault()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Reservations", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (creating) {
                    ReservationForm(
                        tables = tables,
                        error = vm.error,
                        onCancel = { creating = false },
                        onCreate = { tableId, name, phone, party, startAt, endAt, notes ->
                            vm.create(tableId, name, phone, party, startAt, endAt, notes) { creating = false }
                        },
                    )
                } else {
                    if (list.isEmpty()) {
                        Text(
                            "No upcoming reservations.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    list.forEach { r ->
                        val tableNo = tables.find { it.id == r.tableId }?.number ?: "?"
                        ReservationRow(r, tableNo, timeFmt, onSeat = { vm.seat(r.id) }, onCancel = { vm.cancel(r.id) }, onNoShow = { vm.noShow(r.id) })
                    }
                }
            }
        },
        confirmButton = {
            if (!creating) {
                Button(onClick = { creating = true }, shape = MaterialTheme.shapes.medium) { Text("New booking") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun ReservationRow(
    r: ReservationEntity,
    tableNumber: String,
    timeFmt: DateTimeFormatter,
    onSeat: () -> Unit,
    onCancel: () -> Unit,
    onNoShow: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${r.customerName} · T$tableNumber", style = MaterialTheme.typography.titleSmall)
                Text(timeFmt.format(java.time.Instant.ofEpochMilli(r.startAt)), style = MaterialTheme.typography.bodyMedium)
            }
            Text(
                "Party of ${r.partySize}${r.phone?.let { " · $it" } ?: ""} · ${r.status}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (r.status == "pending") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onSeat, shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)) { Text("Seat") }
                    OutlinedButton(onClick = onNoShow, shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)) { Text("No-show") }
                    OutlinedButton(
                        onClick = onCancel,
                        shape = MaterialTheme.shapes.small,
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) { Text("Cancel") }
                }
            }
        }
    }
}

@Composable
private fun ReservationForm(
    tables: List<PosTableEntity>,
    error: String?,
    onCancel: () -> Unit,
    onCreate: (tableId: String, name: String, phone: String?, party: Int, startAt: Long, endAt: Long, notes: String?) -> Unit,
) {
    var tableId by remember { mutableStateOf(tables.firstOrNull()?.id) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var party by remember { mutableStateOf("2") }
    var tomorrow by remember { mutableStateOf(false) }
    var hour by remember { mutableStateOf("19") }
    var minute by remember { mutableStateOf("00") }
    var durationMin by remember { mutableStateOf("90") }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Table", style = MaterialTheme.typography.labelLarge)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tables.forEach { t ->
                val sel = t.id == tableId
                Surface(
                    onClick = { tableId = t.id },
                    shape = MaterialTheme.shapes.small,
                    color = if (sel) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                ) { Text("T${t.number}", modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) }
            }
        }
        OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Customer name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = phone, onValueChange = { phone = it }, label = { Text("Phone (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = party, onValueChange = { party = it.filter { c -> c.isDigit() }.take(2) }, label = { Text("Party") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
            OutlinedTextField(value = durationMin, onValueChange = { durationMin = it.filter { c -> c.isDigit() }.take(3) }, label = { Text("Mins") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !tomorrow, onClick = { tomorrow = false }, label = { Text("Today") })
            FilterChip(selected = tomorrow, onClick = { tomorrow = true }, label = { Text("Tomorrow") })
            OutlinedTextField(value = hour, onValueChange = { hour = it.filter { c -> c.isDigit() }.take(2) }, label = { Text("HH") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(72.dp))
            OutlinedTextField(value = minute, onValueChange = { minute = it.filter { c -> c.isDigit() }.take(2) }, label = { Text("MM") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(72.dp))
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("Back") }
            Button(
                onClick = {
                    val tId = tableId ?: return@Button
                    val h = hour.toIntOrNull()?.coerceIn(0, 23) ?: return@Button
                    val m = minute.toIntOrNull()?.coerceIn(0, 59) ?: 0
                    val day = if (tomorrow) LocalDate.now().plusDays(1) else LocalDate.now()
                    val zone = ZoneId.systemDefault()
                    val startAt = day.atTime(h, m).atZone(zone).toInstant().toEpochMilli()
                    val dur = durationMin.toLongOrNull()?.coerceAtLeast(15) ?: 90
                    val endAt = startAt + dur * 60_000L
                    onCreate(tId, name.trim(), phone.trim().ifBlank { null }, party.toIntOrNull() ?: 2, startAt, endAt, null)
                },
                enabled = name.isNotBlank() && tableId != null,
                modifier = Modifier.weight(1f),
            ) { Text("Book") }
        }
    }
}
