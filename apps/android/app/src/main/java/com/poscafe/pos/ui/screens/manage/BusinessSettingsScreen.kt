package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import android.content.Context
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.SettingsDao
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.data.local.entity.SettingEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.sync.SyncWorker
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.PosCard
import com.poscafe.pos.ui.components.PrimaryButton
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class BusinessSettingsViewModel @Inject constructor(
    val config: DeviceConfig,
    private val settingsDao: SettingsDao,
    private val opQueue: OpQueueDao,
    private val auth: AuthRepository,
    @ApplicationContext private val appContext: Context,
) : ViewModel() {

    val posMode: StateFlow<String> = settingsDao.byKeyFlow("pos.mode")
        .map { it?.valueJson?.let { v -> runCatching { kotlinx.serialization.json.Json.parseToJsonElement(v).let { e -> if (e is kotlinx.serialization.json.JsonPrimitive) e.content else "cafe" } }.getOrDefault("cafe") } ?: "cafe" }
        .stateIn(viewModelScope, SharingStarted.Eagerly, "cafe")

    /**
     * Server-wins mode switch: optimistic local write for instant UI, then a
     * whitelisted `setting.set` op so the org config (and every other device)
     * converges. SyncRepository skips pull rows for keys with a queued
     * setting.set op, so a pull can't flip the toggle back mid-flight.
     */
    fun setPosMode(mode: String) {
        viewModelScope.launch {
            settingsDao.upsert(SettingEntity(key = "pos.mode", valueJson = "\"$mode\""))
            val actor = auth.current?.userId
            if (!config.standalone && actor != null) {
                val payload = buildJsonObject {
                    put("key", "pos.mode")
                    put("value", mode)
                }
                opQueue.enqueueNext { seq ->
                    OpQueueEntity(
                        opId = UUID.randomUUID().toString(),
                        deviceSeq = seq,
                        type = "setting.set",
                        actorUserId = actor,
                        occurredAt = System.currentTimeMillis(),
                        payloadJson = payload.toString(),
                        status = "queued",
                        attempts = 0,
                        lastError = null,
                    )
                }
                SyncWorker.syncNow(appContext)
            }
        }
    }
}

/** Receipt identity + POS mode: what prints on tickets and the terminal layout. */
@Composable
fun BusinessSettingsScreen(onBack: () -> Unit, vm: BusinessSettingsViewModel = hiltViewModel()) {
    var name by remember { mutableStateOf(vm.config.businessName) }
    var address by remember { mutableStateOf(vm.config.businessAddress ?: "") }
    var tin by remember { mutableStateOf(vm.config.businessTin ?: "") }
    var footer by remember { mutableStateOf(vm.config.receiptFooter) }
    var prefix by remember { mutableStateOf(vm.config.prefix) }
    var saved by remember { mutableStateOf(false) }
    val currentMode by vm.posMode.collectAsStateWithLifecycle()

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
                    Spacer(Modifier.height(8.dp))
                    Text("POS terminal", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("cafe" to "Cafe", "retail" to "Retail").forEach { (value, label) ->
                            val selected = currentMode == value
                            Surface(
                                onClick = { if (!selected) vm.setPosMode(value) },
                                shape = RoundedCornerShape(12.dp),
                                color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                                border = if (selected) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                                modifier = Modifier.weight(1f).height(52.dp),
                            ) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text(
                                        label,
                                        style = MaterialTheme.typography.labelLarge,
                                        color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            }
                        }
                    }
                    if (currentMode == "retail") {
                        Text(
                            "Sell tab shows product catalog with barcode scanner. Hold/customer features enabled.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Text(
                            "Sell tab shows menu grid with table assignment. Variants / modifiers available.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
