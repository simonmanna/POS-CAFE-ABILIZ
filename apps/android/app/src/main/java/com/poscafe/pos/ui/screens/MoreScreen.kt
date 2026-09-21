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
    var opening by mutableStateOf<CashSessionRepository.OpeningOptions?>(null); private set
    var cashContext by mutableStateOf<CashSessionRepository.CashContext?>(null); private set
    var closeBlocker by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    /** Error shown inside the open/close/movement dialog that is on screen. */
    var dialogError by mutableStateOf<String?>(null); private set

    val cashier get() = auth.current

    fun refreshXReport() {
        viewModelScope.launch { xReport = sessions.xReport() }
    }

    fun loadOpening() {
        dialogError = null
        viewModelScope.launch { opening = sessions.openingOptions() }
    }

    /** Refresh what the close / movement dialogs need (tenders, accounts, blockers). */
    fun loadCashContext() {
        dialogError = null
        viewModelScope.launch {
            cashContext = sessions.context(null)
            closeBlocker = sessions.closeBlocker()
            xReport = sessions.xReport()
        }
    }

    fun openSession(registerId: String, float: Double, sourceId: String?, notes: String?, onDone: () -> Unit) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching { sessions.open(user.userId, registerId, float, sourceId, notes) }
                .onFailure { dialogError = it.message }
                .onSuccess { dialogError = null; error = null; refreshXReport(); onDone() }
        }
    }

    fun closeSession(req: CloseRequest, onDone: () -> Unit) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching {
                // The approver is verified here against the synced PIN hashes and
                // again by the server when the close replays.
                val approval = req.managerPin?.let { pin ->
                    val mgr = auth.verifyPinFor(pin, "cash_session:approve_variance", excludeCurrent = true).getOrThrow()
                    CashSessionRepository.Approval(mgr.userId, pin)
                }
                sessions.close(user.userId, req.counted, req.varianceReason, req.closingAccounts, req.uncountedAccounts, approval)
            }
                .onFailure { dialogError = it.message }
                .onSuccess { dialogError = null; error = null; xReport = null; onDone() }
        }
    }

    fun recordMovement(type: String, amount: Double, reason: String, counterpartId: String?, managerPin: String?, onDone: () -> Unit) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching {
                val approval = managerPin?.let { pin ->
                    val mgr = auth.verifyPinFor(pin, "cash_session:cash_out", excludeCurrent = true).getOrThrow()
                    CashSessionRepository.Approval(mgr.userId, pin)
                }
                sessions.recordMovement(user.userId, type, amount, reason, counterpartId, approval)
            }
                .onFailure { dialogError = it.message }
                .onSuccess { dialogError = null; refreshXReport(); onDone() }
        }
    }

    fun savePrinter(host: String?) {
        config.printerHost = host?.trim()?.takeIf { it.isNotBlank() }
    }

    var pinError by mutableStateOf<String?>(null); private set
    var pinSaved by mutableStateOf(false); private set

    fun changePin(currentPin: String, newPin: String) {
        pinError = null
        pinSaved = false
        val user = auth.current ?: return
        viewModelScope.launch {
            auth.changePin(user.userId, currentPin, newPin)
                .onSuccess { pinSaved = true }
                .onFailure { pinError = it.message ?: "Failed to change PIN" }
        }
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
    var showChangePin by remember { mutableStateOf(false) }

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
                        SecondaryButton("Cash in", { vm.loadCashContext(); showMovement = "pay_in" }, Modifier.weight(1f), height = 48.dp)
                        SecondaryButton("Cash out", { vm.loadCashContext(); showMovement = "pay_out" }, Modifier.weight(1f), height = 48.dp)
                        PrimaryButton("Close session", { vm.loadCashContext(); showClose = true }, Modifier.weight(1.2f), height = 48.dp)
                    }
                } else {
                    Text(
                        "Open a session to track the drawer for this shift.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    PrimaryButton("Open session", { vm.loadOpening(); showOpen = true }, Modifier.fillMaxWidth(), height = 48.dp)
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
                Spacer(Modifier.height(4.dp))
                SecondaryButton("Change PIN", { showChangePin = true }, Modifier.fillMaxWidth(), height = 44.dp)
            }
        }

        SecondaryButton("Lock terminal", onLock, Modifier.fillMaxWidth())
    }

    if (showOpen) {
        OpenSessionDialog(
            options = vm.opening,
            error = vm.dialogError,
            onOpen = { id, float, sourceId, notes -> vm.openSession(id, float, sourceId, notes) { showOpen = false } },
            onDismiss = { showOpen = false },
        )
    }

    if (showClose) {
        CloseSessionDialog(
            x = vm.xReport,
            trackedTenders = vm.cashContext?.trackedTenders.orEmpty(),
            blocker = vm.closeBlocker,
            error = vm.dialogError,
            onClose = { req -> vm.closeSession(req) { showClose = false } },
            onDismiss = { showClose = false },
        )
    }

    showMovement?.let { type ->
        MovementDialog(
            type = type,
            context = vm.cashContext,
            error = vm.dialogError,
            onSave = { amount, reason, counterpart, pin -> vm.recordMovement(type, amount, reason, counterpart, pin) { showMovement = null } },
            onDismiss = { showMovement = null },
        )
    }

    if (showChangePin) {
        ChangePinDialog(
            onSave = { current, newPin -> vm.changePin(current, newPin) },
            onDismiss = { showChangePin = false },
            vm = vm,
        )
    }
}

@Composable
private fun ChangePinDialog(
    onSave: (current: String, newPin: String) -> Unit,
    onDismiss: () -> Unit,
    vm: MoreViewModel,
) {
    var currentPin by remember { mutableStateOf("") }
    var newPin by remember { mutableStateOf("") }
    var confirmPin by remember { mutableStateOf("") }
    val mismatch = newPin.isNotBlank() && newPin != confirmPin
    val valid = currentPin.length >= 4 && newPin.length >= 4 && !mismatch

    // Close automatically once the async change succeeds.
    LaunchedEffect(vm.pinSaved) {
        if (vm.pinSaved) onDismiss()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Change PIN", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = currentPin,
                    onValueChange = { currentPin = it.filter { c -> c.isDigit() }.take(8) },
                    label = { Text("Current PIN") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newPin,
                    onValueChange = { newPin = it.filter { c -> c.isDigit() }.take(8) },
                    label = { Text("New PIN (4-8 digits)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = confirmPin,
                    onValueChange = { confirmPin = it.filter { c -> c.isDigit() }.take(8) },
                    label = { Text("Confirm new PIN") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (mismatch) {
                    Text("PINs do not match", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                vm.pinError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (vm.pinSaved) {
                    Text("PIN updated", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = valid,
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(currentPin, newPin) },
            ) { Text("Change PIN") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
