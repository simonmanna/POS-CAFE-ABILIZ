package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.RestaurantMenu
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
import com.poscafe.pos.data.local.entity.*
import com.poscafe.pos.data.repo.CatalogRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

/** Everything an item editor needs beyond the base MenuItem row. */
data class ItemAggregate(
    val variants: List<MenuItemVariantEntity> = emptyList(),
    val modifierGroupIds: List<String> = emptyList(),
    val accompanimentGroupIds: List<String> = emptyList(),
    val costMajor: Double? = null,
    val reorderPoint: Double? = null,
)

@HiltViewModel
class MenuManagerViewModel @Inject constructor(
    private val menuDao: MenuDao,
    private val catalog: CatalogRepository,
) : ViewModel() {
    val items: StateFlow<List<MenuItemEntity>> =
        menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val categories: StateFlow<List<MenuCategoryEntity>> =
        menuDao.allCategoriesIncludingInactive().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val taxes: StateFlow<List<TaxEntity>> =
        menuDao.taxes().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val modifierGroups: StateFlow<List<ModifierGroupEntity>> =
        menuDao.allModifierGroups().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val accompanimentGroups: StateFlow<List<AccompanimentGroupEntity>> =
        menuDao.allAccompanimentGroups().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    suspend fun loadAggregate(id: String): ItemAggregate {
        val meta = menuDao.localMeta(id)
        return ItemAggregate(
            variants = menuDao.variantsAll(id),
            modifierGroupIds = menuDao.assignedModifierGroupIds(id),
            accompanimentGroupIds = menuDao.assignedAccompanimentGroupIds(id),
            costMajor = meta?.costMajor,
            reorderPoint = meta?.reorderPoint,
        )
    }

    fun saveItem(
        existing: MenuItemEntity?,
        name: String,
        priceMajor: Double,
        categoryId: String?,
        description: String?,
        available: Boolean,
        taxId: String?,
        costMajor: Double?,
        reorderPoint: Double?,
        variants: List<MenuItemVariantEntity>,
        modifierGroupIds: List<String>,
        accompanimentGroupIds: List<String>,
    ) {
        viewModelScope.launch {
            catalog.saveMenuItem(
                MenuItemEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    code = existing?.code,
                    name = name.trim(),
                    description = description?.trim()?.takeIf { it.isNotBlank() },
                    categoryId = categoryId,
                    basePriceMajor = priceMajor,
                    taxId = taxId,
                    image = existing?.image,
                    isAvailable = available,
                    displayOrder = existing?.displayOrder ?: (items.value.maxOfOrNull { it.displayOrder } ?: 0) + 1,
                ),
                variants = variants,
                modifierGroupIds = modifierGroupIds,
                accompanimentGroupIds = accompanimentGroupIds,
                costMajor = costMajor,
                reorderPoint = reorderPoint,
            )
        }
    }

    fun deleteItem(id: String) = viewModelScope.launch { catalog.deleteMenuItem(id) }

    fun saveCategory(existing: MenuCategoryEntity?, name: String) {
        viewModelScope.launch {
            catalog.saveCategory(
                MenuCategoryEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    sortOrder = existing?.sortOrder ?: (categories.value.maxOfOrNull { it.sortOrder } ?: 0) + 1,
                    isActive = existing?.isActive ?: true,
                ),
            )
        }
    }

    fun deleteCategory(id: String) = viewModelScope.launch { catalog.deleteCategory(id) }
}

