package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Percent
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
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.entity.TaxEntity
import com.poscafe.pos.data.repo.CatalogRepository
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
class TaxesViewModel @Inject constructor(
    menuDao: MenuDao,
    private val catalog: CatalogRepository,
) : ViewModel() {
    val taxes: StateFlow<List<TaxEntity>> =
        menuDao.allTaxesIncludingInactive().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(existing: TaxEntity?, name: String, rate: Double, active: Boolean) {
        viewModelScope.launch {
            catalog.saveTax(
                TaxEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    rate = rate,
                    isActive = active,
                ),
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { catalog.deleteTax(id) }
}

@Composable
fun TaxesScreen(onBack: () -> Unit, vm: TaxesViewModel = hiltViewModel()) {
    val taxes by vm.taxes.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<TaxEntity?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Taxes",
        onBack = onBack,
        fabLabel = "New tax",
        onFab = { showAdd = true },
    ) { _ ->
        if (taxes.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.Percent,
                title = "No taxes yet",
                subtitle = "Add a VAT/sales tax rate to apply to menu items and products.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(taxes, key = { it.id }) { tax ->
                    Surface(
                        onClick = { editing = tax },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(tax.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            if (!tax.isActive) {
                                StatusPill("Off", MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.surfaceContainerHigh)
                            }
                            Text("${fmtRate(tax.rate)}%", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }

    if (showAdd || editing != null) {
        TaxEditorDialog(
            existing = editing,
            onSave = { name, rate, active -> vm.save(editing, name, rate, active); showAdd = false; editing = null },
            onDelete = editing?.let { t -> { vm.delete(t.id); editing = null } },
            onDismiss = { showAdd = false; editing = null },
        )
    }
}

private fun fmtRate(r: Double): String = if (r % 1.0 == 0.0) r.toInt().toString() else r.toString()

@Composable
private fun TaxEditorDialog(
    existing: TaxEntity?,
    onSave: (name: String, rate: Double, active: Boolean) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var rate by remember { mutableStateOf(existing?.rate?.let { fmtRate(it) } ?: "") }
    var active by remember { mutableStateOf(existing?.isActive ?: true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New tax" else "Edit tax", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name (e.g. VAT)") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = rate, onValueChange = { rate = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Rate (%)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Active", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = active, onCheckedChange = { active = it })
                }
                onDelete?.let {
                    TextButton(onClick = it) { Text("Delete tax", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank() && rate.toDoubleOrNull() != null,
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(name, rate.toDoubleOrNull() ?: 0.0, active) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
