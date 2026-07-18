package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.Print
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.entity.LocalSaleEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.CartEngine
import com.poscafe.pos.data.repo.SaleRepository
import com.poscafe.pos.printing.ReceiptPrinter
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.Money
import com.poscafe.pos.ui.components.StatusPill
import com.poscafe.pos.ui.theme.LocalPosAccents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class OrdersViewModel @Inject constructor(
    saleDao: SaleDao,
    private val menuDao: MenuDao,
    private val printer: ReceiptPrinter,
    private val auth: AuthRepository,
    val config: DeviceConfig,
) : ViewModel() {
    val sales: StateFlow<List<LocalSaleEntity>> =
        saleDao.recent(100).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    data class ParsedTender(val method: String, val amount: Double)
    data class ParsedSale(val lines: List<CartEngine.CartLine>, val tenders: List<ParsedTender>)

    var detail by mutableStateOf<Pair<LocalSaleEntity, ParsedSale>?>(null); private set
    var printMessage by mutableStateOf<String?>(null); private set

    private val json = Json { ignoreUnknownKeys = true }

    fun openDetail(sale: LocalSaleEntity) {
        viewModelScope.launch { detail = sale to parse(sale) }
    }

    fun closeDetail() { detail = null; printMessage = null }

    /** Rebuild cart lines from the stored checkout payload. Accompaniment
     *  names/prices are re-resolved from the catalog (ids only in the payload). */
    private suspend fun parse(sale: LocalSaleEntity): ParsedSale {
        val lines = json.parseToJsonElement(sale.linesJson).jsonArray.map { el ->
            val o = el.jsonObject
            val accIds = o["accompanimentOptionIds"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
            val accs = if (accIds.isEmpty()) emptyList() else menuDao.accompanimentOptionsByIds(accIds)
                .map { CartEngine.AccompanimentSel(it.id, it.name, it.priceImpact) }
            CartEngine.CartLine(
                lineId = UUID.randomUUID().toString(),
                menuItemId = o["menuItemId"]?.jsonPrimitive?.content,
                name = o["description"]?.jsonPrimitive?.content ?: "Item",
                quantity = o["quantity"]?.jsonPrimitive?.doubleOrNull ?: 1.0,
                baseUnitPrice = o["unitPrice"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                discountPercent = o["discountPercent"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                modifiers = o["modifiers"]?.jsonArray?.map { m ->
                    val mo = m.jsonObject
                    CartEngine.ModifierSel(
                        modifierId = mo["modifierId"]?.jsonPrimitive?.content ?: "",
                        name = mo["name"]?.jsonPrimitive?.content ?: "",
                        priceDelta = mo["priceDelta"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                    )
                } ?: emptyList(),
                accompaniments = accs,
                note = o["note"]?.jsonPrimitive?.content,
            )
        }
        val tenders = json.parseToJsonElement(sale.tendersJson).jsonArray.map { el ->
            val o = el.jsonObject
            ParsedTender(
                method = o["method"]?.jsonPrimitive?.content ?: "cash",
                amount = o["amount"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
            )
        }
        return ParsedSale(lines, tenders)
    }

    fun reprint() {
        val (sale, parsed) = detail ?: return
        val host = config.printerHost ?: run { printMessage = "No printer configured (More → Receipt printer)"; return }
        viewModelScope.launch {
            printMessage = null
            val completed = SaleRepository.CompletedSale(
                localId = sale.id,
                provisionalNumber = sale.provisionalNumber,
                totals = CartEngine.totals(parsed.lines),
                occurredAt = Instant.ofEpochMilli(sale.occurredAt),
            )
            runCatching {
                printer.printReceipt(
                    host = host,
                    header = config.receiptHeader(),
                    sale = completed,
                    lines = parsed.lines,
                    tenders = parsed.tenders.map { SaleRepository.Tender(it.method, it.amount) },
                    cashierName = auth.current?.displayName ?: "",
                    offline = sale.finalInvoiceNumber == null && !config.standalone,
                    finalNumber = sale.finalInvoiceNumber,
                    footer = config.receiptFooter,
                    reprint = true,
                )
            }.onSuccess { printMessage = "Sent to printer" }
                .onFailure { printMessage = "Print failed: ${it.message}" }
        }
    }
}

/** Recent sales made on THIS device, with their journey to the server. */
@Composable
fun OrdersScreen(onMenu: (() -> Unit)? = null, vm: OrdersViewModel = hiltViewModel()) {
    val sales by vm.sales.collectAsStateWithLifecycle()
    val timeFmt = remember { DateTimeFormatter.ofPattern("EEE d MMM · HH:mm").withZone(ZoneId.systemDefault()) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            onMenu?.let {
                IconButton(onClick = it) { Icon(Icons.Filled.Menu, "Menu") }
            }
            Text("Orders", style = MaterialTheme.typography.headlineSmall)
        }
        if (sales.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.ReceiptLong,
                title = "No orders yet",
                subtitle = "Sales made on this device show up here instantly.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 16.dp),
            ) {
                items(sales, key = { it.id }) { sale ->
                    SaleCard(sale, timeFmt, standalone = vm.config.standalone, onClick = { vm.openDetail(sale) })
                }
            }
        }
    }

    vm.detail?.let { (sale, parsed) ->
        SaleDetailDialog(
            sale = sale,
            parsed = parsed,
            timeFmt = timeFmt,
            printMessage = vm.printMessage,
            onReprint = { vm.reprint() },
            onDismiss = { vm.closeDetail() },
        )
    }
}

@Composable
private fun SaleCard(
    sale: LocalSaleEntity,
    timeFmt: DateTimeFormatter,
    standalone: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 1.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    sale.finalInvoiceNumber ?: sale.provisionalNumber,
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    Money.format(sale.total),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${timeFmt.format(Instant.ofEpochMilli(sale.occurredAt))} · ${
                        sale.orderType.replace('_', ' ').replaceFirstChar { it.uppercase() }
                    }",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!standalone) SyncBadge(sale.syncStatus)
            }
            sale.lastError?.takeIf { sale.syncStatus == "failed" }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun SyncBadge(status: String) {
    val accents = LocalPosAccents.current
    when (status) {
        "pushed", "synced", "applied" -> StatusPill("Synced", accents.success, accents.successContainer)
        "failed" -> StatusPill("Rejected", MaterialTheme.colorScheme.onErrorContainer, MaterialTheme.colorScheme.errorContainer)
        else -> StatusPill("Pending sync", accents.warning, accents.warningContainer)
    }
}

@Composable
private fun SaleDetailDialog(
    sale: LocalSaleEntity,
    parsed: OrdersViewModel.ParsedSale,
    timeFmt: DateTimeFormatter,
    printMessage: String?,
    onReprint: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = {
            Column {
                Text(sale.finalInvoiceNumber ?: sale.provisionalNumber, style = MaterialTheme.typography.headlineSmall)
                Text(
                    timeFmt.format(Instant.ofEpochMilli(sale.occurredAt)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                parsed.lines.forEach { line ->
                    Column {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                "${if (line.quantity % 1.0 == 0.0) line.quantity.toInt() else line.quantity} × ${line.name}",
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                Money.bare(CartEngine.lineTotals(line).net),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        val detail = buildList {
                            line.modifiers.forEach { add("+ ${it.name}") }
                            line.accompaniments.forEach { add("+ ${it.name}") }
                            line.note?.let { add("“$it”") }
                        }
                        if (detail.isNotEmpty()) {
                            Text(
                                detail.joinToString("  "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                KVRow("Subtotal", Money.format(sale.subtotal))
                if (sale.taxAmount > 0) KVRow("Tax", Money.format(sale.taxAmount))
                KVRow("Total", Money.format(sale.total), emphasize = true, valueColor = MaterialTheme.colorScheme.primary)
                parsed.tenders.forEach { t ->
                    KVRow(t.method.replace('_', ' ').replaceFirstChar { it.uppercase() }, Money.format(t.amount))
                }
                printMessage?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = {
            Button(onClick = onReprint, shape = MaterialTheme.shapes.medium) {
                Icon(Icons.Outlined.Print, null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Reprint")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