@Composable
fun MenuManagerScreen(onBack: () -> Unit, vm: MenuManagerViewModel = hiltViewModel()) {
    var tab by remember { mutableStateOf(0) }
    var editItem by remember { mutableStateOf<MenuItemEntity?>(null) }
    var showAddItem by remember { mutableStateOf(false) }
    var editCategory by remember { mutableStateOf<MenuCategoryEntity?>(null) }
    var showAddCategory by remember { mutableStateOf(false) }

    val items by vm.items.collectAsStateWithLifecycle()
    val categories by vm.categories.collectAsStateWithLifecycle()
    val taxes by vm.taxes.collectAsStateWithLifecycle()
    val modifierGroups by vm.modifierGroups.collectAsStateWithLifecycle()
    val accompanimentGroups by vm.accompanimentGroups.collectAsStateWithLifecycle()
    val catNames = remember(categories) { categories.associate { it.id to it.name } }

    ManageScaffold(
        title = "Menu",
        onBack = onBack,
        fabLabel = if (tab == 0) "New item" else "New category",
        onFab = { if (tab == 0) showAddItem = true else showAddCategory = true },
        header = {
            TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background, contentColor = MaterialTheme.colorScheme.primary) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Items (${items.size})") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Categories (${categories.size})") })
            }
        },
    ) { _ ->
        if (tab == 0) {
            if (items.isEmpty()) {
                EmptyState(
                    icon = Icons.Outlined.RestaurantMenu,
                    title = "No items yet",
                    subtitle = "Tap “New item” to build your menu.",
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
                ) {
                    items(items, key = { it.id }) { item ->
                        Surface(
                            onClick = { editItem = item },
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
                                Column(Modifier.weight(1f)) {
                                    Text(item.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(catNames[item.categoryId] ?: "Uncategorised", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (!item.isAvailable) StatusPill("Hidden", MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.surfaceContainerHigh)
                                Text(Money.format(item.basePriceMajor ?: 0.0), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(categories, key = { it.id }) { cat ->
                    Surface(
                        onClick = { editCategory = cat },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(cat.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            Text("${items.count { it.categoryId == cat.id }} items", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }

    if (showAddItem || editItem != null) {
        ItemEditorDialog(
            existing = editItem,
            categories = categories,
            taxes = taxes,
            modifierGroups = modifierGroups,
            accompanimentGroups = accompanimentGroups,
            loadAggregate = { vm.loadAggregate(it) },
            onSave = { name, price, catId, desc, avail, taxId, cost, reorder, variants, modIds, accIds ->
                vm.saveItem(editItem, name, price, catId, desc, avail, taxId, cost, reorder, variants, modIds, accIds)
                showAddItem = false; editItem = null
            },
            onDelete = editItem?.let { item -> { vm.deleteItem(item.id); editItem = null } },
            onDismiss = { showAddItem = false; editItem = null },
        )
    }

    if (showAddCategory || editCategory != null) {
        SimpleNameDialog(
            title = if (editCategory == null) "New category" else "Edit category",
            initial = editCategory?.name ?: "",
            onSave = { vm.saveCategory(editCategory, it); showAddCategory = false; editCategory = null },
            onDelete = editCategory?.let { cat -> { vm.deleteCategory(cat.id); editCategory = null } },
            onDismiss = { showAddCategory = false; editCategory = null },
        )
    }
}

/** A variant row being edited (name + MAJOR price), tracked by a stable key. */
private data class VariantDraft(val id: String, val name: String, val price: String)

@Composable
private fun ItemEditorDialog(
    existing: MenuItemEntity?,
    categories: List<MenuCategoryEntity>,
    taxes: List<TaxEntity>,
    modifierGroups: List<ModifierGroupEntity>,
    accompanimentGroups: List<AccompanimentGroupEntity>,
    loadAggregate: suspend (String) -> ItemAggregate,
    onSave: (name: String, priceMajor: Double, categoryId: String?, description: String?, available: Boolean, taxId: String?, costMajor: Double?, reorderPoint: Double?, variants: List<MenuItemVariantEntity>, modifierGroupIds: List<String>, accompanimentGroupIds: List<String>) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var price by remember { mutableStateOf(existing?.basePriceMajor?.let { "%.0f".format(it) } ?: "") }
    var categoryId by remember { mutableStateOf(existing?.categoryId) }
    var taxId by remember { mutableStateOf(existing?.taxId) }
    var description by remember { mutableStateOf(existing?.description ?: "") }
    var available by remember { mutableStateOf(existing?.isAvailable ?: true) }
    var cost by remember { mutableStateOf("") }
    var reorder by remember { mutableStateOf("") }
    val variants = remember { mutableStateListOf<VariantDraft>() }
    val modIds = remember { mutableStateListOf<String>() }
    val accIds = remember { mutableStateListOf<String>() }

    // Hydrate the aggregate for an existing item once.
    LaunchedEffect(existing?.id) {
        val id = existing?.id ?: return@LaunchedEffect
        val agg = loadAggregate(id)
        cost = agg.costMajor?.let { "%.0f".format(it) } ?: ""
        reorder = agg.reorderPoint?.let { "%.0f".format(it) } ?: ""
        variants.clear(); variants.addAll(agg.variants.map { VariantDraft(it.id, it.name, "%.0f".format(it.price)) })
        modIds.clear(); modIds.addAll(agg.modifierGroupIds)
        accIds.clear(); accIds.addAll(agg.accompanimentGroupIds)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New item" else "Edit item", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = price, onValueChange = { price = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Price") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = cost, onValueChange = { cost = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Cost") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                }

                Text("Category", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    PickerRow("Uncategorised", categoryId == null) { categoryId = null }
                    categories.forEach { cat -> PickerRow(cat.name, categoryId == cat.id) { categoryId = cat.id } }
                }

                if (taxes.isNotEmpty()) {
                    Text("Tax", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        PickerRow("No tax", taxId == null) { taxId = null }
                        taxes.forEach { t -> PickerRow("${t.name} (${if (t.rate % 1.0 == 0.0) t.rate.toInt() else t.rate}%)", taxId == t.id) { taxId = t.id } }
                    }
                }

                // Variants
                SectionLabel("Variants (optional)")
                variants.forEachIndexed { i, v ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(value = v.name, onValueChange = { variants[i] = v.copy(name = it) }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1.4f))
                        OutlinedTextField(value = v.price, onValueChange = { variants[i] = v.copy(price = it.filter { c -> c.isDigit() || c == '.' }) }, label = { Text("Price") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                        IconButton(onClick = { variants.removeAt(i) }) { Icon(Icons.Outlined.Close, "Remove", tint = MaterialTheme.colorScheme.error) }
                    }
                }
                TextButton(onClick = { variants.add(VariantDraft(UUID.randomUUID().toString(), "", "")) }) { Text("+ Add variant") }

                // Modifier groups
                if (modifierGroups.isNotEmpty()) {
                    SectionLabel("Add-ons / modifiers")
                    modifierGroups.forEach { g -> ToggleRow(g.name, g.id in modIds) { if (g.id in modIds) modIds.remove(g.id) else modIds.add(g.id) } }
                }
                // Accompaniment groups
                if (accompanimentGroups.isNotEmpty()) {
                    SectionLabel("Accompaniments")
                    accompanimentGroups.forEach { g -> ToggleRow(g.name, g.id in accIds) { if (g.id in accIds) accIds.remove(g.id) else accIds.add(g.id) } }
                }

                OutlinedTextField(value = reorder, onValueChange = { reorder = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Low-stock alert at (optional)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = description, onValueChange = { description = it }, label = { Text("Description (optional)") }, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Available on the menu", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = available, onCheckedChange = { available = it })
                }
                onDelete?.let {
                    TextButton(onClick = it) {
                        Icon(Icons.Outlined.DeleteOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Delete item", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank() && price.toDoubleOrNull() != null,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    val vs = variants.mapIndexedNotNull { i, d ->
                        val p = d.price.toDoubleOrNull() ?: return@mapIndexedNotNull null
                        if (d.name.isBlank()) return@mapIndexedNotNull null
                        MenuItemVariantEntity(id = d.id, menuItemId = existing?.id ?: "", name = d.name.trim(), price = p, sortOrder = i, isActive = true)
                    }
                    onSave(name, price.toDoubleOrNull() ?: 0.0, categoryId, description, available, taxId, cost.toDoubleOrNull(), reorder.toDoubleOrNull(), vs, modIds.toList(), accIds.toList())
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Checkbox(checked = checked, onCheckedChange = { onToggle() })
    }
}
