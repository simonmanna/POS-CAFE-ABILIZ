package com.cafe.pos.ui.screens.receipts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Print
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.CheckoutResult
import com.cafe.pos.data.repository.PosRepository
import com.cafe.pos.hardware.HardwareServices
import com.cafe.pos.hardware.ReceiptPrintJob
import com.cafe.pos.hardware.ReceiptLine
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.toReceiptJob
import com.cafe.pos.ui.screens.manager.ManagerOverrideDialog
import com.cafe.pos.ui.screens.manager.OverrideKind
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ReceiptUiState(
    val refunding: Boolean = false,
    val voiding: Boolean = false,
    val lastMessage: String? = null,
    val overrideId: String? = null,
)

@HiltViewModel
class ReceiptViewModel @Inject constructor(
    private val posRepository: PosRepository,
    private val hardware: HardwareServices,
) : ViewModel() {

    private val _state = MutableStateFlow(ReceiptUiState())
    val state: StateFlow<ReceiptUiState> = _state.asStateFlow()

    private val printer: PrinterManager get() = hardware.printer

    /** Re-prints the receipt to the active printer. */
    fun printReceipt(invoiceId: String) {
        viewModelScope.launch {
            val job = ReceiptPrintJob(
                storeName = "Cafe POS",
                storeAddress = null,
                invoiceNumber = invoiceId,
                cashier = null,
                lines = listOf(ReceiptLine("Reprint $invoiceId", 1.0, 0.0)),
                subtotal = 0.0, discount = 0.0, tax = 0.0, total = 0.0,
                tendered = 0.0, change = 0.0, paymentMethod = "n/a",
                footer = "Reprint", cutPaper = true,
            )
            val ok = printer.printReceipt(job)
            _state.update { it.copy(lastMessage = if (ok) "Reprint sent" else "Print failed") }
        }
    }

    /** Manager approved a refund. Calls [PosRepository.refund] which on success
     *  returns a new CheckoutResult (the credit-note invoice). */
    fun refund(invoiceId: String, managerId: String, reason: String?) {
        viewModelScope.launch {
            _state.update { it.copy(refunding = true, lastMessage = null) }
            try {
                val res = posRepository.refund(
                    invoiceId = invoiceId,
                    reason = reason,
                    overrideById = managerId,
                    cashSessionId = null,  // server uses the open session in tenant context
                )
                _state.update {
                    it.copy(refunding = false, lastMessage = "Refunded: ${res.invoiceNumber}")
                }
            } catch (t: Throwable) {
                _state.update { it.copy(refunding = false, lastMessage = t.message ?: "Refund failed") }
            }
        }
    }

    /** Manager approved a void. Calls [PosRepository.voidSale] which marks
     *  the sale as voided and reverses the underlying payments. */
    fun voidSale(invoiceId: String, managerId: String, reason: String?) {
        viewModelScope.launch {
            _state.update { it.copy(voiding = true, lastMessage = null) }
            try {
                posRepository.voidSale(
                    invoiceId = invoiceId,
                    reason = reason ?: "(no reason)",
                    overrideById = managerId,
                )
                _state.update {
                    it.copy(voiding = false, lastMessage = "Sale voided")
                }
            } catch (t: Throwable) {
                _state.update { it.copy(voiding = false, lastMessage = t.message ?: "Void failed") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiptScreen(
    invoiceId: String,
    onBack: () -> Unit,
    viewModel: ReceiptViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    var showRefundOverride by remember { mutableStateOf(false) }
    var showVoidOverride by remember { mutableStateOf(false) }
    var refundReason by remember { mutableStateOf("") }
    var voidReason by remember { mutableStateOf("") }

    // Surface lastMessage via snackbar
    LaunchedEffect(state.lastMessage) {
        state.lastMessage?.let { snackbar.showSnackbar(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Receipt") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().padding(16.dp)) {
            Surface(
                tonalElevation = 4.dp,
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Sale complete", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(8.dp))
                    Text("Invoice", style = MaterialTheme.typography.labelMedium)
                    Text(invoiceId, style = MaterialTheme.typography.titleLarge)
                    if (invoiceId.startsWith("PENDING-")) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "This sale was queued offline and will sync automatically.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))

            // Manager-gated actions: refund + void.
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { showRefundOverride = true },
                    modifier = Modifier.weight(1f).height(48.dp),
                    enabled = !invoiceId.startsWith("PENDING-"),
                ) {
                    Icon(Icons.Default.Undo, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("Refund")
                }
                OutlinedButton(
                    onClick = { showVoidOverride = true },
                    modifier = Modifier.weight(1f).height(48.dp),
                    enabled = !invoiceId.startsWith("PENDING-"),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                ) {
                    Icon(Icons.Default.Block, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("Void")
                }
            }
            Spacer(Modifier.height(8.dp))

            // Reprint + new sale.
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onBack, modifier = Modifier.weight(1f).height(48.dp)) {
                    Text("New sale")
                }
                Button(
                    onClick = { viewModel.printReceipt(invoiceId) },
                    modifier = Modifier.weight(1f).height(48.dp),
                ) {
                    Icon(Icons.Default.Print, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("Print")
                }
            }
        }
    }

    if (showRefundOverride) {
        ManagerOverrideDialog(
            kind = OverrideKind.ManualRefund,
            onDismiss = { showRefundOverride = false },
            onAuthorized = { managerId ->
                showRefundOverride = false
                viewModel.refund(invoiceId, managerId, refundReason.ifBlank { null })
            },
        )
    }
    if (showVoidOverride) {
        ManagerOverrideDialog(
            kind = OverrideKind.Void,
            onDismiss = { showVoidOverride = false },
            onAuthorized = { managerId ->
                showVoidOverride = false
                viewModel.voidSale(invoiceId, managerId, voidReason.ifBlank { null })
            },
        )
    }
}