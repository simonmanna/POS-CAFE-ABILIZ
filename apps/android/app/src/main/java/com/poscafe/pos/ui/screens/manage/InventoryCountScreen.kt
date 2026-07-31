package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
import com.poscafe.pos.data.local.entity.InventoryMovementEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.theme.LocalPosAccents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

data class CountRow(val id: String, val name: String, val isProduct: Boolean, val onHand: Double)
data class CountEntry(val id: String, val isProduct: Boolean, val onHand: Double, val counted: Double)

@HiltViewModel
class InventoryCountViewModel @Inject constructor(
    menuDao: MenuDao,
    productDao: ProductDao,
    private val inventoryDao: InventoryDao,
    private val auth: AuthRepository,
) : ViewModel() {
    val items = menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val products = productDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val levels = inventoryDao.stockLevels().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val productLevels = inventoryDao.productStockLevels().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var posted by mutableStateOf(0); private set

    /** Post one reconciling `adjustment` movement per changed row (never overwrites). */
    fun postCount(entries: List<CountEntry>) {
        viewModelScope.launch {
            val actor = auth.current?.userId
            val now = System.currentTimeMillis()
            var n = 0
            entries.forEach { e ->
                val delta = e.counted - e.onHand
                if (delta == 0.0) return@forEach
                inventoryDao.insert(
                    InventoryMovementEntity(
                        id = UUID.randomUUID().toString(),
                        menuItemId = if (e.isProduct) "" else e.id,
                        productId = if (e.isProduct) e.id else null,
                        type = "adjustment",
                        qtyDelta = delta,
                        unitCost = null,
                        supplierId = null,
                        reason = "Physical count",
                        saleLocalId = null,
                        actorUserId = actor,
                        occurredAt = now,
                    ),
                )
                n++
            }
            posted = n
        }
    }

    fun clearPosted() { posted = 0 }
}

@Composable
fun InventoryCountScreen(onBack: () -> Unit, vm: InventoryCountViewModel = hiltViewModel()) {
    val items by vm.items.collectAsStateWithLifecycle()
    val products by vm.products.collectAsStateWithLifecycle()
    val levels by vm.levels.collectAsStateWithLifecycle()
    val productLevels by vm.productLevels.collectAsStateWithLifecycle()

    val levelByItem = remember(levels) { levels.associate { it.menuItemId to it.onHand } }
    val levelByProduct = remember(productLevels) { productLevels.associate { it.productId to it.onHand } }
    val rows = remember(items, products, levelByItem, levelByProduct) {
        items.map { CountRow(it.id, it.name, false, levelByItem[it.id] ?: 0.0) } +
            products.map { CountRow(it.id, it.name, true, levelByProduct[it.id] ?: 0.0) }
    }
    // rowId → typed count
    val counts = remember { mutableStateMapOf<String, String>() }
    val enteredCount = counts.count { it.value.toDoubleOrNull() != null }

    if (vm.posted > 0) {
        AlertDialog(
            onDismissRequest = { vm.clearPosted(); counts.clear() },
            title = { Text("Count posted") },
            text = { Text("${vm.posted} adjustment(s) recorded to reconcile stock.") },
            confirmButton = { Button(onClick = { vm.clearPosted(); counts.clear() }) { Text("Done") } },
        )
    }

    ManageScaffold(
        title = "Physical count",
        onBack = onBack,
        fabLabel = if (enteredCount > 0) "Post ($enteredCount)" else null,
        onFab = if (enteredCount > 0) ({
            vm.postCount(
                rows.mapNotNull { r ->
                    val c = counts[rowKey(r)]?.toDoubleOrNull() ?: return@mapNotNull null
                    CountEntry(r.id, r.isProduct, r.onHand, c)
                },
            )
        }) else null,
    ) { _ ->
        if (rows.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.Inventory2,
                title = "Nothing to count",
                subtitle = "Add menu items or products first.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(6.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp, top = 4.dp),
            ) {
                item("hint") {
                    Text(
                        "Enter the counted quantity for items you've physically checked. Blank rows are left untouched.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
                items(rows, key = { rowKey(it) }) { r ->
                    val accents = LocalPosAccents.current
                    val typed = counts[rowKey(r)]?.toDoubleOrNull()
                    val variance = typed?.let { it - r.onHand }
                    Surface(
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(r.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    "On hand ${fmtQ(r.onHand)}" + (variance?.let { v -> if (v != 0.0) "  →  ${if (v > 0) "+" else ""}${fmtQ(v)}" else "  ✓" } ?: ""),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = when {
                                        variance == null -> MaterialTheme.colorScheme.onSurfaceVariant
                                        variance == 0.0 -> accents.success
                                        else -> MaterialTheme.colorScheme.error
                                    },
                                )
                            }
                            OutlinedTextField(
                                value = counts[rowKey(r)] ?: "",
                                onValueChange = { counts[rowKey(r)] = it.filter { c -> c.isDigit() || c == '.' } },
                                label = { Text("Count") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                shape = MaterialTheme.shapes.medium,
                                modifier = Modifier.width(110.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun rowKey(r: CountRow): String = (if (r.isProduct) "p:" else "m:") + r.id
private fun fmtQ(q: Double): String = if (q % 1.0 == 0.0) q.toInt().toString() else "%.2f".format(q)
