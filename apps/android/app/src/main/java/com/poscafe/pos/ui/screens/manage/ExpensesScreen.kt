package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.ReceiptLong
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
import com.poscafe.pos.data.local.dao.ExpenseDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.ExpenseEntity
import com.poscafe.pos.data.local.entity.SupplierEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.ExpenseRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.StatCard
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

private val EXPENSE_CATEGORIES = listOf("Rent", "Utilities", "Salaries", "Supplies", "Transport", "Maintenance", "Marketing", "Other")

@HiltViewModel
class ExpensesViewModel @Inject constructor(
    expenseDao: ExpenseDao,
    supplierDao: SupplierDao,
    private val expenses: ExpenseRepository,
    private val auth: AuthRepository,
) : ViewModel() {
    val recent: StateFlow<List<ExpenseEntity>> =
        expenseDao.recent(200).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val suppliers: StateFlow<List<SupplierEntity>> =
        supplierDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var error by mutableStateOf<String?>(null); private set

    fun record(category: String, description: String?, amount: Double, method: String, supplierId: String?, onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { expenses.record(auth.current?.userId, category, description, amount, method, supplierId) }
                .onSuccess { error = null; onDone() }
                .onFailure { error = it.message }
        }
    }
}

@Composable
fun ExpensesScreen(onBack: () -> Unit, vm: ExpensesViewModel = hiltViewModel()) {
    val recent by vm.recent.collectAsStateWithLifecycle()
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }

    // Today's total for the header.
    val zone = ZoneId.systemDefault()
    val startOfDay = remember { java.time.LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli() }
    val todayTotal = recent.filter { it.occurredAt >= startOfDay }.sumOf { it.amount }
    val monthTotal = recent.sumOf { it.amount }

    ManageScaffold(
        title = "Expenses",
        onBack = onBack,
        fabLabel = "New expense",
        onFab = { adding = true },
        header = {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatCard(Money.bare(todayTotal), "Today", Modifier.weight(1f), accent = MaterialTheme.colorScheme.error)
                StatCard(Money.bare(monthTotal), "Recent total", Modifier.weight(1f))
            }
        },
    ) { _ ->
        if (recent.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.ReceiptLong,
                title = "No expenses yet",
                subtitle = "Track rent, supplies, salaries and more — cash expenses hit the drawer too.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            val timeFmt = remember { DateTimeFormatter.ofPattern("d MMM HH:mm").withZone(ZoneId.systemDefault()) }
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(recent, key = { it.id }) { e ->
                    Surface(
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
                                Text(e.category, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    "${timeFmt.format(Instant.ofEpochMilli(e.occurredAt))}${e.description?.let { " · $it" } ?: ""}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            StatusPill(
                                e.paymentMethod.replace('_', ' '),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                container = MaterialTheme.colorScheme.surfaceContainerHigh,
                            )
                            Text(
                                Money.format(e.amount),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        ExpenseEditorDialog(
            suppliers = suppliers,
            error = vm.error,
            onSave = { cat, desc, amount, method, supplierId ->
                vm.record(cat, desc, amount, method, supplierId) { adding = false }
            },
            onDismiss = { adding = false },
        )
    }
}

@Composable
private fun ExpenseEditorDialog(
    suppliers: List<SupplierEntity>,
    error: String?,
    onSave: (category: String, description: String?, amount: Double, method: String, supplierId: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var category by remember { mutableStateOf(EXPENSE_CATEGORIES.first()) }
    var description by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("cash") }
    var supplierId by remember { mutableStateOf<String?>(null) }
    val amountValue = amount.toDoubleOrNull()

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        icon = { Icon(Icons.Outlined.Payments, null) },
        title = { Text("New expense", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("Category", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    EXPENSE_CATEGORIES.forEach { c ->
                        SmallChip(c, category == c) { category = c }
                    }
                }
                OutlinedTextField(
                    value = amount, onValueChange = { amount = it.filter { ch -> ch.isDigit() || ch == '.' } },
                    label = { Text("Amount (UGX)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Text("Paid with", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SmallChip("Cash", method == "cash") { method = "cash" }
                    SmallChip("Bank", method == "bank") { method = "bank" }
                    SmallChip("Mobile", method == "mobile_money") { method = "mobile_money" }
                }
                if (method == "cash") {
                    Text(
                        "Cash expenses are recorded against the open drawer session.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedTextField(
                    value = description, onValueChange = { description = it },
                    label = { Text("Description (optional)") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                if (suppliers.isNotEmpty()) {
                    Text("Supplier / payee (optional)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        suppliers.forEach { s ->
                            SmallChip(s.name, supplierId == s.id) { supplierId = if (supplierId == s.id) null else s.id }
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = amountValue != null && amountValue > 0,
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(category, description, amountValue ?: 0.0, method, supplierId) },
            ) { Text("Record expense") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SmallChip(label: String, selected: Boolean, onClick: () -> Unit) {
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
