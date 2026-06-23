package com.cafe.pos.ui.screens.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.hardware.PrinterDevice
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.ReceiptPrintJob
import com.cafe.pos.hardware.ReceiptLine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val devices: List<PrinterDevice> = emptyList(),
    val connectedId: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val showAddNetwork: Boolean = false,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val printer: PrinterManager,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                _state.update {
                    it.copy(
                        loading = false,
                        devices = printer.listAvailable(),
                        connectedId = if (printer.isConnected()) "(active)" else null,
                    )
                }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }

    fun connect(device: PrinterDevice, onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            val ok = printer.connect(device)
            _state.update { it.copy(connectedId = if (ok) device.id else it.connectedId) }
            onResult(ok)
        }
    }

    fun openAddNetwork() = _state.update { it.copy(showAddNetwork = true) }
    fun closeAddNetwork() = _state.update { it.copy(showAddNetwork = false) }

    fun openCashDrawer(onResult: (Boolean) -> Unit) {
        viewModelScope.launch { onResult(printer.openCashDrawer()) }
    }

    fun printTest(onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            val job = ReceiptPrintJob(
                storeName = "Cafe POS",
                storeAddress = "Test print",
                invoiceNumber = "TEST-${System.currentTimeMillis() % 1000}",
                cashier = "self-test",
                lines = listOf(ReceiptLine("Test item", 1.0, 1.0)),
                subtotal = 1.0, discount = 0.0, tax = 0.0, total = 1.0,
                tendered = 1.0, change = 0.0, paymentMethod = "cash",
                footer = "Printer test OK", cutPaper = true,
            )
            onResult(printer.printReceipt(job))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Printers", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { viewModel.openAddNetwork() }) { Text("Add network…") }
            }
            if (state.loading && state.devices.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else if (state.devices.isEmpty()) {
                Text(
                    "No printers found. Plug in a USB printer, pair a Bluetooth one, or add a network printer by IP.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            } else {
                LazyColumn(modifier = Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.devices, key = { it.id }) { device ->
                        Card(
                            modifier = Modifier.fillMaxWidth().clickable {
                                viewModel.connect(device) { ok ->
                                    scope.launch { snackbar.showSnackbar(if (ok) "Connected: ${device.name}" else "Connection failed") }
                                }
                            },
                        ) {
                            Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    imageVector = when (device.transport) {
                                        PrinterDevice.Transport.USB -> Icons.Default.Usb
                                        PrinterDevice.Transport.BLUETOOTH -> Icons.Default.Bluetooth
                                        PrinterDevice.Transport.NETWORK -> Icons.Default.Print
                                    },
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                                Spacer(Modifier.padding(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(device.name, style = MaterialTheme.typography.titleMedium)
                                    Text(device.transport.name + " • " + device.address,
                                        style = MaterialTheme.typography.bodySmall)
                                }
                                if (state.connectedId == device.id) {
                                    Text("Active", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))

                Row(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Card(modifier = Modifier.weight(1f).clickable {
                        viewModel.printTest { ok ->
                            scope.launch { snackbar.showSnackbar(if (ok) "Test page sent" else "Print failed") }
                        }
                    }) {
                        Column(modifier = Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.Print, contentDescription = null)
                            Text("Print test")
                        }
                    }
                    Card(modifier = Modifier.weight(1f).clickable {
                        viewModel.openCashDrawer { ok ->
                            scope.launch { snackbar.showSnackbar(if (ok) "Cash drawer opened" else "No printer connected") }
                        }
                    }) {
                        Column(modifier = Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Text("Open drawer")
                        }
                    }
                }
            }
            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
            }
        }

        if (state.showAddNetwork) {
            AddNetworkPrinterDialog(
                onAdd = { ip, port ->
                    viewModel.closeAddNetwork()
                    val device = PrinterDevice(
                        id = "net:$ip:$port",
                        name = "Network ($ip:$port)",
                        transport = PrinterDevice.Transport.NETWORK,
                        address = "$ip:$port",
                    )
                    viewModel.connect(device) { ok ->
                        scope.launch { snackbar.showSnackbar(if (ok) "Connected: ${device.name}" else "Could not reach $ip:$port") }
                    }
                },
                onCancel = { viewModel.closeAddNetwork() },
            )
        }
    }
}

@Composable
private fun AddNetworkPrinterDialog(
    onAdd: (String, Int) -> Unit,
    onCancel: () -> Unit,
) {
    var ip by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("9100") }
    val canSubmit = ip.isNotBlank() && port.toIntOrNull() != null

    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Add network printer") },
        text = {
            Column {
                Text(
                    "Enter the IP and port of a network ESC/POS printer (default port 9100).",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = ip, onValueChange = { ip = it },
                    label = { Text("IP address") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = port, onValueChange = { port = it.filter { c -> c.isDigit() } },
                    label = { Text("Port") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onAdd(ip.trim(), port.toIntOrNull() ?: 9100) },
                enabled = canSubmit,
            ) { Text("Connect") }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}