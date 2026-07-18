package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.ExpenseDao
import com.poscafe.pos.data.local.dao.InventoryDao
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.PurchaseDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.PosCard
import com.poscafe.pos.ui.components.StatCard
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject

@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val saleDao: SaleDao,
    private val cashDao: CashSessionDao,
    private val inventoryDao: InventoryDao,
    private val menuDao: MenuDao,
    private val expenseDao: ExpenseDao,
    private val purchaseDao: PurchaseDao,
) : ViewModel() {

    data class NameAmount(val name: String, val qty: Double, val amount: Double)

    data class Report(
        val salesCount: Int,
        val gross: Double,
        val tax: Double,
        val avgSale: Double,
        val byMethod: List<NameAmount>,
        val topItems: List<NameAmount>,
        val byCategory: List<NameAmount>,
        val expenseTotal: Double,
        val byExpenseCategory: List<NameAmount>,
        val purchaseTotal: Double,
        val purchaseCount: Int,
        val netCash: Double,
        val stockIn: Double,
        val stockOut: Double,
        val wasteCount: Int,
    )

    var rangeDays by mutableStateOf(1); private set
    var report by mutableStateOf<Report?>(null); private set

    private val json = Json { ignoreUnknownKeys = true }

    init { load(1) }

    /** rangeDays = 1 → since local midnight; otherwise N calendar days back. */
    fun load(days: Int) {
        rangeDays = days
        viewModelScope.launch {
            val zone = ZoneId.systemDefault()
            val since = LocalDate.now(zone)
                .minusDays((days - 1).toLong())
                .atStartOfDay(zone).toInstant().toEpochMilli()

            val sales = saleDao.since(since)
            val movements = inventoryDao.since(since)
            val cashMovements = cashDao.movementsSince(since)
            val expenseRows = expenseDao.since(since)
            val purchaseRows = purchaseDao.since(since)

            val gross = sales.sumOf { it.total }
            val tax = sales.sumOf { it.taxAmount }

            // Payment split — cash tenders are reduced by the change given back.
            val methodTotals = linkedMapOf<String, Double>()
            sales.forEach { sale ->
                val tenders = runCatching { json.parseToJsonElement(sale.tendersJson).jsonArray }.getOrNull() ?: return@forEach
                var saleTendered = 0.0
                val parsed = tenders.map { el ->
                    val o = el.jsonObject
                    val method = o["method"]?.jsonPrimitive?.content ?: "cash"
                    val amount = o["amount"]?.jsonPrimitive?.doubleOrNull ?: 0.0
                    saleTendered += amount
                    method to amount
                }
                val change = (saleTendered - sale.total).coerceAtLeast(0.0)
                parsed.forEach { (method, amount) ->
                    val net = if (method == "cash") (amount - change).coerceAtLeast(0.0) else amount
                    methodTotals[method] = (methodTotals[method] ?: 0.0) + net
                }
            }

            // Product + category ranking from stored line payloads.
            val itemTotals = mutableMapOf<String, NameAmount>()
            val categoryTotals = mutableMapOf<String, Double>()
            sales.forEach { sale ->
                val lines = runCatching { json.parseToJsonElement(sale.linesJson).jsonArray }.getOrNull() ?: return@forEach
                lines.forEach { el ->
                    val o = el.jsonObject
                    val name = o["description"]?.jsonPrimitive?.content ?: "Item"
                    val qty = o["quantity"]?.jsonPrimitive?.doubleOrNull ?: 1.0
                    val unit = o["unitPrice"]?.jsonPrimitive?.doubleOrNull ?: 0.0
                    val amount = qty * unit
                    val prev = itemTotals[name]
                    itemTotals[name] = NameAmount(name, (prev?.qty ?: 0.0) + qty, (prev?.amount ?: 0.0) + amount)

                    val menuItemId = o["menuItemId"]?.jsonPrimitive?.content
                    val categoryId = menuItemId?.let { id -> menuDao.itemById(id)?.categoryId }
                    val key = categoryId ?: "__other"
                    categoryTotals[key] = (categoryTotals[key] ?: 0.0) + amount
                }
            }
            val categoryRows = categoryTotals.entries
                .map { (id, amount) ->
                    val label = if (id == "__other") "Other" else menuDao.categoryName(id) ?: "Other"
                    NameAmount(label, 0.0, amount)
                }
                .groupBy { it.name }
                .map { (name, rows) -> NameAmount(name, 0.0, rows.sumOf { it.amount }) }
                .sortedByDescending { it.amount }

            // Expense ledger by category (the report's source of truth for spend).
            val expenseByCategory = expenseRows
                .groupBy { it.category }
                .map { (cat, rows) -> NameAmount(cat, 0.0, rows.sumOf { it.amount }) }
                .sortedByDescending { it.amount }
            val expenseTotal = expenseRows.sumOf { it.amount }

            // Net cash in the drawer view: cash sales (net of change) + pay-ins − pay-outs.
            val cashSalesNet = methodTotals["cash"] ?: 0.0
            val cashIn = cashMovements.filter { it.movementType == "pay_in" }.sumOf { it.amount }
            val cashOut = cashMovements.filter { it.movementType == "pay_out" }.sumOf { it.amount }

            report = Report(
                salesCount = sales.size,
                gross = gross,
                tax = tax,
                avgSale = if (sales.isEmpty()) 0.0 else gross / sales.size,
                byMethod = methodTotals.entries.map { NameAmount(it.key, 0.0, it.value) }.sortedByDescending { it.amount },
                topItems = itemTotals.values.sortedByDescending { it.amount }.take(10),
                byCategory = categoryRows,
                expenseTotal = expenseTotal,
                byExpenseCategory = expenseByCategory,
                purchaseTotal = purchaseRows.sumOf { it.totalCost },
                purchaseCount = purchaseRows.size,
                netCash = cashSalesNet + cashIn - cashOut,
                stockIn = movements.filter { it.qtyDelta > 0 }.sumOf { it.qtyDelta },
                stockOut = movements.filter { it.qtyDelta < 0 }.sumOf { -it.qtyDelta },
                wasteCount = movements.count { it.type == "waste" },
            )
        }
    }
}

