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
import com.poscafe.pos.data.local.dao.CashInventoryDao
import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.ExpenseDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.ExpenseCategoryEntity
import com.poscafe.pos.data.local.entity.ExpenseEntity
import com.poscafe.pos.data.local.entity.LedgerAccountEntity
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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

/** Used only until the server's expense categories have synced (or on standalone tills). */
private val EXPENSE_CATEGORIES = listOf("Rent", "Utilities", "Salaries", "Supplies", "Transport", "Maintenance", "Marketing", "Other")

@HiltViewModel
class ExpensesViewModel @Inject constructor(
    expenseDao: ExpenseDao,
    supplierDao: SupplierDao,
    cashSessionDao: CashSessionDao,
    private val refs: CashInventoryDao,
    private val expenses: ExpenseRepository,
    private val auth: AuthRepository,
) : ViewModel() {
    val recent: StateFlow<List<ExpenseEntity>> =
        expenseDao.recent(200).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val suppliers: StateFlow<List<SupplierEntity>> =
        supplierDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val categories: StateFlow<List<ExpenseCategoryEntity>> =
        refs.expenseCategories().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val sessionOpen: StateFlow<Boolean> =
        cashSessionDao.openFlow().map { it != null }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    /** Safes, banks and wallets an expense may be paid from (never a register drawer). */
    var payingAccounts by mutableStateOf<List<LedgerAccountEntity>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set

    fun loadAccounts() {
        viewModelScope.launch { payingAccounts = refs.accounts().filter { it.has("expense_payment") } }
    }

    fun record(
        categoryId: String?,
        categoryName: String,
        description: String?,
        amount: Double,
        source: ExpenseRepository.Source,
        accountId: String?,
        supplierId: String?,
        managerPin: String?,
        onDone: () -> Unit,
    ) {
        viewModelScope.launch {
            runCatching {
                val approval = managerPin?.let { pin ->
                    val mgr = auth.verifyPinFor(pin, "cash_session:cash_out", excludeCurrent = true).getOrThrow()
                    com.poscafe.pos.data.repo.CashSessionRepository.Approval(mgr.userId, pin)
                }
                expenses.record(auth.current?.userId, categoryId, categoryName, description, amount, source, accountId, supplierId, approval)
            }
                .onSuccess { error = null; onDone() }
                .onFailure { error = it.message }
        }
    }
}

@Composable
fun ExpensesScreen(onBack: () -> Unit, vm: ExpensesViewModel = hiltViewModel()) {
    val recent by vm.recent.collectAsStateWithLifecycle()
    val suppliers by vm.suppliers.collectAsStateWithLifecycle()
    val categories by vm.categories.collectAsStateWithLifecycle()
    val sessionOpen by vm.sessionOpen.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }
    LaunchedEffect(adding) { if (adding) vm.loadAccounts() }

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
                                if (e.syncStatus == "failed") "rejected" else e.paymentMethod.replace('_', ' '),
                                color = if (e.syncStatus == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
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
            categories = categories,
            accounts = vm.payingAccounts,
            sessionOpen = sessionOpen,
            error = vm.error,
            onSave = { catId, catName, desc, amount, source, accountId, supplierId, pin ->
                vm.record(catId, catName, desc, amount, source, accountId, supplierId, pin) { adding = false }
            },
            onDismiss = { adding = false },
        )
    }
}

@Composable
private fun ExpenseEditorDialog(
    suppliers: List<SupplierEntity>,
    categories: List<ExpenseCategoryEntity>,
    accounts: List<LedgerAccountEntity>,
    sessionOpen: Boolean,
    error: String?,
    onSave: (
        categoryId: String?, categoryName: String, description: String?, amount: Double,
        source: ExpenseRepository.Source, accountId: String?, supplierId: String?, managerPin: String?,
    ) -> Unit,
    onDismiss: () -> Unit,
) {
    // Server categories (id + expense account) once synced; free text before that.
    val options: List<Pair<String?, String>> =
        if (categories.isNotEmpty()) categories.map { it.id to it.name } else EXPENSE_CATEGORIES.map { null to it }
    var category by remember(options) { mutableStateOf(options.first()) }
    var description by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var source by remember {
        mutableStateOf(if (sessionOpen) ExpenseRepository.Source.DRAWER else ExpenseRepository.Source.ACCOUNT)
    }
    var accountId by remember(accounts) { mutableStateOf(accounts.firstOrNull()?.id) }
    var supplierId by remember { mutableStateOf<String?>(null) }
    var pin by remember { mutableStateOf("") }
    val amountValue = amount.toDoubleOrNull()
    val drawer = source == ExpenseRepository.Source.DRAWER
    val ready = amountValue != null && amountValue > 0 &&
        (source != ExpenseRepository.Source.ACCOUNT || accountId != null) &&
        (!drawer || pin.length >= 4)

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
                    options.forEach { c ->
                        SmallChip(c.second, category == c) { category = c }
                    }
                }
                OutlinedTextField(
                    value = amount, onValueChange = { amount = it.filter { ch -> ch.isDigit() || ch == '.' } },
                    label = { Text("Amount (UGX)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Text("Paid from", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (sessionOpen) {
                        SmallChip("Till drawer", source == ExpenseRepository.Source.DRAWER) { source = ExpenseRepository.Source.DRAWER }
                    }
                    SmallChip("Safe / bank", source == ExpenseRepository.Source.ACCOUNT) { source = ExpenseRepository.Source.ACCOUNT }
                    SmallChip("On credit", source == ExpenseRepository.Source.CREDIT) { source = ExpenseRepository.Source.CREDIT }
                }
                when (source) {
                    ExpenseRepository.Source.DRAWER -> {
                        Text(
                            "Taken from the open drawer as a cash-out against this category's expense account.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        com.poscafe.pos.ui.screens.ManagerPinField(pin) { pin = it }
                    }
                    ExpenseRepository.Source.CREDIT -> Text(
                        "Recorded as owed; it is approved and paid in the back office.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    ExpenseRepository.Source.ACCOUNT -> if (accounts.isEmpty()) {
                        Text(
                            "No payment accounts on this device yet — sync first.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    } else {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            accounts.forEach { a ->
                                SmallChip(
                                    a.name + (a.balance?.let { " (${Money.bare(it)})" } ?: ""),
                                    accountId == a.id,
                                ) { accountId = a.id }
                            }
                        }
                    }
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
                enabled = ready,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    onSave(category.first, category.second, description, amountValue ?: 0.0, source, accountId, supplierId, pin.takeIf { drawer })
                },
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
