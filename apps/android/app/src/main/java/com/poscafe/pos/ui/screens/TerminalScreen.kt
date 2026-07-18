package com.poscafe.pos.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.dao.TableDao
import com.poscafe.pos.data.local.entity.*
import com.poscafe.pos.data.repo.*
import com.poscafe.pos.printing.ReceiptPrinter
import com.poscafe.pos.ui.components.*
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject
import kotlin.math.ceil

/**
 * The offline terminal: menu grid → cart → tender → local receipt print.
 * Everything works with zero connectivity; the op queue + SyncWorker handle
 * the rest when the network returns.
 */
@HiltViewModel
class TerminalViewModel @Inject constructor(
    private val menuDao: MenuDao,
    tableDao: TableDao,
    private val registerDao: RegisterDao,
    opQueue: OpQueueDao,
    private val auth: AuthRepository,
    private val sales: SaleRepository,
    private val sessions: CashSessionRepository,
    private val printer: ReceiptPrinter,
    val config: DeviceConfig,
) : ViewModel() {

    val selectedCategory = MutableStateFlow<String?>(null)
    val categories: StateFlow<List<MenuCategoryEntity>> =
        menuDao.categories().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    @OptIn(ExperimentalCoroutinesApi::class)
    val items: StateFlow<List<MenuItemEntity>> =
        selectedCategory.flatMapLatest { menuDao.items(it) }
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val session = sessions.openSession().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val tables: StateFlow<List<PosTableEntity>> =
        tableDao.tables().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val queuedOps: StateFlow<Int> =
        opQueue.queuedCount().stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    /** Dine-in target; null = takeaway/counter sale. */
    val selectedTable = MutableStateFlow<PosTableEntity?>(null)

    var cart by mutableStateOf<List<CartEngine.CartLine>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set
    var charging by mutableStateOf(false); private set
    var successSale by mutableStateOf<SaleRepository.CompletedSale?>(null); private set

    val totals: CartEngine.CartTotals get() = CartEngine.totals(cart)
    val cashier get() = auth.current

    // ---- item configuration (variants / add-ons / accompaniments) ----

    data class ModGroup(val group: ModifierGroupEntity, val modifiers: List<ModifierEntity>)
    data class AccGroup(val group: AccompanimentGroupEntity, val options: List<AccompanimentOptionEntity>)
    data class ItemConfig(
        val item: MenuItemEntity,
        val variants: List<MenuItemVariantEntity>,
        val modGroups: List<ModGroup>,
        val accGroups: List<AccGroup>,
    )

    var itemConfig by mutableStateOf<ItemConfig?>(null); private set

    /** Tap = instant add for plain items; items with options open the sheet. */
    fun onItemTap(item: MenuItemEntity) {
        viewModelScope.launch {
            val variants = menuDao.variants(item.id)
            val modGroups = menuDao.modifierGroupsFor(item.id).map { ModGroup(it, menuDao.modifiers(it.id)) }
            val accGroups = menuDao.accompanimentGroupsFor(item.id).map { AccGroup(it, menuDao.accompanimentOptions(it.id)) }
            if (variants.isEmpty() && modGroups.isEmpty() && accGroups.isEmpty()) {
                addSimple(item)
            } else {
                itemConfig = ItemConfig(item, variants, modGroups, accGroups)
            }
        }
    }

    fun dismissConfig() { itemConfig = null }

    private fun addSimple(item: MenuItemEntity) {
        val price = item.basePriceMajor ?: 0.0
        val existing = cart.find { it.menuItemId == item.id && it.variantId == null && it.modifiers.isEmpty() && it.accompaniments.isEmpty() && it.note == null }
        cart = if (existing != null) {
            cart.map { if (it.lineId == existing.lineId) it.copy(quantity = it.quantity + 1) else it }
        } else {
            cart + CartEngine.CartLine(
                lineId = UUID.randomUUID().toString(),
                menuItemId = item.id,
                name = item.name,
                quantity = 1.0,
                baseUnitPrice = price,
            )
        }
    }

    fun addConfigured(
        item: MenuItemEntity,
        variant: MenuItemVariantEntity?,
        modifiers: List<CartEngine.ModifierSel>,
        accompaniments: List<CartEngine.AccompanimentSel>,
        note: String?,
        quantity: Int,
    ) {
        cart = cart + CartEngine.CartLine(
            lineId = UUID.randomUUID().toString(),
            menuItemId = item.id,
            name = item.name,
            quantity = quantity.toDouble(),
            baseUnitPrice = variant?.price ?: (item.basePriceMajor ?: 0.0),
            variantId = variant?.id,
            variantName = variant?.name,
            modifiers = modifiers,
            accompaniments = accompaniments,
            note = note?.takeIf { it.isNotBlank() },
        )
        itemConfig = null
    }

    fun changeQty(lineId: String, delta: Double) {
        cart = cart.mapNotNull {
            if (it.lineId != lineId) it
            else (it.quantity + delta).let { q -> if (q <= 0) null else it.copy(quantity = q) }
        }
    }

    fun removeLine(lineId: String) { cart = cart.filterNot { it.lineId == lineId } }

    fun clear() { cart = emptyList() }

    fun charge(method: String, tendered: Double, reference: String?, onDone: () -> Unit) {
        val user = auth.current ?: return
        if (charging) return
        val linesAtSale = cart
        val table = selectedTable.value
        viewModelScope.launch {
            charging = true
            try {
                error = null
                val tender = SaleRepository.Tender(method, tendered, reference?.takeIf { it.isNotBlank() })
                val sale = sales.checkout(
                    actorUserId = user.userId,
                    lines = linesAtSale,
                    tenders = listOf(tender),
                    cashSessionLocalId = session.value?.id,
                    tableId = table?.id,
                    orderType = if (table != null) "dine_in" else "takeaway",
                )
                config.printerHost?.let { host ->
                    runCatching {
                        printer.printReceipt(
                            host = host,
                            header = config.receiptHeader(),
                            sale = sale,
                            lines = linesAtSale,
                            tenders = listOf(tender),
                            cashierName = user.displayName,
                            offline = !config.standalone,
                            footer = config.receiptFooter,
                        )
                    }
                }
                cart = emptyList()
                selectedTable.value = null
                successSale = sale
                onDone()
            } catch (e: Exception) {
                error = e.message
            } finally {
                charging = false
            }
        }
    }

    fun dismissSuccess() { successSale = null }

    // ---- cash session ----

    var registers by mutableStateOf<List<CashRegisterEntity>>(emptyList()); private set

    fun loadRegisters() { viewModelScope.launch { registers = registerDao.all() } }

    fun openSession(registerId: String, float: Double) {
        val user = auth.current ?: return
        viewModelScope.launch {
            runCatching { sessions.open(user.userId, registerId, float) }
                .onFailure { error = it.message }
        }
    }
}

