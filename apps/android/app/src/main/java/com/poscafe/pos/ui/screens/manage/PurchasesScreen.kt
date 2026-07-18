package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.ShoppingCart
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
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.PurchaseDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.MenuItemEntity
import com.poscafe.pos.data.local.entity.PurchaseEntity
import com.poscafe.pos.data.local.entity.SupplierEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.PurchaseRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.PrimaryButton
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

@HiltViewModel
class PurchasesViewModel @Inject constructor(
    menuDao: MenuDao,
    supplierDao: SupplierDao,
    purchaseDao: PurchaseDao,
    private val purchases: PurchaseRepository,
    private val auth: AuthRepository,
) : ViewModel() {
    val items: StateFlow<List<MenuItemEntity>> =
        menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val suppliers: StateFlow<List<SupplierEntity>> =
        supplierDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val recent: StateFlow<List<PurchaseEntity>> =
        purchaseDao.recent(200).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var error by mutableStateOf<String?>(null); private set

    fun receive(supplierId: String?, reference: String?, note: String?, lines: List<PurchaseRepository.Line>, onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { purchases.receive(auth.current?.userId, supplierId, reference, note, lines) }
                .onSuccess { error = null; onDone() }
                .onFailure { error = it.message }
        }
    }
}

@Composable
fun PurchasesScreen(onBack: () -> Unit, vm: PurchasesViewModel = hiltViewModel()) {
    val items by vm.items.collectAsStateWithLifecycle()
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()
    val recent by vm.recent.collectAsStateWithLifecycle()
    val supplierNames = remember(suppliers) { suppliers.associate { it.id to it.name } }
    var building by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Purchases",
        onBack = onBack,
        fabLabel = if (items.isEmpty()) null else "New purchase",
        onFab = if (items.isEmpty()) null else ({ building = true }),
    ) { _ ->
        if (items.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.Inventory2,
                title = "Add products first",
                subtitle = "Purchases receive stock against menu items.",
                modifier = Modifier.fillMaxSize(),
            )
        } else if (recent.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.ShoppingCart,
                title = "No purchases yet",
                subtitle = "Record goods received to add stock and track cost.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            val timeFmt = remember { DateTimeFormatter.ofPattern("d MMM HH:mm").withZone(ZoneId.systemDefault()) }
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(recent, key = { it.id }) { p ->
                    Surface(
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    p.reference?.let { "PO $it" } ?: (supplierNames[p.supplierId] ?: "Purchase"),
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    "${timeFmt.format(Instant.ofEpochMilli(p.occurredAt))}${p.supplierId?.let { " · ${supplierNames[it] ?: ""}" } ?: ""}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(
                                Money.format(p.totalCost),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
    }

    if (building) {
        PurchaseBuilderDialog(
            items = items,
            suppliers = suppliers,
            error = vm.error,
            onReceive = { supplierId, reference, note, lines ->
                vm.receive(supplierId, reference, note, lines) { building = false }
            },
            onDismiss = { building = false },
        )
    }
}

@Composable
private fun PurchaseBuilderDialog(
    items: List<MenuItemEntity>,
    suppliers: List<SupplierEntity>,
    error: String?,
    onReceive: (supplierId: String?, reference: String?, note: String?, lines: List<PurchaseRepository.Line>) -> Unit,
    onDismiss: () -> Unit,
) {
    data class DraftLine(val item: MenuItemEntity, val qty: String, val cost: String)

    var supplierId by remember { mutableStateOf<String?>(null) }
    var reference by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    val lines = remember { mutableStateListOf<DraftLine>() }
    var picking by remember { mutableStateOf(false) }

    val total = lines.sumOf { (it.qty.toDoubleOrNull() ?: 0.0) * (it.cost.toDoubleOrNull() ?: 0.0) }
    val valid = lines.isNotEmpty() && lines.all { (it.qty.toDoubleOrNull() ?: 0.0) > 0 }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("New purchase", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (suppliers.isNotEmpty()) {
                    Text("Supplier", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        suppliers.forEach { s ->
                            ChoiceChipRow(s.name, supplierId == s.id) {
                                supplierId = if (supplierId == s.id) null else s.id
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = reference, onValueChange = { reference = it },
                    label = { Text("Reference / invoice # (optional)") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )

                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Text("Items", style = MaterialTheme.typography.titleSmall)
                lines.forEachIndexed { index, line ->
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(line.item.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                IconButton(onClick = { lines.removeAt(index) }, modifier = Modifier.size(28.dp)) {
                                    Icon(Icons.Outlined.DeleteOutline, "Remove", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                                }
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedTextField(
                                    value = line.qty,
                                    onValueChange = { lines[index] = line.copy(qty = it.filter { c -> c.isDigit() || c == '.' }) },
                                    label = { Text("Qty") }, singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                    shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f),
                                )
                                OutlinedTextField(
                                    value = line.cost,
                                    onValueChange = { lines[index] = line.copy(cost = it.filter { c -> c.isDigit() || c == '.' }) },
                                    label = { Text("Unit cost") }, singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                    shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1.3f),
                                )
                            }
                        }
                    }
                }
                OutlinedButton(onClick = { picking = true }, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                    Text("+ Add item")
                }

                OutlinedTextField(
                    value = note, onValueChange = { note = it },
                    label = { Text("Note (optional)") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Total", style = MaterialTheme.typography.titleMedium)
                    Text(Money.format(total), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = valid,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    onReceive(
                        supplierId,
                        reference,
                        note,
                        lines.map {
                            PurchaseRepository.Line(
                                menuItemId = it.item.id,
                                name = it.item.name,
                                quantity = it.qty.toDoubleOrNull() ?: 0.0,
                                unitCost = it.cost.toDoubleOrNull() ?: 0.0,
                            )
                        },
                    )
                },
            ) { Text("Receive stock") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )

    if (picking) {
        ItemPickerDialog(
            items = items,
            onPick = { item ->
                lines.add(DraftLine(item, "1", item.basePriceMajor?.let { "%.0f".format(it) } ?: ""))
                picking = false
            },
            onDismiss = { picking = false },
        )
    }
}

@Composable
private fun ItemPickerDialog(items: List<MenuItemEntity>, onPick: (MenuItemEntity) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Choose item", style = MaterialTheme.typography.titleMedium) },
        text = {
            LazyColumn(Modifier.heightIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(items, key = { it.id }) { item ->
                    Surface(
                        onClick = { onPick(item) },
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(item.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(12.dp))
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun ChoiceChipRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(10.dp))
    }
}
