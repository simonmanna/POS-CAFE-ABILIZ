package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import at.favre.lib.crypto.bcrypt.BCrypt
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.dao.StaffDao
import com.poscafe.pos.data.local.entity.CashRegisterEntity
import com.poscafe.pos.data.local.entity.StaffEntity
import com.poscafe.pos.data.repo.SyncRepository
import com.poscafe.pos.sync.SyncWorker
import com.poscafe.pos.ui.components.PosCard
import com.poscafe.pos.ui.components.PrimaryButton
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

/**
 * First-run setup. Two paths:
 *  - STANDALONE: the tablet IS the whole POS. A local admin + register are
 *    created on the spot; no server, no internet, ever.
 *  - SERVER: classic enrollment against the NestJS backend (token shown once
 *    in the back office); first pull seeds the catalog.
 */
@HiltViewModel
class SetupViewModel @Inject constructor(
    val config: DeviceConfig,
    private val sync: SyncRepository,
    private val staffDao: StaffDao,
    private val registerDao: RegisterDao,
) : ViewModel() {
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set

    fun enroll(serverUrl: String, deviceId: String, token: String, prefix: String, onDone: () -> Unit) {
        viewModelScope.launch {
            busy = true; error = null
            try {
                config.serverUrl = serverUrl.trim().removeSuffix("/") + "/"
                config.deviceId = deviceId.trim()
                config.deviceToken = token.trim()
                config.prefix = prefix.trim().ifBlank { "D1" }
                sync.pull() // validates the token + seeds the catalog
                onDone()
            } catch (e: Exception) {
                error = e.message ?: "Enrollment failed"
                config.clearEnrollment()
            } finally {
                busy = false
            }
        }
    }

    fun setupStandalone(businessName: String, adminName: String, pin: String, prefix: String, onDone: () -> Unit) {
        viewModelScope.launch {
            busy = true; error = null
            try {
                require(pin.length in 4..8 && pin.all { it.isDigit() }) { "PIN must be 4–8 digits" }
                require(adminName.isNotBlank()) { "Admin name is required" }
                val pinHash = BCrypt.withDefaults().hashToString(10, pin.toCharArray())
                staffDao.upsertAll(
                    listOf(
                        StaffEntity(
                            id = UUID.randomUUID().toString(),
                            firstName = adminName.trim(),
                            lastName = null,
                            email = "admin@local",
                            pinHash = pinHash,
                            permissions = "admin",
                            isActive = true,
                        ),
                    ),
                )
                registerDao.upsertAll(
                    listOf(CashRegisterEntity(id = UUID.randomUUID().toString(), code = "REG1", name = "Main register")),
                )
                config.businessName = businessName.trim().ifBlank { "POS CAFE" }
                config.prefix = prefix.trim().ifBlank { "R1" }
                config.standalone = true
                onDone()
            } catch (e: Exception) {
                error = e.message ?: "Setup failed"
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun SetupScreen(onDone: () -> Unit, vm: SetupViewModel = hiltViewModel()) {
    val context = LocalContext.current
    var mode by remember { mutableStateOf("standalone") }

    Box(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 520.dp).padding(top = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier.size(72.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.Storefront, null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(34.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            Text("Set up this terminal", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(6.dp))
            Text(
                "Run fully offline on this device, or connect to your POS server.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ModeCard(
                    "Standalone", "Works 100% offline.\nNo server needed.",
                    Icons.Outlined.WifiOff, mode == "standalone", Modifier.weight(1f),
                ) { mode = "standalone" }
                ModeCard(
                    "Connect to server", "Sync menu & sales\nwith the back office.",
                    Icons.Outlined.CloudSync, mode == "server", Modifier.weight(1f),
                ) { mode = "server" }
            }
            Spacer(Modifier.height(16.dp))
            if (mode == "standalone") StandaloneForm(vm, onDone) else ServerForm(vm) {
                SyncWorker.schedule(context)
                onDone()
            }
        }
    }
}

@Composable
private fun ModeCard(
    title: String,
    subtitle: String,
    icon: ImageVector,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.large,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
        modifier = modifier,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                icon, null,
                tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StandaloneForm(vm: SetupViewModel, onDone: () -> Unit) {
    var businessName by remember { mutableStateOf("") }
    var adminName by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var prefix by remember { mutableStateOf("R1") }

    PosCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
                value = businessName, onValueChange = { businessName = it },
                label = { Text("Business name") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = adminName, onValueChange = { adminName = it },
                label = { Text("Admin name (first cashier)") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = pin, onValueChange = { pin = it.filter(Char::isDigit).take(8) },
                    label = { Text("Admin PIN (4–8 digits)") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = prefix, onValueChange = { prefix = it },
                    label = { Text("Receipt prefix") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.width(140.dp),
                )
            }
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            PrimaryButton(
                text = if (vm.busy) "Setting up…" else "Start selling offline",
                enabled = !vm.busy && businessName.isNotBlank() && adminName.isNotBlank() && pin.length >= 4,
                onClick = { vm.setupStandalone(businessName, adminName, pin, prefix, onDone) },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "You can add menu items, staff, customers and stock from the side menu after setup. Cloud sync can be enabled later by re-installing in server mode.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ServerForm(vm: SetupViewModel, onEnrolled: () -> Unit) {
    var serverUrl by remember { mutableStateOf("http://192.168.1.10:3000/api/v1") }
    var deviceId by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var prefix by remember { mutableStateOf("D1") }

    PosCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "Register the device in the back office (Settings → Offline devices), then enter the details it shows you.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = serverUrl, onValueChange = { serverUrl = it },
                label = { Text("Server URL") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = deviceId, onValueChange = { deviceId = it },
                label = { Text("Device ID") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token, onValueChange = { token = it },
                label = { Text("Device token (shown once)") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = prefix, onValueChange = { prefix = it },
                label = { Text("Receipt prefix") }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.width(180.dp),
            )
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            PrimaryButton(
                text = if (vm.busy) "Enrolling…" else "Enroll & first sync",
                enabled = !vm.busy && serverUrl.isNotBlank() && deviceId.isNotBlank() && token.isNotBlank(),
                onClick = { vm.enroll(serverUrl, deviceId, token, prefix, onEnrolled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
