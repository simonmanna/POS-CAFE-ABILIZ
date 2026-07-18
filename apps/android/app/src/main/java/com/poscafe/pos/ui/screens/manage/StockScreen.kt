package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inventory2
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
import com.poscafe.pos.data.local.dao.InventoryDao
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.MenuItemEntity
import com.poscafe.pos.data.local.entity.SupplierEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.StatusPill
import com.poscafe.pos.ui.theme.LocalPosAccents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class StockViewModel @Inject constructor(
    menuDao: MenuDao,
    supplierDao: SupplierDao,
    private val inventoryDao: InventoryDao,
    private val auth: AuthRepository,
) : ViewModel() {
    val items: StateFlow<List<MenuItemEntity>> =
        menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val levels: StateFlow<List<InventoryDao.StockLevel>> =
        inventoryDao.stockLevels().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val movements: StateFlow<List<InventoryMovementEntity>> =
        inventoryDao.recent(200).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val suppliers: StateFlow<List<SupplierEntity>> =
        supplierDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Record a manual movement. qty is entered positive; the type sets the sign
     *  (purchase +, waste/transfer −, adjustment carries its own direction). */
    fun record(menuItemId: String, type: String, qty: Double, direction: Int, unitCost: Double?, supplierId: String?, reason: String?) {
        viewModelScope.launch {
            val signed = when (type) {
                "purchase" -> qty
                "waste", "transfer" -> -qty
                else -> qty * direction
            }
            inventoryDao.insert(
                InventoryMovementEntity(
                    id = UUID.randomUUID().toString(),
                    menuItemId = menuItemId,
                    type = type,
                    qtyDelta = signed,
                    unitCost = unitCost,
                    supplierId = supplierId,
                    reason = reason?.takeIf { it.isNotBlank() },
                    saleLocalId = null,
                    actorUserId = auth.current?.userId,
                    occurredAt = System.currentTimeMillis(),
                ),
            )
        }
    }
}

/** Movement-based stock: on-hand is always the sum of movements, never a
 *  stored counter. Sales deduct automatically at checkout. */
