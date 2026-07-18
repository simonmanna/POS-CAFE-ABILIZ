package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.SupplierEntity
import com.poscafe.pos.ui.components.EmptyState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class SuppliersViewModel @Inject constructor(private val dao: SupplierDao) : ViewModel() {
    val suppliers: StateFlow<List<SupplierEntity>> =
        dao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(existing: SupplierEntity?, name: String, phone: String?, note: String?) {
        viewModelScope.launch {
            dao.upsert(
                SupplierEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    phone = phone?.trim()?.takeIf { it.isNotBlank() },
                    note = note?.trim()?.takeIf { it.isNotBlank() },
                    createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                ),
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { dao.delete(id) }
}

@Composable
fun SuppliersScreen(onBack: () -> Unit, vm: SuppliersViewModel = hiltViewModel()) {
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<SupplierEntity?>(null) }
    var adding by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Suppliers",
        onBack = onBack,
        fabLabel = "New supplier",
        onFab = { adding = true },
    ) { _ ->
        if (suppliers.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.LocalShipping,
                title = "No suppliers yet",
                subtitle = "Suppliers appear on stock purchases and inventory reports.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(suppliers, key = { it.id }) { s ->
                    Surface(
                        onClick = { editing = s },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                            Text(s.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(s.phone, s.note).joinToString(" · ").ifBlank { "—" },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        SupplierEditorDialog(
            existing = editing,
            onSave = { name, phone, note ->
                vm.save(editing, name, phone, note)
                adding = false; editing = null
            },
            onDelete = editing?.let { s -> { vm.delete(s.id); editing = null } },
            onDismiss = { adding = false; editing = null },
        )
    }
}

@Composable
private fun SupplierEditorDialog(
    existing: SupplierEntity?,
    onSave: (name: String, phone: String?, note: String?) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var phone by remember { mutableStateOf(existing?.phone ?: "") }
    var note by remember { mutableStateOf(existing?.note ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New supplier" else "Edit supplier", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = phone, onValueChange = { phone = it },
                    label = { Text("Phone") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = note, onValueChange = { note = it },
                    label = { Text("Note") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                onDelete?.let {
                    TextButton(onClick = it) { Text("Delete supplier", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            Button(enabled = name.isNotBlank(), shape = MaterialTheme.shapes.medium, onClick = { onSave(name, phone, note) }) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