/** All-local reports — straight from Room, no server, no internet. */
@Composable
fun ReportsScreen(onBack: () -> Unit, vm: ReportsViewModel = hiltViewModel()) {
    val r = vm.report

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Reports", style = MaterialTheme.typography.headlineSmall)
        }
        Row(
            Modifier.padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RangeChip("Today", vm.rangeDays == 1) { vm.load(1) }
            RangeChip("7 days", vm.rangeDays == 7) { vm.load(7) }
            RangeChip("30 days", vm.rangeDays == 30) { vm.load(30) }
        }
        Spacer(Modifier.height(12.dp))

        if (r == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatCard("${r.salesCount}", "Sales", Modifier.weight(1f))
                StatCard(Money.bare(r.gross), "Gross takings", Modifier.weight(1.3f), accent = MaterialTheme.colorScheme.primary)
                StatCard(Money.bare(r.avgSale), "Avg sale", Modifier.weight(1f))
            }

            ReportSection("Payment summary") {
                if (r.byMethod.isEmpty()) EmptyLine()
                r.byMethod.forEach {
                    KVRow(it.name.replace('_', ' ').replaceFirstChar { c -> c.uppercase() }, Money.format(it.amount))
                }
                if (r.tax > 0) KVRow("Tax collected", Money.format(r.tax))
            }

            ReportSection("Top selling items") {
                if (r.topItems.isEmpty()) EmptyLine()
                r.topItems.forEachIndexed { i, item ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            "${i + 1}. ${item.name}",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "×${if (item.qty % 1.0 == 0.0) item.qty.toInt() else item.qty}   ${Money.bare(item.amount)}",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }

            ReportSection("Sales by category") {
                if (r.byCategory.isEmpty()) EmptyLine()
                r.byCategory.forEach { KVRow(it.name, Money.format(it.amount)) }
            }

            ReportSection("Expenses") {
                if (r.byExpenseCategory.isEmpty()) EmptyLine()
                r.byExpenseCategory.forEach {
                    KVRow(it.name, Money.format(it.amount), valueColor = MaterialTheme.colorScheme.error)
                }
                if (r.byExpenseCategory.isNotEmpty()) {
                    KVRow("Total expenses", Money.format(r.expenseTotal), emphasize = true, valueColor = MaterialTheme.colorScheme.error)
                }
            }

            ReportSection("Purchases & cash") {
                KVRow("Purchases (${r.purchaseCount})", Money.format(r.purchaseTotal))
                KVRow(
                    "Net cash in drawer",
                    Money.format(r.netCash),
                    emphasize = true,
                    valueColor = MaterialTheme.colorScheme.primary,
                )
            }

            ReportSection("Inventory movement") {
                KVRow("Stock received (units)", "%,.0f".format(r.stockIn))
                KVRow("Stock issued (units)", "%,.0f".format(r.stockOut))
                KVRow("Waste entries", "${r.wasteCount}")
            }
        }
    }
}

@Composable
private fun RangeChip(label: String, selected: Boolean, onClick: () -> Unit) {
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
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun ReportSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    PosCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun EmptyLine() {
    Text(
        "No data in this range.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
