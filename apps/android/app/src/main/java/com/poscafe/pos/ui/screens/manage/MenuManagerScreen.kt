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
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.entity.MenuCategoryEntity
import com.poscafe.pos.data.local.entity.MenuItemEntity
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

@HiltViewModel
class MenuManagerViewModel @Inject constructor(
    private val menuDao: MenuDao,
    val config: DeviceConfig,
) : ViewModel() {
    val items: StateFlow<List<MenuItemEntity>> =
        menuDao.allItemsIncludingUnavailable().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val categories: StateFlow<List<MenuCategoryEntity>> =
        menuDao.allCategoriesIncludingInactive().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Local authoring only in standalone mode; enrolled devices mirror the server. */
    val editable get() = config.standalone

    fun saveItem(existing: MenuItemEntity?, name: String, priceMajor: Double, categoryId: String?, description: String?, available: Boolean) {
        viewModelScope.launch {
            menuDao.upsertItems(
                listOf(
                    MenuItemEntity(
                        id = existing?.id ?: UUID.randomUUID().toString(),
                        code = existing?.code,
                        name = name.trim(),
                        description = description?.trim()?.takeIf { it.isNotBlank() },
                        categoryId = categoryId,
                        basePriceMajor = priceMajor,
                        taxId = existing?.taxId,
                        image = existing?.image,
                        isAvailable = available,
                        displayOrder = existing?.displayOrder ?: (items.value.maxOfOrNull { it.displayOrder } ?: 0) + 1,
                    ),
                ),
            )
        }
    }

    fun deleteItem(id: String) = viewModelScope.launch { menuDao.deleteItem(id) }

    fun saveCategory(existing: MenuCategoryEntity?, name: String) {
        viewModelScope.launch {
            menuDao.upsertCategories(
                listOf(
                    MenuCategoryEntity(
                        id = existing?.id ?: UUID.randomUUID().toString(),
                        name = name.trim(),
                        sortOrder = existing?.sortOrder ?: (categories.value.maxOfOrNull { it.sortOrder } ?: 0) + 1,
                        isActive = existing?.isActive ?: true,
                    ),
                ),
            )
        }
    }

    fun deleteCategory(id: String) = viewModelScope.launch { menuDao.deleteCategory(id) }
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
    val catNames = remember(categories) { categories.associate { it.id to it.name } }

    ManageScaffold(
        title = "Menu & products",
        onBack = onBack,
        fabLabel = if (!vm.editable) null else if (tab == 0) "New item" else "New category",
        onFab = if (!vm.editable) null else ({ if (tab == 0) showAddItem = true else showAddCategory = true }),
        header = {
            if (!vm.editable) ServerManagedBanner()
            TabRow(
                selectedTabIndex = tab,
                containerColor = MaterialTheme.colorScheme.background,
                contentColor = MaterialTheme.colorScheme.primary,
            ) {
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
                    subtitle = if (vm.editable) "Tap “New item” to build your menu." else "Items sync from the server.",
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
                ) {
                    items(items, key = { it.id }) { item ->
                        Surface(
                            onClick = { if (vm.editable) editItem = item },
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
                                    Text(
                                        catNames[item.categoryId] ?: "Uncategorised",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (!item.isAvailable) {
                                    StatusPill(
                                        "Hidden",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        container = MaterialTheme.colorScheme.surfaceContainerHigh,
                                    )
                                }
                                Text(
                                    Money.format(item.basePriceMajor ?: 0.0),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
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
                        onClick = { if (vm.editable) editCategory = cat },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(cat.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            Text(
                                "${items.count { it.categoryId == cat.id }} items",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
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
            onSave = { name, price, catId, desc, avail ->
                vm.saveItem(editItem, name, price, catId, desc, avail)
                showAddItem = false; editItem = null
            },
            onDelete = editItem?.let { item -> { vm.deleteItem(item.id); editItem = null } },
            onDismiss = { showAddItem = false; editItem = null },
        )
    }

    if (showAddCategory || editCategory != null) {
        CategoryEditorDialog(
            existing = editCategory,
            onSave = { name ->
                vm.saveCategory(editCategory, name)
                showAddCategory = false; editCategory = null
            },
            onDelete = editCategory?.let { cat -> { vm.deleteCategory(cat.id); editCategory = null } },
            onDismiss = { showAddCategory = false; editCategory = null },
        )
    }
}

@Composable
private fun ItemEditorDialog(
    existing: MenuItemEntity?,
    categories: List<MenuCategoryEntity>,
    onSave: (name: String, priceMajor: Double, categoryId: String?, description: String?, available: Boolean) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var price by remember { mutableStateOf(existing?.basePriceMajor?.let { "%.0f".format(it) } ?: "") }
    var categoryId by remember { mutableStateOf(existing?.categoryId) }
    var description by remember { mutableStateOf(existing?.description ?: "") }
    var available by remember { mutableStateOf(existing?.isAvailable ?: true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New item" else "Edit item", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = price, onValueChange = { price = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Price (UGX)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Text("Category", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    CategoryOption("Uncategorised", categoryId == null) { categoryId = null }
                    categories.forEach { cat ->
                        CategoryOption(cat.name, categoryId == cat.id) { categoryId = cat.id }
                    }
                }
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text("Description (optional)") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
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
                onClick = { onSave(name, price.toDoubleOrNull() ?: 0.0, categoryId, description, available) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun CategoryOption(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            1.dp,
            if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(10.dp))
    }
}

@Composable
private fun CategoryEditorDialog(
    existing: MenuCategoryEntity?,
    onSave: (name: String) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New category" else "Edit category", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                onDelete?.let {
                    TextButton(onClick = it) {
                        Text("Delete category", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        },
        confirmButton = {
            Button(enabled = name.isNotBlank(), shape = MaterialTheme.shapes.medium, onClick = { onSave(name) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