@Composable
fun StockScreen(onBack: () -> Unit, vm: StockViewModel = hiltViewModel()) {
    var tab by remember { mutableStateOf(0) }
    val items by vm.items.collectAsStateWithLifecycle()
    val levels by vm.levels.collectAsStateWithLifecycle()
    val movements by vm.movements.collectAsStateWithLifecycle()
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()

    val levelByItem = remember(levels) { levels.associate { it.menuItemId to it.onHand } }
    val itemNames = remember(items) { items.associate { it.id to it.name } }
    var recordFor by remember { mutableStateOf<MenuItemEntity?>(null) }

    ManageScaffold(
        title = "Stock & inventory",
        onBack = onBack,
        header = {
            TabRow(
                selectedTabIndex = tab,
                containerColor = MaterialTheme.colorScheme.background,
                contentColor = MaterialTheme.colorScheme.primary,
            ) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Levels") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Movements") })
            }
        },
    ) { _ ->
        if (tab == 0) {
            if (items.isEmpty()) {
                EmptyState(
                    icon = Icons.Outlined.Inventory2,
                    title = "No products",
                    subtitle = "Add menu items first — stock is tracked per item.",
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 8.dp),
                ) {
                    items(items, key = { it.id }) { item ->
                        val onHand = levelByItem[item.id] ?: 0.0
                        Surface(
                            onClick = { recordFor = item },
                            shape = MaterialTheme.shapes.large,
                            color = MaterialTheme.colorScheme.surface,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Text(
                                    item.name,
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                val accents = LocalPosAccents.current
                                when {
                                    onHand <= 0 -> StatusPill(
                                        fmtQty(onHand),
                                        MaterialTheme.colorScheme.onErrorContainer,
                                        MaterialTheme.colorScheme.errorContainer,
                                    )
                                    onHand <= 5 -> StatusPill(fmtQty(onHand), accents.warning, accents.warningContainer)
                                    else -> StatusPill(fmtQty(onHand), accents.success, accents.successContainer)
                                }
                            }
                        }
                    }
                }
            }
        } else {
            if (movements.isEmpty()) {
                EmptyState(
                    icon = Icons.Outlined.Inventory2,
                    title = "No movements yet",
                    subtitle = "Sales, purchases, waste and adjustments all land here.",
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                val timeFmt = remember { DateTimeFormatter.ofPattern("d MMM HH:mm").withZone(ZoneId.systemDefault()) }
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 8.dp),
                ) {
                    items(movements, key = { it.id }) { m ->
                        Surface(
                            shape = MaterialTheme.shapes.medium,
                            color = MaterialTheme.colorScheme.surface,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        itemNames[m.menuItemId] ?: "Unknown item",
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        "${timeFmt.format(Instant.ofEpochMilli(m.occurredAt))} · ${m.type}${m.reason?.let { " · $it" } ?: ""}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Text(
                                    (if (m.qtyDelta > 0) "+" else "") + fmtQty(m.qtyDelta),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = if (m.qtyDelta >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    recordFor?.let { item ->
        RecordMovementDialog(
            item = item,
            onHand = levelByItem[item.id] ?: 0.0,
            suppliers = suppliers,
            onRecord = { type, qty, direction, cost, supplierId, reason ->
                vm.record(item.id, type, qty, direction, cost, supplierId, reason)
                recordFor = null
            },
            onDismiss = { recordFor = null },
        )
    }
}

private fun fmtQty(q: Double): String = if (q % 1.0 == 0.0) q.toInt().toString() else "%.2f".format(q)

@Composable
private fun RecordMovementDialog(
    item: MenuItemEntity,
    onHand: Double,
    suppliers: List<SupplierEntity>,
    onRecord: (type: String, qty: Double, direction: Int, unitCost: Double?, supplierId: String?, reason: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var type by remember { mutableStateOf("purchase") }
    var qty by remember { mutableStateOf("") }
    var direction by remember { mutableStateOf(1) }
    var cost by remember { mutableStateOf("") }
    var supplierId by remember { mutableStateOf<String?>(null) }
    var reason by remember { mutableStateOf("") }
    val qtyValue = qty.toDoubleOrNull()

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = {
            Column {
                Text(item.name, style = MaterialTheme.typography.headlineSmall)
                Text(
                    "On hand: ${fmtQty(onHand)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TypeChip("Purchase", type == "purchase") { type = "purchase" }
                    TypeChip("Waste", type == "waste") { type = "waste" }
                    TypeChip("Adjust", type == "adjustment") { type = "adjustment" }
                    TypeChip("Transfer", type == "transfer") { type = "transfer" }
                }
                OutlinedTextField(
                    value = qty, onValueChange = { qty = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Quantity") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                if (type == "adjustment") {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TypeChip("Add (+)", direction == 1) { direction = 1 }
                        TypeChip("Remove (−)", direction == -1) { direction = -1 }
                    }
                }
                if (type == "purchase") {
                    OutlinedTextField(
                        value = cost, onValueChange = { cost = it.filter { c -> c.isDigit() || c == '.' } },
                        label = { Text("Unit cost (UGX, optional)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    )
                    if (suppliers.isNotEmpty()) {
                        Text("Supplier", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            suppliers.forEach { s ->
                                TypeChip(s.name, supplierId == s.id) {
                                    supplierId = if (supplierId == s.id) null else s.id
                                }
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = reason, onValueChange = { reason = it },
                    label = { Text("Reason / note") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                enabled = qtyValue != null && qtyValue > 0,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    onRecord(type, qtyValue ?: 0.0, direction, cost.toDoubleOrNull(), supplierId, reason)
                },
            ) { Text("Record") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun TypeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
        border = if (selected) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}
