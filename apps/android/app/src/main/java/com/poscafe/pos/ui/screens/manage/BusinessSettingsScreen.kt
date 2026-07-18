package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.PosCard
import com.poscafe.pos.ui.components.PrimaryButton
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class BusinessSettingsViewModel @Inject constructor(val config: DeviceConfig) : ViewModel()

/** Receipt identity: what prints at the top and bottom of every ticket. */
@Composable
fun BusinessSettingsScreen(onBack: () -> Unit, vm: BusinessSettingsViewModel = hiltViewModel()) {
    var name by remember { mutableStateOf(vm.config.businessName) }
    var address by remember { mutableStateOf(vm.config.businessAddress ?: "") }
    var tin by remember { mutableStateOf(vm.config.businessTin ?: "") }
    var footer by remember { mutableStateOf(vm.config.receiptFooter) }
    var prefix by remember { mutableStateOf(vm.config.prefix) }
    var saved by remember { mutableStateOf(false) }

    ManageScaffold(title = "Business settings", onBack = onBack) { _ ->
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PosCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Receipt header", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        value = name, onValueChange = { name = it; saved = false },
                        label = { Text("Business name") }, singleLine = true,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = address, onValueChange = { address = it; saved = false },
                        label = { Text("Address / phone (optional)") }, singleLine = true,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = tin, onValueChange = { tin = it; saved = false },
                        label = { Text("TIN (optional)") }, singleLine = true,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = footer, onValueChange = { footer = it; saved = false },
                        label = { Text("Receipt footer") }, singleLine = true,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = prefix, onValueChange = { prefix = it; saved = false },
                        label = { Text("Receipt number prefix") }, singleLine = true,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.width(200.dp),
                    )
                    PrimaryButton(
                        text = if (saved) "Saved ✓" else "Save",
                        onClick = {
                            vm.config.businessName = name.trim().ifBlank { "POS CAFE" }
                            vm.config.businessAddress = address.trim().takeIf { it.isNotBlank() }
                            vm.config.businessTin = tin.trim().takeIf { it.isNotBlank() }
                            vm.config.receiptFooter = footer.trim().ifBlank { "Thank you!" }
                            vm.config.prefix = prefix.trim().ifBlank { vm.config.prefix }
                            saved = true
                        },
                        modifier = Modifier.fillMaxWidth(),
                        height = 48.dp,
                    )
                }
            }
            PosCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Mode", style = MaterialTheme.typography.titleMedium)
                    KVRow("Running as", if (vm.config.standalone) "Standalone (fully offline)" else "Connected to server")
                    if (!vm.config.standalone) {
                        KVRow("Server", vm.config.serverUrl ?: "—")
                        KVRow("Device ID", vm.config.deviceId?.take(12)?.plus("…") ?: "—")
                    }
                }
            }
        }
    }
}
