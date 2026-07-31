package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.PointOfSale
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.entity.CashRegisterEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.CashSessionRepository
import com.poscafe.pos.sync.SyncWorker
import com.poscafe.pos.ui.components.*
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class MoreViewModel @Inject constructor(
    private val sessions: CashSessionRepository,
    private val registerDao: RegisterDao,
    opQueue: OpQueueDao,
    private val auth: AuthRepository,
    val config: DeviceConfig,
) : ViewModel() {
    val session = sessions.openSession().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val queued = opQueue.queuedCount().stateIn(viewModelScope, SharingStarted.Eagerly, 0)
    val failed = opQueue.failedCount().stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    var xReport by mutableStateOf<CashSessionRepository.LocalXReport?>(null); private set
    var registers by mutableStateOf<List<CashRegisterEntity>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set

    val cashier get() = auth.current

    fun refreshXReport() {
        viewModelScope.launch { xReport = sessions.xReport() }
    }

    fun loadRegisters() {
        viewModelScope.launch { registers = registerDao.active() }
    }

    fun openSession(registerId: String, float: Double) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching { sessions.open(user.userId, registerId, float) }
                .onFailure { error = it.message }
                .onSuccess { refreshXReport() }
        }
    }

    fun closeSession(counted: Double, reason: String?) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching { sessions.close(user.userId, counted, reason) }
                .onFailure { error = it.message }
                .onSuccess { xReport = null }
        }
    }

    fun recordMovement(type: String, amount: Double, reason: String?) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching { sessions.recordMovement(user.userId, type, amount, reason) }
                .onFailure { error = it.message }
                .onSuccess { refreshXReport() }
        }
    }

    fun savePrinter(host: String?) {
        config.printerHost = host?.trim()?.takeIf { it.isNotBlank() }
    }
}

