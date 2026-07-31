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
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.ProductCategoryDao
import com.poscafe.pos.data.local.dao.ProductDao
import com.poscafe.pos.data.local.entity.ProductCategoryEntity
import com.poscafe.pos.data.local.entity.ProductEntity
import com.poscafe.pos.data.local.entity.TaxEntity
import com.poscafe.pos.data.repo.ProductRepository
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
class ProductsViewModel @Inject constructor(
    productDao: ProductDao,
    categoryDao: ProductCategoryDao,
    menuDao: MenuDao,
    private val products: ProductRepository,
) : ViewModel() {
    val items: StateFlow<List<ProductEntity>> =
        productDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val categories: StateFlow<List<ProductCategoryEntity>> =
        categoryDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val taxes: StateFlow<List<TaxEntity>> =
        menuDao.taxes().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(
        existing: ProductEntity?,
        name: String,
        sku: String?,
        barcode: String?,
        salesPrice: Double,
        costPrice: Double,
        category: ProductCategoryEntity?,
        tax: TaxEntity?,
        active: Boolean,
    ) {
        viewModelScope.launch {
            products.saveProduct(
                ProductEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    code = existing?.code,
                    sku = sku?.trim()?.takeIf { it.isNotBlank() },
                    barcode = barcode?.trim()?.takeIf { it.isNotBlank() },
                    name = name.trim(),
                    description = existing?.description,
                    image = existing?.image,
                    salesPrice = salesPrice,
                    costPrice = costPrice,
                    categoryId = category?.id,
                    categoryName = category?.name,
                    uomName = existing?.uomName,
                    taxId = tax?.id,
                    taxRate = tax?.rate ?: 0.0,
                    taxInclusive = existing?.taxInclusive ?: false,
                    isActive = active,
                    isService = existing?.isService ?: false,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { products.deleteProduct(id) }

    fun saveCategory(existing: ProductCategoryEntity?, name: String) {
        viewModelScope.launch {
            products.saveCategory(
                ProductCategoryEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    parentId = existing?.parentId,
                ),
            )
        }
    }

    fun deleteCategory(id: String) = viewModelScope.launch { products.deleteCategory(id) }
}

@Composable
fun ProductsScreen(onBack: () -> Unit, vm: ProductsViewModel = hiltViewModel()) {
    var tab by remember { mutableStateOf(0) }
    val items by vm.items.collectAsStateWithLifecycle()
    val categories by vm.categories.collectAsStateWithLifecycle()
    val taxes by vm.taxes.collectAsStateWithLifecycle()
    val catNames = remember(categories) { categories.associate { it.id to it.name } }

    var editItem by remember { mutableStateOf<ProductEntity?>(null) }
    var showAddItem by remember { mutableStateOf(false) }
    var editCat by remember { mutableStateOf<ProductCategoryEntity?>(null) }
    var showAddCat by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Retail products",
        onBack = onBack,
        fabLabel = if (tab == 0) "New product" else "New category",
        onFab = { if (tab == 0) showAddItem = true else showAddCat = true },
        header = {
            TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background, contentColor = MaterialTheme.colorScheme.primary) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Products (${items.size})") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Categories (${categories.size})") })
            }
        },
    ) { _ ->
        if (tab == 0) {
            if (items.isEmpty()) {
                EmptyState(
                    icon = Icons.Outlined.Inventory2,
                    title = "No products yet",
                    subtitle = "Tap “New product” to stock your shop.",
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
                ) {
                    items(items, key = { it.id }) { p ->
                        Surface(
                            onClick = { editItem = p },
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
                                    Text(p.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        listOfNotNull(p.categoryName ?: catNames[p.categoryId], p.sku?.let { "SKU $it" }).joinToString(" · ").ifBlank { "Uncategorised" },
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Text(Money.format(p.salesPrice), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
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
                items(categories, key = { it.id }) { c ->
                    Surface(
                        onClick = { editCat = c },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            Text("${items.count { it.categoryId == c.id }}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }

    if (showAddItem || editItem != null) {
        ProductEditorDialog(
            existing = editItem,
            categories = categories,
            taxes = taxes,
            onSave = { name, sku, barcode, sp, cp, cat, tax, active ->
                vm.save(editItem, name, sku, barcode, sp, cp, cat, tax, active); showAddItem = false; editItem = null
            },
            onDelete = editItem?.let { p -> { vm.delete(p.id); editItem = null } },
            onDismiss = { showAddItem = false; editItem = null },
        )
    }
    if (showAddCat || editCat != null) {
        SimpleNameDialog(
            title = if (editCat == null) "New category" else "Edit category",
            initial = editCat?.name ?: "",
            onSave = { vm.saveCategory(editCat, it); showAddCat = false; editCat = null },
            onDelete = editCat?.let { c -> { vm.deleteCategory(c.id); editCat = null } },
            onDismiss = { showAddCat = false; editCat = null },
        )
    }
}

@Composable
private fun ProductEditorDialog(
    existing: ProductEntity?,
    categories: List<ProductCategoryEntity>,
    taxes: List<TaxEntity>,
    onSave: (name: String, sku: String?, barcode: String?, salesPrice: Double, costPrice: Double, category: ProductCategoryEntity?, tax: TaxEntity?, active: Boolean) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var sku by remember { mutableStateOf(existing?.sku ?: "") }
    var barcode by remember { mutableStateOf(existing?.barcode ?: "") }
    var salesPrice by remember { mutableStateOf(existing?.salesPrice?.let { "%.0f".format(it) } ?: "") }
    var costPrice by remember { mutableStateOf(existing?.costPrice?.let { "%.0f".format(it) } ?: "") }
    var categoryId by remember { mutableStateOf(existing?.categoryId) }
    var taxId by remember { mutableStateOf(existing?.taxId) }
    var active by remember { mutableStateOf(existing?.isActive ?: true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New product" else "Edit product", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = salesPrice, onValueChange = { salesPrice = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Price") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = costPrice, onValueChange = { costPrice = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Cost") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = sku, onValueChange = { sku = it }, label = { Text("SKU") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = barcode, onValueChange = { barcode = it }, label = { Text("Barcode") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                }
                if (categories.isNotEmpty()) {
                    Text("Category", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        PickerRow("Uncategorised", categoryId == null) { categoryId = null }
                        categories.forEach { c -> PickerRow(c.name, categoryId == c.id) { categoryId = c.id } }
                    }
                }
                if (taxes.isNotEmpty()) {
                    Text("Tax", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        PickerRow("No tax", taxId == null) { taxId = null }
                        taxes.forEach { t -> PickerRow("${t.name} (${if (t.rate % 1.0 == 0.0) t.rate.toInt() else t.rate}%)", taxId == t.id) { taxId = t.id } }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Active", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = active, onCheckedChange = { active = it })
                }
                onDelete?.let { TextButton(onClick = it) { Text("Delete product", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank() && salesPrice.toDoubleOrNull() != null,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    onSave(
                        name, sku, barcode,
                        salesPrice.toDoubleOrNull() ?: 0.0, costPrice.toDoubleOrNull() ?: 0.0,
                        categories.find { it.id == categoryId }, taxes.find { it.id == taxId }, active,
                    )
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Shared single-field name dialog (categories, simple records). */
@Composable
fun SimpleNameDialog(
    title: String,
    initial: String,
    label: String = "Name",
    onSave: (String) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(title, style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(label) }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                onDelete?.let { TextButton(onClick = it) { Text("Delete", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = { Button(enabled = name.isNotBlank(), shape = MaterialTheme.shapes.medium, onClick = { onSave(name) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun PickerRow(label: String, selected: Boolean, onClick: () -> Unit) {
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
