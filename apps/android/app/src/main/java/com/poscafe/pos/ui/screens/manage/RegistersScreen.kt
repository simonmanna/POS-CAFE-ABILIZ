package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PointOfSale
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.entity.CashRegisterEntity
import com.poscafe.pos.data.repo.RegisterRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class RegistersViewModel @Inject constructor(
    registerDao: RegisterDao,
    private val registers: RegisterRepository,
) : ViewModel() {
    val list: StateFlow<List<CashRegisterEntity>> =
        registerDao.allFlow().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(existing: CashRegisterEntity?, name: String, active: Boolean) {
        viewModelScope.launch {
            val n = list.value.size
            registers.save(
                CashRegisterEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    code = existing?.code ?: "REG${n + 1}",
                    name = name.trim().ifBlank { "Register ${n + 1}" },
                    isActive = active,
                    sortOrder = existing?.sortOrder ?: n,
                ),
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { registers.delete(id) }
}

@Composable
fun RegistersScreen(onBack: () -> Unit, vm: RegistersViewModel = hiltViewModel()) {
    val list by vm.list.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<CashRegisterEntity?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Cash registers",
        onBack = onBack,
        fabLabel = "New register",
        onFab = { showAdd = true },
    ) { _ ->
        if (list.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.PointOfSale,
                title = "No registers",
                subtitle = "Add a register (drawer) to open cash sessions against.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(list, key = { it.id }) { r ->
                    Surface(
                        onClick = { editing = r },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(r.name ?: r.code, style = MaterialTheme.typography.titleSmall)
                                Text(r.code, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (!r.isActive) StatusPill("Inactive", MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.surfaceContainerHigh)
                        }
                    }
                }
            }
        }
    }

    if (showAdd || editing != null) {
        RegisterEditorDialog(
            existing = editing,
            onSave = { name, active -> vm.save(editing, name, active); showAdd = false; editing = null },
            onDelete = editing?.let { r -> { vm.delete(r.id); editing = null } },
            onDismiss = { showAdd = false; editing = null },
        )
    }
}

@Composable
private fun RegisterEditorDialog(
    existing: CashRegisterEntity?,
    onSave: (name: String, active: Boolean) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var active by remember { mutableStateOf(existing?.isActive ?: true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New register" else "Edit register", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Active", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = active, onCheckedChange = { active = it })
                }
                onDelete?.let { TextButton(onClick = it) { Text("Delete register", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = { Button(shape = MaterialTheme.shapes.medium, onClick = { onSave(name, active) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
