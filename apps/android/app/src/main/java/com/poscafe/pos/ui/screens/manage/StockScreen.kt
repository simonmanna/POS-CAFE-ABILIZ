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
import com.poscafe.pos.data.local.dao.ProductDao
import com.poscafe.pos.data.local.dao.SettingsDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.local.entity.MenuItemEntity
import com.poscafe.pos.data.local.entity.ProductEntity
import com.poscafe.pos.data.local.entity.SupplierEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.StatusPill
import com.poscafe.pos.ui.theme.LocalPosAccents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
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
    productDao: ProductDao,
    settingsDao: SettingsDao,
    private val inventoryDao: InventoryDao,
    private val auth: AuthRepository,
) : ViewModel() {
    val items: StateFlow<List<MenuItemEntity>> =
        menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val levels: StateFlow<List<InventoryDao.StockLevel>> =
        inventoryDao.stockLevels().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val products: StateFlow<List<ProductEntity>> =
        productDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val productLevels: StateFlow<List<InventoryDao.ProductStockLevel>> =
        inventoryDao.productStockLevels().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val movements: StateFlow<List<InventoryMovementEntity>> =
        inventoryDao.recent(200).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val suppliers: StateFlow<List<SupplierEntity>> =
        supplierDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** menuItemId → reorder threshold (device-local); drives the low-stock pill. */
    val reorderByItem: StateFlow<Map<String, Double>> =
        menuDao.allLocalMeta()
            .map { list -> list.mapNotNull { m -> m.reorderPoint?.let { rp -> m.menuItemId to rp } }.toMap() }
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())

    /** Recent movements for one item — powers the per-item history sheet. */
    suspend fun history(id: String, isProduct: Boolean): List<InventoryMovementEntity> =
        if (isProduct) inventoryDao.forProduct(id) else inventoryDao.forMenuItem(id)

    /** Which catalog leads the Levels list (retail → products first). */
    val isRetailMode: StateFlow<Boolean> = settingsDao.byKeyFlow("pos.mode")
        .map { setting ->
            setting?.valueJson?.let { v ->
                runCatching {
                    (kotlinx.serialization.json.Json.parseToJsonElement(v) as? kotlinx.serialization.json.JsonPrimitive)?.content == "retail"
                }.getOrDefault(false)
            } ?: false
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    /** Record a manual movement. qty is entered positive; the type sets the sign
     *  (purchase +, waste/transfer −, adjustment carries its own direction).
     *  Product rows use menuItemId = "" + productId, matching sale movements. */
    fun record(menuItemId: String, productId: String?, type: String, qty: Double, direction: Int, unitCost: Double?, supplierId: String?, reason: String?) {
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
                    productId = productId,
                ),
            )
        }
    }
}

/** One row in the Levels list — either a menu item or a retail product. */
private data class StockRow(val id: String, val name: String, val isProduct: Boolean, val onHand: Double, val reorder: Double? = null)

/** A row is low when at/below its reorder point (or a default floor of 5). */
private fun StockRow.isLow(): Boolean = onHand <= (reorder ?: 5.0)

/** Movement-based stock: on-hand is always the sum of movements, never a
 *  stored counter. Sales deduct automatically at checkout. */