// =====================================================================
// Screen
// =====================================================================

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(vm: TerminalViewModel, onMenu: (() -> Unit)? = null) {
    val categories by vm.categories.collectAsStateWithLifecycle()
    val menuItems by vm.items.collectAsStateWithLifecycle()
    val selectedCat by vm.selectedCategory.collectAsStateWithLifecycle()
    val session by vm.session.collectAsStateWithLifecycle()
    val queuedOps by vm.queuedOps.collectAsStateWithLifecycle()
    val selectedTable by vm.selectedTable.collectAsStateWithLifecycle()
    val tables by vm.tables.collectAsStateWithLifecycle()

    var showCheckout by remember { mutableStateOf(false) }
    var showCartSheet by remember { mutableStateOf(false) }
    var showTablePicker by remember { mutableStateOf(false) }
    var showOpenSession by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 840.dp
        Column(Modifier.fillMaxSize()) {
            TerminalHeader(
                cashierName = vm.cashier?.displayName ?: "",
                sessionOpen = session != null,
                queuedOps = if (vm.config.standalone) 0 else queuedOps,
                table = selectedTable,
                onMenu = onMenu,
                onPickTable = { showTablePicker = true },
                onOpenSession = { vm.loadRegisters(); showOpenSession = true },
            )
            Row(Modifier.weight(1f)) {
                // ---- Menu ----
                Column(Modifier.weight(1f).padding(horizontal = 16.dp)) {
                    CategoryChips(
                        categories = categories,
                        selected = selectedCat,
                        onSelect = { vm.selectedCategory.value = it },
                    )
                    Spacer(Modifier.height(12.dp))
                    if (menuItems.isEmpty()) {
                        EmptyState(
                            icon = Icons.Outlined.RestaurantMenu,
                            title = "No items here yet",
                            subtitle = "Pull from the server on the More tab to load the menu.",
                            modifier = Modifier.fillMaxSize(),
                        )
                    } else {
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(150.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            contentPadding = PaddingValues(bottom = if (wide) 16.dp else 96.dp),
                        ) {
                            items(menuItems, key = { it.id }) { item ->
                                ProductCard(
                                    item = item,
                                    imageUrl = resolveAssetUrl(vm.config.serverUrl, item.image),
                                    onTap = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        vm.onItemTap(item)
                                    },
                                )
                            }
                        }
                    }
                }
                // ---- Cart (tablet: persistent panel) ----
                if (wide) {
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        shape = RoundedCornerShape(topStart = 24.dp),
                        modifier = Modifier.width(360.dp).fillMaxHeight(),
                    ) {
                        CartPanel(
                            vm = vm,
                            table = selectedTable,
                            onCharge = { showCheckout = true },
                        )
                    }
                }
            }
        }

        // ---- Phone: floating cart bar ----
        if (!wide && vm.cart.isNotEmpty()) {
            CartBar(
                count = vm.cart.sumOf { it.quantity }.toInt(),
                total = vm.totals.total,
                onOpen = { showCartSheet = true },
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
            )
        }

        // ---- Payment success ----
        vm.successSale?.let { sale ->
            SuccessOverlay(
                sale = sale,
                onNewOrder = { vm.dismissSuccess() },
            )
        }
    }

    // ---- Sheets & dialogs ----
    vm.itemConfig?.let { config ->
        ItemConfigSheet(
            config = config,
            imageUrl = resolveAssetUrl(vm.config.serverUrl, config.item.image),
            onDismiss = { vm.dismissConfig() },
            onAdd = { variant, mods, accs, note, qty ->
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                vm.addConfigured(config.item, variant, mods, accs, note, qty)
            },
        )
    }

    if (showCartSheet) {
        ModalBottomSheet(
            onDismissRequest = { showCartSheet = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            Box(Modifier.fillMaxWidth().heightIn(max = 640.dp)) {
                CartPanel(vm = vm, table = vm.selectedTable.collectAsStateWithLifecycle().value, onCharge = {
                    showCartSheet = false
                    showCheckout = true
                })
            }
        }
    }

    if (showCheckout) {
        CheckoutSheet(
            total = vm.totals.total,
            charging = vm.charging,
            error = vm.error,
            onDismiss = { showCheckout = false },
            onCharge = { method, tendered, reference ->
                vm.charge(method, tendered, reference) { showCheckout = false }
            },
        )
    }

    if (showTablePicker) {
        TablePickerDialog(
            tables = tables,
            selectedId = selectedTable?.id,
            onSelect = { vm.selectedTable.value = it; showTablePicker = false },
            onDismiss = { showTablePicker = false },
        )
    }

    if (showOpenSession) {
        OpenSessionDialog(
            registers = vm.registers,
            onOpen = { registerId, float -> vm.openSession(registerId, float); showOpenSession = false },
            onDismiss = { showOpenSession = false },
        )
    }
}