@Composable
fun MoreScreen(
    onOpenSync: () -> Unit,
    onLock: () -> Unit,
    onMenu: (() -> Unit)? = null,
    vm: MoreViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val session by vm.session.collectAsStateWithLifecycle()
    val queued by vm.queued.collectAsStateWithLifecycle()
    val failed by vm.failed.collectAsStateWithLifecycle()

    var showOpen by remember { mutableStateOf(false) }
    var showClose by remember { mutableStateOf(false) }
    var showMovement by remember { mutableStateOf<String?>(null) } // "pay_in" | "pay_out"

    LaunchedEffect(session?.id) { vm.refreshXReport() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            onMenu?.let {
                IconButton(onClick = it) { Icon(Icons.Filled.Menu, "Menu") }
            }
            Text("More", style = MaterialTheme.typography.headlineSmall)
        }

        // ---- Cash session ----
        PosCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.PointOfSale, null, tint = MaterialTheme.colorScheme.primary)
                    Text("Cash session", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.weight(1f))
                    val accents = com.poscafe.pos.ui.theme.LocalPosAccents.current
                    if (session != null) {
                        StatusPill("Open", accents.success, accents.successContainer)
                    } else {
                        StatusPill("Closed", MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.surfaceContainerHigh)
                    }
                }
                if (session != null) {
                    vm.xReport?.let { x ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            StatCard("${x.salesCount}", "Sales", Modifier.weight(1f))
                            StatCard(Money.bare(x.salesTotal), "Takings", Modifier.weight(1f))
                            StatCard(Money.bare(x.expectedCash), "Expected cash", Modifier.weight(1f), accent = MaterialTheme.colorScheme.primary)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("Cash in", { showMovement = "pay_in" }, Modifier.weight(1f), height = 48.dp)
                        SecondaryButton("Cash out", { showMovement = "pay_out" }, Modifier.weight(1f), height = 48.dp)
                        PrimaryButton("Close session", { vm.refreshXReport(); showClose = true }, Modifier.weight(1.2f), height = 48.dp)
                    }
                } else {
                    Text(
                        "Open a session to track the drawer for this shift.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    PrimaryButton("Open session", { vm.loadRegisters(); showOpen = true }, Modifier.fillMaxWidth(), height = 48.dp)
                }
                vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }

        // ---- Sync (hidden in standalone — there is nothing to sync to) ----
        if (!vm.config.standalone) PosCard(Modifier.fillMaxWidth(), onClick = onOpenSync) {
            Row(
                Modifier.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Outlined.CloudSync, null, tint = MaterialTheme.colorScheme.primary)
                Column(Modifier.weight(1f)) {
                    Text("Sync", style = MaterialTheme.typography.titleMedium)
                    Text(
                        when {
                            failed > 0 -> "$failed rejected — needs review"
                            queued > 0 -> "$queued waiting to push"
                            else -> "All caught up"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (failed > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { SyncWorker.syncNow(context) }) { Text("Sync now") }
            }
        }

        // ---- Printer ----
        PosCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.Print, null, tint = MaterialTheme.colorScheme.primary)
                    Text("Receipt printer", style = MaterialTheme.typography.titleMedium)
                }
                var printer by remember { mutableStateOf(vm.config.printerHost ?: "") }
                OutlinedTextField(
                    value = printer,
                    onValueChange = { printer = it },
                    label = { Text("Printer IP (ESC/POS, port 9100)") },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                    trailingIcon = {
                        TextButton(onClick = { vm.savePrinter(printer) }) { Text("Save") }
                    },
                )
            }
        }

        // ---- Device ----
        PosCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Device", style = MaterialTheme.typography.titleMedium)
                KVRow("Cashier", vm.cashier?.displayName ?: "—")
                KVRow("Receipt prefix", vm.config.prefix)
                KVRow("Server", vm.config.serverUrl ?: "—")
                KVRow("Device ID", vm.config.deviceId?.take(12)?.plus("…") ?: "—")
            }
        }

        SecondaryButton("Lock terminal", onLock, Modifier.fillMaxWidth())
    }

    if (showOpen) {
        OpenSessionDialog(
            registers = vm.registers,
            onOpen = { id, float -> vm.openSession(id, float); showOpen = false },
            onDismiss = { showOpen = false },
        )
    }

    if (showClose) {
        CloseSessionDialog(
            expected = vm.xReport?.expectedCash,
            onClose = { counted, reason -> vm.closeSession(counted, reason); showClose = false },
            onDismiss = { showClose = false },
        )
    }

    showMovement?.let { type ->
        MovementDialog(
            type = type,
            onSave = { amount, reason -> vm.recordMovement(type, amount, reason); showMovement = null },
            onDismiss = { showMovement = null },
        )
    }
}

@Composable
private fun CloseSessionDialog(
    expected: Double?,
    onClose: (counted: Double, reason: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var counted by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    val countedValue = counted.toDoubleOrNull()
    val variance = if (countedValue != null && expected != null) countedValue - expected else null

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Close session", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                expected?.let { KVRow("Expected cash", Money.format(it)) }
                OutlinedTextField(
                    value = counted,
                    onValueChange = { counted = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Counted cash (UGX)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                variance?.let {
                    KVRow(
                        "Variance",
                        Money.format(it),
                        valueColor = when {
                            it == 0.0 -> MaterialTheme.colorScheme.primary
                            else -> MaterialTheme.colorScheme.error
                        },
                    )
                }
                if (variance != null && variance != 0.0) {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("Variance reason") },
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = countedValue != null,
                shape = MaterialTheme.shapes.medium,
                onClick = { onClose(countedValue ?: 0.0, reason.takeIf { it.isNotBlank() }) },
            ) { Text("Close session") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun MovementDialog(
    type: String,
    onSave: (amount: Double, reason: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    val amountValue = amount.toDoubleOrNull()

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        icon = { Icon(Icons.Outlined.SwapVert, null) },
        title = { Text(if (type == "pay_in") "Cash in" else "Cash out", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = amount,
                    onValueChange = { amount = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Amount (UGX)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("Reason") },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                enabled = amountValue != null && amountValue > 0,
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(amountValue ?: 0.0, reason.takeIf { it.isNotBlank() }) },
            ) { Text("Record") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
