package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import at.favre.lib.crypto.bcrypt.BCrypt
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.StaffDao
import com.poscafe.pos.data.local.entity.StaffEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class StaffViewModel @Inject constructor(
    private val staffDao: StaffDao,
    private val auth: AuthRepository,
    val config: DeviceConfig,
) : ViewModel() {
    var staff by mutableStateOf<List<StaffEntity>>(emptyList()); private set
    val editable get() = config.standalone
    val currentUserId get() = auth.current?.userId

    init { refresh() }

    fun refresh() {
        viewModelScope.launch { staff = staffDao.all() }
    }

    fun save(existing: StaffEntity?, firstName: String, lastName: String?, pin: String?, active: Boolean) {
        viewModelScope.launch {
            val pinHash = pin?.takeIf { it.isNotBlank() }
                ?.let { BCrypt.withDefaults().hashToString(10, it.toCharArray()) }
                ?: existing?.pinHash
            staffDao.upsertAll(
                listOf(
                    StaffEntity(
                        id = existing?.id ?: UUID.randomUUID().toString(),
                        firstName = firstName.trim(),
                        lastName = lastName?.trim()?.takeIf { it.isNotBlank() },
                        email = existing?.email ?: "${firstName.trim().lowercase().replace(' ', '.')}@local",
                        pinHash = pinHash,
                        permissions = existing?.permissions ?: "cashier",
                        isActive = active,
                    ),
                ),
            )
            refresh()
        }
    }

    fun delete(id: String) {
        viewModelScope.launch {
            staffDao.delete(id)
            refresh()
        }
    }
}

/** Local staff & PINs. Standalone only — enrolled devices sync staff from the server. */
@Composable
fun StaffScreen(onBack: () -> Unit, vm: StaffViewModel = hiltViewModel()) {
    var editing by remember { mutableStateOf<StaffEntity?>(null) }
    var adding by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Staff",
        onBack = onBack,
        fabLabel = if (vm.editable) "New staff" else null,
        onFab = if (vm.editable) ({ adding = true }) else null,
        header = { if (!vm.editable) ServerManagedBanner() },
    ) { _ ->
        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
        ) {
            items(vm.staff, key = { it.id }) { user ->
                val name = listOfNotNull(user.firstName, user.lastName).joinToString(" ")
                Surface(
                    onClick = { if (vm.editable) editing = user },
                    shape = MaterialTheme.shapes.large,
                    color = MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                name.take(1).uppercase(),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Column(Modifier.weight(1f)) {
                            Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                user.permissions.ifBlank { "cashier" },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (!user.isActive) {
                            StatusPill(
                                "Inactive",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                container = MaterialTheme.colorScheme.surfaceContainerHigh,
                            )
                        }
                        if (user.pinHash == null) {
                            StatusPill(
                                "No PIN",
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                container = MaterialTheme.colorScheme.errorContainer,
                            )
                        }
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        StaffEditorDialog(
            existing = editing,
            isSelf = editing?.id == vm.currentUserId,
            onSave = { first, last, pin, active ->
                vm.save(editing, first, last, pin, active)
                adding = false; editing = null
            },
            onDelete = editing?.takeIf { it.id != vm.currentUserId }?.let { u -> { vm.delete(u.id); editing = null } },
            onDismiss = { adding = false; editing = null },
        )
    }
}

@Composable
private fun StaffEditorDialog(
    existing: StaffEntity?,
    isSelf: Boolean,
    onSave: (firstName: String, lastName: String?, pin: String?, active: Boolean) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var firstName by remember { mutableStateOf(existing?.firstName ?: "") }
    var lastName by remember { mutableStateOf(existing?.lastName ?: "") }
    var pin by remember { mutableStateOf("") }
    var active by remember { mutableStateOf(existing?.isActive ?: true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        icon = { Icon(Icons.Outlined.Badge, null) },
        title = { Text(if (existing == null) "New staff" else "Edit staff", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = firstName, onValueChange = { firstName = it },
                    label = { Text("First name") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = lastName, onValueChange = { lastName = it },
                    label = { Text("Last name (optional)") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = pin, onValueChange = { pin = it.filter(Char::isDigit).take(8) },
                    label = { Text(if (existing == null) "PIN (4–8 digits)" else "New PIN (leave blank to keep)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                if (!isSelf) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Active", style = MaterialTheme.typography.bodyMedium)
                        Switch(checked = active, onCheckedChange = { active = it })
                    }
                }
                onDelete?.let {
                    TextButton(onClick = it) { Text("Delete staff", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = firstName.isNotBlank() && (existing != null || pin.length >= 4) && (pin.isEmpty() || pin.length >= 4),
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(firstName, lastName, pin.takeIf { it.isNotBlank() }, active) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