// =====================================================================
// Pieces
// =====================================================================

@Composable
private fun TerminalHeader(
    cashierName: String,
    sessionOpen: Boolean,
    queuedOps: Int,
    table: PosTableEntity?,
    onMenu: (() -> Unit)?,
    onPickTable: () -> Unit,
    onOpenSession: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            onMenu?.let {
                IconButton(onClick = it) { Icon(Icons.Filled.Menu, "Menu") }
            }
            Column {
                Text("New order", style = MaterialTheme.typography.headlineSmall)
                Text(
                    cashierName,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (queuedOps > 0) {
                StatusPill(
                    "$queuedOps to sync",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    container = MaterialTheme.colorScheme.surfaceContainerHigh,
                )
            }
            if (!sessionOpen) {
                Surface(
                    onClick = onOpenSession,
                    shape = RoundedCornerShape(999.dp),
                    color = MaterialTheme.colorScheme.errorContainer,
                ) {
                    Text(
                        "Open cash session",
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
            // Table selector chip
            Surface(
                onClick = onPickTable,
                shape = RoundedCornerShape(999.dp),
                color = if (table != null) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        Icons.Outlined.TableRestaurant, null,
                        modifier = Modifier.size(16.dp),
                        tint = if (table != null) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        table?.let { "Table ${it.number}" } ?: "Takeaway",
                        style = MaterialTheme.typography.labelMedium,
                        color = if (table != null) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CategoryChips(
    categories: List<MenuCategoryEntity>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CategoryChip("All", selected == null) { onSelect(null) }
        categories.forEach { cat ->
            CategoryChip(cat.name, selected == cat.id) { onSelect(cat.id) }
        }
    }
}

@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
        border = if (selected) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun ProductCard(item: MenuItemEntity, imageUrl: String?, onTap: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onTap,
        interactionSource = interaction,
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 1.dp,
        modifier = Modifier
            .pressScale(interaction)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.large),
    ) {
        Column(Modifier.padding(10.dp)) {
            ItemImage(imageUrl, item.name, Modifier.fillMaxWidth().aspectRatio(1.25f))
            Spacer(Modifier.height(10.dp))
            Text(
                item.name,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.heightIn(min = 20.dp),
            )
            Spacer(Modifier.height(6.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    Money.format(item.basePriceMajor ?: 0.0),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
                Box(
                    Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("+", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.titleSmall)
                }
            }
        }
    }
}

@Composable
private fun CartBar(count: Int, total: Double, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onOpen,
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.inverseSurface,
        shadowElevation = 6.dp,
        modifier = modifier.fillMaxWidth().height(64.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("$count", color = Color.White, style = MaterialTheme.typography.labelMedium)
                }
                Text(
                    "View cart",
                    color = MaterialTheme.colorScheme.inverseOnSurface,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            Text(
                Money.format(total),
                color = MaterialTheme.colorScheme.inverseOnSurface,
                style = MaterialTheme.typography.titleLarge,
            )
        }
    }
}

@Composable
private fun CartPanel(vm: TerminalViewModel, table: PosTableEntity?, onCharge: () -> Unit) {
    val totals = vm.totals
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Current order", style = MaterialTheme.typography.titleMedium)
            if (vm.cart.isNotEmpty()) {
                TextButton(onClick = { vm.clear() }) { Text("Clear") }
            }
        }
        table?.let {
            StatusPill(
                "Table ${it.number}${it.name?.let { n -> " · $n" } ?: ""}",
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                container = MaterialTheme.colorScheme.primaryContainer,
            )
            Spacer(Modifier.height(8.dp))
        }
        if (vm.cart.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.ReceiptLong,
                title = "Cart is empty",
                subtitle = "Tap items on the menu to add them.",
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(vm.cart, key = { it.lineId }) { line ->
                    CartLineRow(
                        line = line,
                        lineTotal = totals.lines[line.lineId]?.net ?: 0.0,
                        onDec = { vm.changeQty(line.lineId, -1.0) },
                        onInc = { vm.changeQty(line.lineId, +1.0) },
                        onRemove = { vm.removeLine(line.lineId) },
                    )
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Spacer(Modifier.height(12.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            KVRow("Subtotal", Money.format(totals.subtotal))
            if (totals.discountTotal > 0) KVRow("Discount", "− ${Money.format(totals.discountTotal)}")
            if (totals.taxTotal > 0) KVRow("Tax", Money.format(totals.taxTotal))
            KVRow("Total", Money.format(totals.total), emphasize = true, valueColor = MaterialTheme.colorScheme.primary)
        }
        vm.error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(12.dp))
        PrimaryButton(
            text = if (vm.cart.isEmpty()) "Charge" else "Charge ${Money.format(totals.total)}",
            onClick = onCharge,
            enabled = vm.cart.isNotEmpty() && !vm.charging,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun CartLineRow(
    line: CartEngine.CartLine,
    lineTotal: Double,
    onDec: () -> Unit,
    onInc: () -> Unit,
    onRemove: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(line.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val detail = buildList {
                    line.variantName?.let { add(it) }
                    line.accompaniments.forEach { add(it.name) }
                    line.modifiers.forEach { add(it.name) }
                    line.note?.let { add("“$it”") }
                }
                if (detail.isNotEmpty()) {
                    Text(
                        detail.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(Money.format(lineTotal), style = MaterialTheme.typography.titleSmall)
        }
        Spacer(Modifier.height(6.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Outlined.DeleteOutline, "Remove",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
            QuantityStepper(
                quantity = line.quantity.toInt(),
                onDecrement = onDec,
                onIncrement = onInc,
                buttonSize = 34.dp,
            )
        }
    }
}

// =====================================================================
// Item configuration sheet
// =====================================================================

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ItemConfigSheet(
    config: TerminalViewModel.ItemConfig,
    imageUrl: String?,
    onDismiss: () -> Unit,
    onAdd: (MenuItemVariantEntity?, List<CartEngine.ModifierSel>, List<CartEngine.AccompanimentSel>, String?, Int) -> Unit,
) {
    var variant by remember(config) { mutableStateOf(config.variants.firstOrNull()) }
    var selectedMods by remember(config) {
        mutableStateOf(
            config.modGroups.flatMap { g -> g.modifiers.filter { it.isDefault } }.map { it.id }.toSet(),
        )
    }
    var selectedAccs by remember(config) {
        mutableStateOf(
            config.accGroups.flatMap { g -> g.options.filter { it.isDefault } }.map { it.id }.toSet(),
        )
    }
    var note by remember(config) { mutableStateOf("") }
    var qty by remember(config) { mutableStateOf(1) }

    val allMods = config.modGroups.flatMap { it.modifiers }
    val allAccs = config.accGroups.flatMap { it.options }
    val unitPrice = (variant?.price ?: (config.item.basePriceMajor ?: 0.0)) +
        allMods.filter { selectedMods.contains(it.id) }.sumOf { it.priceDelta } +
        allAccs.filter { selectedAccs.contains(it.id) }.sumOf { it.priceImpact }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 20.dp),
        ) {
            if (imageUrl != null) {
                ItemImage(imageUrl, config.item.name, Modifier.fillMaxWidth().height(160.dp))
                Spacer(Modifier.height(16.dp))
            }
            Text(config.item.name, style = MaterialTheme.typography.headlineSmall)
            config.item.description?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                Money.format(variant?.price ?: (config.item.basePriceMajor ?: 0.0)),
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.primary,
            )

            if (config.variants.isNotEmpty()) {
                SectionHeader("Size", required = true)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    config.variants.forEach { v ->
                        SelectableRow(
                            title = v.name,
                            trailing = Money.format(v.price),
                            selected = variant?.id == v.id,
                            radio = true,
                            onClick = { variant = v },
                        )
                    }
                }
            }

            config.accGroups.forEach { group ->
                SectionHeader(group.group.name, required = group.group.isRequired)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.options.forEach { opt ->
                        SelectableRow(
                            title = opt.name,
                            trailing = if (opt.priceImpact > 0) "+ ${Money.format(opt.priceImpact)}" else "Included",
                            selected = selectedAccs.contains(opt.id),
                            onClick = {
                                selectedAccs = if (selectedAccs.contains(opt.id)) selectedAccs - opt.id else selectedAccs + opt.id
                            },
                        )
                    }
                }
            }

            config.modGroups.forEach { group ->
                SectionHeader(group.group.name, required = false)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.modifiers.forEach { mod ->
                        SelectableRow(
                            title = mod.name,
                            trailing = when {
                                mod.priceDelta > 0 -> "+ ${Money.format(mod.priceDelta)}"
                                mod.priceDelta < 0 -> "− ${Money.format(-mod.priceDelta)}"
                                else -> ""
                            },
                            selected = selectedMods.contains(mod.id),
                            onClick = {
                                selectedMods = if (selectedMods.contains(mod.id)) selectedMods - mod.id else selectedMods + mod.id
                            },
                        )
                    }
                }
            }

            SectionHeader("Special instructions", required = false)
            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                placeholder = { Text("E.g. no onions, well done…") },
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(20.dp))
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                QuantityStepper(
                    quantity = qty,
                    onDecrement = { if (qty > 1) qty-- },
                    onIncrement = { qty++ },
                    buttonSize = 44.dp,
                )
                PrimaryButton(
                    text = "Add · ${Money.format(unitPrice * qty)}",
                    onClick = {
                        val mods = allMods.filter { selectedMods.contains(it.id) }
                            .map { CartEngine.ModifierSel(it.id, it.name, it.priceDelta) }
                        val accs = allAccs.filter { selectedAccs.contains(it.id) }
                            .map { CartEngine.AccompanimentSel(it.id, it.name, it.priceImpact) }
                        onAdd(variant, mods, accs, note, qty)
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, required: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        if (required) {
            StatusPill(
                "Required",
                color = MaterialTheme.colorScheme.error,
                container = MaterialTheme.colorScheme.errorContainer,
            )
        }
    }
}

@Composable
private fun SelectableRow(
    title: String,
    trailing: String,
    selected: Boolean,
    onClick: () -> Unit,
    radio: Boolean = false,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier
                    .size(20.dp)
                    .background(
                        color = if (selected) MaterialTheme.colorScheme.primary else Color.Transparent,
                        shape = if (radio) CircleShape else RoundedCornerShape(6.dp),
                    )
                    .border(
                        width = if (selected) 0.dp else 1.5.dp,
                        color = if (selected) Color.Transparent else MaterialTheme.colorScheme.outline,
                        shape = if (radio) CircleShape else RoundedCornerShape(6.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (selected) {
                    Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(13.dp))
                }
            }
            Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Text(
                trailing,
                style = MaterialTheme.typography.labelMedium,
                color = if (trailing.startsWith("+")) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// =====================================================================
// Checkout
// =====================================================================

private fun quickCashAmounts(total: Double): List<Double> {
    val denoms = listOf(1000.0, 2000.0, 5000.0, 10000.0, 20000.0, 50000.0)
    return denoms.map { ceil(total / it) * it }.filter { it >= total }.distinct().sorted().take(4)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CheckoutSheet(
    total: Double,
    charging: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onCharge: (method: String, tendered: Double, reference: String?) -> Unit,
) {
    var method by remember { mutableStateOf("cash") }
    var tendered by remember { mutableStateOf("%.0f".format(total)) }
    var reference by remember { mutableStateOf("") }
    val tenderedValue = tendered.toDoubleOrNull() ?: 0.0
    val change = tenderedValue - total

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
        ) {
            Text("Checkout", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(16.dp))
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Amount due", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(Money.format(total), style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.primary)
                }
            }

            Spacer(Modifier.height(16.dp))
            Text("Payment method", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PayMethodCard("Cash", Icons.Outlined.Payments, method == "cash", Modifier.weight(1f)) { method = "cash" }
                PayMethodCard("Card", Icons.Outlined.CreditCard, method == "card", Modifier.weight(1f)) { method = "card" }
                PayMethodCard("Mobile", Icons.Outlined.Smartphone, method == "mobile_money", Modifier.weight(1f)) { method = "mobile_money" }
            }

            when (method) {
                "cash" -> {
                    Spacer(Modifier.height(16.dp))
                    OutlinedTextField(
                        value = tendered,
                        onValueChange = { tendered = it.filter { c -> c.isDigit() || c == '.' } },
                        label = { Text("Amount tendered") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        shape = MaterialTheme.shapes.medium,
                        textStyle = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        quickCashAmounts(total).forEach { amt ->
                            Surface(
                                onClick = { tendered = "%.0f".format(amt) },
                                shape = RoundedCornerShape(999.dp),
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                            ) {
                                Text(
                                    Money.bare(amt),
                                    style = MaterialTheme.typography.labelLarge,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    KVRow(
                        "Change",
                        Money.format(if (change > 0) change else 0.0),
                        emphasize = true,
                        valueColor = if (change >= 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    )
                }
                "mobile_money" -> {
                    Spacer(Modifier.height(16.dp))
                    OutlinedTextField(
                        value = reference,
                        onValueChange = { reference = it },
                        label = { Text("Transaction reference (optional)") },
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            error?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.height(20.dp))
            val cashShort = method == "cash" && tenderedValue < total - 0.01
            PrimaryButton(
                text = when {
                    charging -> "Completing…"
                    method == "cash" -> "Complete payment"
                    else -> "Complete · ${Money.format(total)}"
                },
                onClick = {
                    val amount = if (method == "cash") tenderedValue else total
                    onCharge(method, amount, reference)
                },
                enabled = !charging && !cashShort,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun PayMethodCard(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        ),
        modifier = modifier.height(72.dp),
    ) {
        Column(
            Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                icon, null,
                tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.height(4.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

// =====================================================================
// Success overlay
// =====================================================================

@Composable
private fun SuccessOverlay(sale: SaleRepository.CompletedSale, onNewOrder: () -> Unit) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(sale.localId) { shown = true }
    val checkScale by animateFloatAsState(
        targetValue = if (shown) 1f else 0.4f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMediumLow),
        label = "checkScale",
    )
    AnimatedVisibility(visible = shown, enter = fadeIn(), exit = fadeOut()) {
        Surface(color = MaterialTheme.colorScheme.scrim, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Surface(
                    shape = MaterialTheme.shapes.extraLarge,
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                ) {
                    Column(
                        Modifier.padding(horizontal = 24.dp, vertical = 32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier
                                .size(88.dp)
                                .scale(checkScale)
                                .background(MaterialTheme.colorScheme.primary, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Filled.Check, null,
                                tint = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(44.dp),
                            )
                        }
                        Spacer(Modifier.height(20.dp))
                        Text("Payment successful", style = MaterialTheme.typography.headlineSmall)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Receipt ${sale.provisionalNumber}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(16.dp))
                        Text("Total paid", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            Money.format(sale.totals.total),
                            style = MaterialTheme.typography.displaySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.height(24.dp))
                        PrimaryButton(
                            text = "New order",
                            onClick = onNewOrder,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

// =====================================================================
// Dialogs
// =====================================================================

@Composable
fun TablePickerDialog(
    tables: List<PosTableEntity>,
    selectedId: String?,
    onSelect: (PosTableEntity?) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Select table", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column {
                Surface(
                    onClick = { onSelect(null) },
                    shape = MaterialTheme.shapes.medium,
                    color = if (selectedId == null) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "Takeaway — no table",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(14.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(96.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.heightIn(max = 360.dp),
                ) {
                    items(tables, key = { it.id }) { t ->
                        val statusColor = tableStatusColor(t.status)
                        Surface(
                            onClick = { onSelect(t) },
                            shape = MaterialTheme.shapes.medium,
                            color = if (selectedId == t.id) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
                            border = BorderStroke(
                                width = if (selectedId == t.id) 1.5.dp else 1.dp,
                                color = if (selectedId == t.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                            ),
                        ) {
                            Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                    StatusDot(statusColor)
                                    Text("T${t.number}", style = MaterialTheme.typography.titleSmall)
                                }
                                t.name?.takeIf { it.isNotBlank() }?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
fun tableStatusColor(status: String): Color = when (status.lowercase()) {
    "available", "free" -> MaterialTheme.colorScheme.primary
    "occupied" -> MaterialTheme.colorScheme.error
    "reserved" -> com.poscafe.pos.ui.theme.LocalPosAccents.current.warning
    "needs_bill", "billed" -> MaterialTheme.colorScheme.tertiary
    else -> MaterialTheme.colorScheme.outline
}

@Composable
fun OpenSessionDialog(
    registers: List<CashRegisterEntity>,
    onOpen: (registerId: String, float: Double) -> Unit,
    onDismiss: () -> Unit,
) {
    var registerId by remember(registers) { mutableStateOf(registers.firstOrNull()?.id) }
    var float by remember { mutableStateOf("0") }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Open cash session", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (registers.isEmpty()) {
                    Text(
                        "No cash registers synced to this device yet — pull from the server first.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    Text("Register", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    registers.forEach { r ->
                        Surface(
                            onClick = { registerId = r.id },
                            shape = MaterialTheme.shapes.medium,
                            color = if (registerId == r.id) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
                            border = BorderStroke(
                                1.dp,
                                if (registerId == r.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                "${r.code}${r.name?.let { " — $it" } ?: ""}",
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(12.dp),
                            )
                        }
                    }
                    OutlinedTextField(
                        value = float,
                        onValueChange = { float = it.filter { c -> c.isDigit() || c == '.' } },
                        label = { Text("Opening float (UGX)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = registerId != null,
                shape = MaterialTheme.shapes.medium,
                onClick = { registerId?.let { onOpen(it, float.toDoubleOrNull() ?: 0.0) } },
            ) { Text("Open session") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
