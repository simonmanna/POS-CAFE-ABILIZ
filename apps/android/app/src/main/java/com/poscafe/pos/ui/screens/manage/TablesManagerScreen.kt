package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.TableDao
import com.poscafe.pos.data.local.entity.PosTableEntity
import com.poscafe.pos.data.repo.CatalogRepository
import com.poscafe.pos.ui.components.EmptyState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class TablesManagerViewModel @Inject constructor(
    tableDao: TableDao,
    private val catalog: CatalogRepository,
) : ViewModel() {
    val tables: StateFlow<List<PosTableEntity>> =
        tableDao.tables().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(existing: PosTableEntity?, number: String, name: String?) {
        viewModelScope.launch {
            catalog.saveTable(
                PosTableEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    number = number.trim(),
                    name = name?.trim()?.takeIf { it.isNotBlank() },
                    status = existing?.status ?: "available",
                    sortOrder = existing?.sortOrder ?: (tables.value.mapNotNull { it.number.toIntOrNull() }.maxOrNull() ?: 0) + 1,
                ),
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { catalog.deleteTable(id) }
}

@Composable
fun TablesManagerScreen(onBack: () -> Unit, vm: TablesManagerViewModel = hiltViewModel()) {
    val tables by vm.tables.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<PosTableEntity?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Tables",
        onBack = onBack,
        fabLabel = "New table",
        onFab = { showAdd = true },
    ) { _ ->
        if (tables.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.TableRestaurant,
                title = "No tables yet",
                subtitle = "Add tables so dine-in orders can be seated.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(tables, key = { it.id }) { t ->
                    Surface(
                        onClick = { editing = t },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Table ${t.number}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            t.name?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
    }

    if (showAdd || editing != null) {
        TableEditorDialog(
            existing = editing,
            onSave = { number, name -> vm.save(editing, number, name); showAdd = false; editing = null },
            onDelete = editing?.let { t -> { vm.delete(t.id); editing = null } },
            onDismiss = { showAdd = false; editing = null },
        )
    }
}

@Composable
private fun TableEditorDialog(
    existing: PosTableEntity?,
    onSave: (number: String, name: String?) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var number by remember { mutableStateOf(existing?.number ?: "") }
    var name by remember { mutableStateOf(existing?.name ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New table" else "Edit table", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = number, onValueChange = { number = it }, label = { Text("Table number") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name / zone (optional)") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                onDelete?.let { TextButton(onClick = it) { Text("Delete table", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = {
            Button(enabled = number.isNotBlank(), shape = MaterialTheme.shapes.medium, onClick = { onSave(number, name) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
