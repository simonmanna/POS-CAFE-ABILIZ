package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import android.content.Intent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material3.*
import androidx.compose.ui.platform.LocalContext
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
import com.poscafe.pos.data.local.dao.ProductDao
import com.poscafe.pos.data.local.dao.PurchaseDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.dao.StaffDao
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
    private val productDao: ProductDao,
    private val staffDao: StaffDao,
) : ViewModel() {

    data class NameAmount(val name: String, val qty: Double, val amount: Double)

    data class Report(
        val salesCount: Int,
        val gross: Double,
        val tax: Double,
        val avgSale: Double,
        val byMethod: List<NameAmount>,
        val byCashier: List<NameAmount>,
        val topItems: List<NameAmount>,
        val byCategory: List<NameAmount>,
        val cogs: Double,
        val grossProfit: Double,
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

    /** Flatten the current report to CSV for share/export. */
    fun buildCsv(): String {
        val r = report ?: return ""
        val sb = StringBuilder("Section,Label,Amount\n")
        fun row(section: String, label: String, amount: Any) { sb.append(section).append(',').append(csv(label)).append(',').append(amount).append('\n') }
        row("Summary", "Sales", r.salesCount)
        row("Summary", "Gross takings", r.gross)
        row("Summary", "Tax", r.tax)
        row("Summary", "COGS", r.cogs)
        row("Summary", "Gross profit", r.grossProfit)
        row("Summary", "Expenses", r.expenseTotal)
        row("Summary", "Net cash in drawer", r.netCash)
        r.byMethod.forEach { row("Payment", it.name, it.amount) }
        r.byCashier.forEach { row("Cashier", it.name, it.amount) }
        r.topItems.forEach { row("Top item", it.name, it.amount) }
        r.byCategory.forEach { row("Category", it.name, it.amount) }
        r.byExpenseCategory.forEach { row("Expense", it.name, it.amount) }
        return sb.toString()
    }

    private fun csv(s: String): String =
        if (s.any { it == ',' || it == '"' || it == '\n' }) "\"${s.replace("\"", "\"\"")}\"" else s

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

            // COGS from per-line cost: menu item cost is device-local; product
            // cost is the synced costPrice. Cached to avoid repeated lookups.
            val menuCost = mutableMapOf<String, Double>()
            val prodCost = mutableMapOf<String, Double>()
            var cogs = 0.0
            sales.forEach { sale ->
                val lines = runCatching { json.parseToJsonElement(sale.linesJson).jsonArray }.getOrNull() ?: return@forEach
                lines.forEach { el ->
                    val o = el.jsonObject
                    val qty = o["quantity"]?.jsonPrimitive?.doubleOrNull ?: 1.0
                    val menuItemId = o["menuItemId"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
                    val productId = o["productId"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
                    val unitCost = when {
                        productId != null -> prodCost.getOrPut(productId) { productDao.byId(productId)?.costPrice ?: 0.0 }
                        menuItemId != null -> menuCost.getOrPut(menuItemId) { menuDao.localMeta(menuItemId)?.costMajor ?: 0.0 }
                        else -> 0.0
                    }
                    cogs += qty * unitCost
                }
            }

            // Sales by cashier (attribution comes from the sale's actorUserId).
            val cashierTotals = linkedMapOf<String, Double>()
            sales.forEach { s -> cashierTotals[s.actorUserId] = (cashierTotals[s.actorUserId] ?: 0.0) + s.total }
            val byCashier = cashierTotals.entries.map { (uid, amt) ->
                val name = staffDao.byId(uid)?.let { listOfNotNull(it.firstName, it.lastName).joinToString(" ") }?.ifBlank { "Unknown" } ?: "Unknown"
                NameAmount(name, 0.0, amt)
            }.sortedByDescending { it.amount }

            report = Report(
                salesCount = sales.size,
                gross = gross,
                tax = tax,
                avgSale = if (sales.isEmpty()) 0.0 else gross / sales.size,
                byMethod = methodTotals.entries.map { NameAmount(it.key, 0.0, it.value) }.sortedByDescending { it.amount },
                byCashier = byCashier,
                topItems = itemTotals.values.sortedByDescending { it.amount }.take(10),
                byCategory = categoryRows,
                cogs = cogs,
                grossProfit = gross - cogs,
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
        val context = LocalContext.current
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Reports", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.weight(1f))
            IconButton(
                enabled = r != null,
                onClick = {
                    val csv = vm.buildCsv()
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/csv"
                        putExtra(Intent.EXTRA_SUBJECT, "POS report")
                        putExtra(Intent.EXTRA_TEXT, csv)
                    }
                    context.startActivity(Intent.createChooser(intent, "Export report"))
                },
            ) { Icon(Icons.Outlined.IosShare, "Export CSV") }
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

            ReportSection("Sales by cashier") {
                if (r.byCashier.isEmpty()) EmptyLine()
                r.byCashier.forEach { KVRow(it.name, Money.format(it.amount)) }
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

            ReportSection("Profit") {
                KVRow("Cost of goods sold", Money.format(r.cogs))
                KVRow(
                    "Gross profit",
                    Money.format(r.grossProfit),
                    emphasize = true,
                    valueColor = if (r.grossProfit >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
                if (r.gross > 0) KVRow("Margin", "%.1f%%".format(r.grossProfit / r.gross * 100.0))
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