@Composable
fun StockScreen(onBack: () -> Unit, vm: StockViewModel = hiltViewModel()) {
    var tab by remember { mutableStateOf(0) }
    val items by vm.items.collectAsStateWithLifecycle()
    val levels by vm.levels.collectAsStateWithLifecycle()
    val products by vm.products.collectAsStateWithLifecycle()
    val productLevels by vm.productLevels.collectAsStateWithLifecycle()
    val movements by vm.movements.collectAsStateWithLifecycle()
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()
    val isRetail by vm.isRetailMode.collectAsStateWithLifecycle()
    val reorderByItem by vm.reorderByItem.collectAsStateWithLifecycle()

    val levelByItem = remember(levels) { levels.associate { it.menuItemId to it.onHand } }
    val levelByProduct = remember(productLevels) { productLevels.associate { it.productId to it.onHand } }
    val itemNames = remember(items) { items.associate { it.id to it.name } }
    val productNames = remember(products) { products.associate { it.id to it.name } }
    var lowOnly by remember { mutableStateOf(false) }
    // Levels list: both catalogs, active mode's catalog first, empty ones hidden.
    val sections = remember(items, products, levelByItem, levelByProduct, isRetail, reorderByItem, lowOnly) {
        val menuRows = items.map { StockRow(it.id, it.name, isProduct = false, onHand = levelByItem[it.id] ?: 0.0, reorder = reorderByItem[it.id]) }
        val productRows = products.map { StockRow(it.id, it.name, isProduct = true, onHand = levelByProduct[it.id] ?: 0.0) }
        val ordered =
            if (isRetail) listOf("Retail products" to productRows, "Menu items" to menuRows)
            else listOf("Menu items" to menuRows, "Retail products" to productRows)
        ordered.map { (title, rows) -> title to (if (lowOnly) rows.filter { it.isLow() } else rows) }
            .filter { it.second.isNotEmpty() }
    }
    var recordFor by remember { mutableStateOf<StockRow?>(null) }
    var detailFor by remember { mutableStateOf<StockRow?>(null) }

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
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FilterChip(selected = lowOnly, onClick = { lowOnly = !lowOnly }, label = { Text("Low stock only") })
                    Spacer(Modifier.weight(1f))
                    Text("Tap an item for history / adjust", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (sections.isEmpty()) {
                    EmptyState(
                        icon = Icons.Outlined.Inventory2,
                        title = if (lowOnly) "Nothing low" else "No products",
                        subtitle = if (lowOnly) "Everything is above its reorder point." else "Add menu items or sync retail products — stock is tracked per item.",
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 8.dp),
                    ) {
                        sections.forEach { (title, rows) ->
                            if (sections.size > 1) {
                                item(key = "header-$title") {
                                    Text(
                                        title,
                                        style = MaterialTheme.typography.labelLarge,
                                        color = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                                    )
                                }
                            }
                            items(rows, key = { it.id }) { row ->
                                Surface(
                                    onClick = { detailFor = row },
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
                                            row.name,
                                            style = MaterialTheme.typography.titleSmall,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.weight(1f),
                                        )
                                        val accents = LocalPosAccents.current
                                        when {
                                            row.onHand <= 0 -> StatusPill(
                                                fmtQty(row.onHand),
                                                MaterialTheme.colorScheme.onErrorContainer,
                                                MaterialTheme.colorScheme.errorContainer,
                                            )
                                            row.isLow() -> StatusPill(fmtQty(row.onHand), accents.warning, accents.warningContainer)
                                            else -> StatusPill(fmtQty(row.onHand), accents.success, accents.successContainer)
                                        }
                                    }
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
                                        m.productId?.let { productNames[it] } ?: itemNames[m.menuItemId] ?: "Unknown item",
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

    detailFor?.let { row ->
        ItemHistoryDialog(
            row = row,
            loadHistory = { vm.history(row.id, row.isProduct) },
            onRecord = { detailFor = null; recordFor = row },
            onDismiss = { detailFor = null },
        )
    }

    recordFor?.let { row ->
        RecordMovementDialog(
            name = row.name,
            onHand = row.onHand,
            suppliers = suppliers,
            onRecord = { type, qty, direction, cost, supplierId, reason ->
                vm.record(
                    menuItemId = if (row.isProduct) "" else row.id,
                    productId = if (row.isProduct) row.id else null,
                    type = type, qty = qty, direction = direction,
                    unitCost = cost, supplierId = supplierId, reason = reason,
                )
                recordFor = null
            },
            onDismiss = { recordFor = null },
        )
    }
}

private fun fmtQty(q: Double): String = if (q % 1.0 == 0.0) q.toInt().toString() else "%.2f".format(q)

@Composable
private fun ItemHistoryDialog(
    row: StockRow,
    loadHistory: suspend () -> List<InventoryMovementEntity>,
    onRecord: () -> Unit,
    onDismiss: () -> Unit,
) {
    var history by remember { mutableStateOf<List<InventoryMovementEntity>?>(null) }
    LaunchedEffect(row.id) { history = loadHistory() }
    val timeFmt = remember { DateTimeFormatter.ofPattern("d MMM HH:mm").withZone(ZoneId.systemDefault()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = {
            Column {
                Text(row.name, style = MaterialTheme.typography.headlineSmall)
                Text("On hand ${fmtQty(row.onHand)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        text = {
            when (val h = history) {
                null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> if (h.isEmpty()) {
                    Text("No movements yet.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(h, key = { it.id }) { m ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Column(Modifier.weight(1f)) {
                                    Text(m.type.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        "${timeFmt.format(Instant.ofEpochMilli(m.occurredAt))}${m.reason?.let { " · $it" } ?: ""}",
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
        },
        confirmButton = { Button(shape = MaterialTheme.shapes.medium, onClick = onRecord) { Text("Record movement") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun RecordMovementDialog(
    name: String,
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
                Text(name, style = MaterialTheme.typography.headlineSmall)
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
