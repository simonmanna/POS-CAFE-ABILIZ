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
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Loyalty
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.HourglassBottom
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.QrCodeScanner
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.CustomerDao
import com.poscafe.pos.data.local.dao.HoldDao
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.ProductCategoryDao
import com.poscafe.pos.data.local.dao.ProductDao
import com.poscafe.pos.data.local.dao.ProductPackagingDao
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.dao.SettingsDao
import com.poscafe.pos.data.local.dao.TableDao
import com.poscafe.pos.data.local.entity.*
import com.poscafe.pos.data.repo.*
import com.poscafe.pos.printing.ReceiptPrinter
import com.poscafe.pos.ui.components.*
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
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
    private val settingsDao: SettingsDao,
    private val productDao: ProductDao,
    private val productCategoryDao: ProductCategoryDao,
    private val productPackagingDao: ProductPackagingDao,
    private val holdDao: HoldDao,
    private val customerDao: CustomerDao,
    private val customerRepo: CustomerRepository,
    opQueue: OpQueueDao,
    private val auth: AuthRepository,
    private val sales: SaleRepository,
    private val tabRepo: TabRepository,
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

    val isRetailMode: StateFlow<Boolean> =
        settingsDao.byKeyFlow("pos.mode")
            .map { setting ->
                if (setting == null) false
                else runCatching {
                    val el = Json.parseToJsonElement(setting.valueJson)
                    (el as? JsonPrimitive)?.content == "retail"
                }.getOrDefault(false)
            }
            .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    // ---- Retail-specific state ----
    val selectedProductCategory = MutableStateFlow<String?>(null)
    val productCategories: StateFlow<List<ProductCategoryEntity>> =
        productCategoryDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val productSearchQuery = MutableStateFlow("")

    /** Grid = category browse, or name/sku/barcode contains-search while typing. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val products: StateFlow<List<ProductEntity>> =
        combine(selectedProductCategory, productSearchQuery) { cat, query -> cat to query }
            .flatMapLatest { (cat, query) ->
                if (query.isBlank()) productDao.byCategory(cat) else productDao.search(query.trim())
            }
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Dine-in target; null = takeaway/counter sale. */
    val selectedTable = MutableStateFlow<PosTableEntity?>(null)

    init {
        // Retail has no tables — a table picked in cafe mode must never leak
        // into a retail sale as dine_in.
        viewModelScope.launch {
            runCatching {
                isRetailMode.collect { retail -> if (retail) selectedTable.value = null }
            }.onFailure { error = "init(retail-watch): ${it.message ?: it.javaClass.simpleName}" }
        }
    }

    // ---- Dine-in tabs (one open tab per table) ----

    /** Table ids that currently carry an open (unsettled) tab — badges the floor. */
    val openTabTableIds: StateFlow<List<String>> =
        tabRepo.openTableIds().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Line ids on the current tab already sent to the kitchen. */
    var firedLineIds by mutableStateOf<Set<String>>(emptySet()); private set

    val hasUnfiredLines: Boolean get() = cart.any { it.lineId !in firedLineIds }

    /** Switch tables: bank the current tab, then load the target table's tab.
     *  Items rung up before any table was picked (takeaway-in-progress) follow
     *  the cashier onto the table they assign, rather than being wiped. */
    fun selectTable(table: PosTableEntity?) {
        if (isRetailMode.value) { selectedTable.value = null; return }
        val previous = selectedTable.value
        if (previous?.id == table?.id) return
        viewModelScope.launch {
            // Unassigned items only carry over when there is no source table to
            // bank them against; when switching tables the cart belongs to the
            // previous table and must not leak onto the next one.
            val carryover = if (previous == null) cart else emptyList()
            if (previous != null) {
                tabRepo.save(previous.id, cart, guestCount = 0, partnerId = selectedCustomer?.id, firedLineIds = firedLineIds, actorUserId = auth.current?.userId)
            }
            selectedTable.value = table
            if (table != null) {
                val tab = tabRepo.load(table.id)
                cart = (tab?.lines ?: emptyList()) + carryover
                firedLineIds = tab?.firedLineIds ?: emptySet()
                tab?.partnerId?.let { pid -> selectedCustomer = customers.value.find { it.id == pid } }
            } else {
                cart = carryover
                firedLineIds = emptySet()
            }
        }
    }

    /** Bank the tab and return to the floor without settling. */
    fun saveTab() {
        val table = selectedTable.value ?: return
        viewModelScope.launch {
            tabRepo.save(table.id, cart, guestCount = 0, partnerId = selectedCustomer?.id, firedLineIds = firedLineIds, actorUserId = auth.current?.userId)
            cart = emptyList()
            firedLineIds = emptySet()
            selectedTable.value = null
        }
    }

    /** Fire the not-yet-sent lines to the kitchen printer as a KOT round. */
    fun fireKitchen() {
        val table = selectedTable.value ?: return
        val round = cart.filter { it.lineId !in firedLineIds }
        if (round.isEmpty()) return
        val host = config.printerHost
        viewModelScope.launch {
            if (host != null) {
                runCatching { printer.printKot(host = host, title = tableLabel(table), lines = round) }
                    .onFailure { error = "KOT print failed: ${it.message}" }
            }
            firedLineIds = firedLineIds + round.map { it.lineId }
            tabRepo.save(table.id, cart, guestCount = 0, partnerId = selectedCustomer?.id, firedLineIds = firedLineIds, actorUserId = auth.current?.userId)
        }
    }

    private fun tableLabel(table: PosTableEntity): String =
        table.name?.takeIf { it.isNotBlank() } ?: "Table ${table.number}"

    val customers: StateFlow<List<CustomerEntity>> =
        customerDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    var selectedCustomer by mutableStateOf<CustomerEntity?>(null); private set

    val holds: StateFlow<List<LocalHoldEntity>> =
        holdDao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun selectCustomer(customer: CustomerEntity?) { selectedCustomer = customer }

    fun createCustomer(name: String, phone: String?) {
        viewModelScope.launch {
            val entity = CustomerEntity(
                id = UUID.randomUUID().toString(),
                name = name,
                phone = phone?.takeIf { it.isNotBlank() },
                email = null,
                note = null,
                loyaltyPoints = 0,
                createdAt = System.currentTimeMillis(),
            )
            // Local upsert + customer.upsert op — the op queue is FIFO, so the
            // Partner reaches the server before any sale that references it.
            selectedCustomer = customerRepo.save(entity, auth.current?.userId)
        }
    }

    // ---- Hold / park ----

    private val holdJson = Json { encodeDefaults = false }

    fun saveHold(name: String) {
        if (cart.isEmpty()) return
        viewModelScope.launch {
            val linesJson = holdJson.encodeToString(
                kotlinx.serialization.builtins.ListSerializer(CartEngine.CartLine.serializer()),
                cart,
            )
            holdDao.insert(
                LocalHoldEntity(
                    id = UUID.randomUUID().toString(),
                    name = name,
                    linesJson = linesJson,
                    totalAmount = totals.total,
                    partnerId = selectedCustomer?.id,
                    actorUserId = auth.current?.userId,
                    createdAt = System.currentTimeMillis(),
                    syncStatus = "local",
                ),
            )
            cart = emptyList()
        }
    }

    fun retrieveHold(hold: LocalHoldEntity) {
        viewModelScope.launch {
            val lines = runCatching {
                holdJson.decodeFromString(
                    kotlinx.serialization.builtins.ListSerializer(CartEngine.CartLine.serializer()),
                    hold.linesJson,
                )
            }.getOrDefault(emptyList())
            if (lines.isNotEmpty()) cart = lines
        }
    }

    fun deleteHold(hold: LocalHoldEntity) {
        viewModelScope.launch { holdDao.softDelete(hold.id) }
    }

    var cart by mutableStateOf<List<CartEngine.CartLine>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set
    var charging by mutableStateOf(false); private set
    var successSale by mutableStateOf<SaleRepository.CompletedSale?>(null); private set

    // NOTE: init block split from the one above (line 157) so that
    // `cart` and the other `by mutableStateOf` delegates are initialized
    // BEFORE `snapshotFlow` eagerly reads their current value. Kotlin
    // initializes class body top-to-bottom — referencing a property
    // declared later in the class from an init block crashes with NPE
    // because the delegate backing field is still null.
    init {
        viewModelScope.launch {
            runCatching {
                snapshotFlow { cart }.collect { lines ->
                    val table = selectedTable.value ?: return@collect
                    if (isRetailMode.value) return@collect
                    tabRepo.save(table.id, lines, guestCount = 0, partnerId = selectedCustomer?.id, firedLineIds = firedLineIds, actorUserId = auth.current?.userId)
                }
            }.onFailure { error = "init(tab-autosave): ${it.message ?: it.javaClass.simpleName}" }
        }
    }

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

    fun onProductTap(product: ProductEntity) {
        val price = product.salesPrice
        val existing = cart.find { it.productId == product.id && it.note == null }
        cart = if (existing != null) {
            cart.map { if (it.lineId == existing.lineId) it.copy(quantity = it.quantity + 1) else it }
        } else {
            cart + CartEngine.CartLine(
                lineId = UUID.randomUUID().toString(),
                productId = product.id,
                name = product.name,
                quantity = 1.0,
                baseUnitPrice = price,
                taxRatePercent = product.taxRate,
                taxInclusive = product.taxInclusive,
            )
        }
    }

    fun onSearchQueryChanged(query: String) {
        productSearchQuery.value = query
        if (query.isBlank()) {
            selectedProductCategory.value = null
        }
    }

    fun searchProducts(query: String) {
        viewModelScope.launch {
            // A single-unit barcode/sku wins first; otherwise try a multipack
            // barcode (scan the case → add `quantity` base units).
            val product = productDao.byCode(query)
            if (product != null) {
                onProductTap(product)
                productSearchQuery.value = ""
                return@launch
            }
            val pack = productPackagingDao.byBarcode(query.trim())
            if (pack != null) {
                val base = productDao.byId(pack.productId)
                if (base != null) {
                    addProductPack(base, pack.quantity, pack.name)
                    productSearchQuery.value = ""
                }
            }
        }
    }

    /** Add a whole pack = `quantity` base units of the product as one line. */
    private fun addProductPack(product: ProductEntity, quantity: Double, packName: String) {
        cart = cart + CartEngine.CartLine(
            lineId = UUID.randomUUID().toString(),
            productId = product.id,
            name = "${product.name} · $packName",
            quantity = quantity,
            baseUnitPrice = product.salesPrice,
            taxRatePercent = product.taxRate,
            taxInclusive = product.taxInclusive,
        )
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

    /** Split tender: settle the whole cart with one or more payment legs. */
    fun charge(tenders: List<SaleRepository.Tender>, onDone: () -> Unit) {
        settleLines(cart.map { it.lineId }.toSet(), tenders, onDone)
    }

    /**
     * Settle a subset of the cart as its own sale (split bill). Passing every
     * line id is an ordinary full checkout. Each call emits one `sale.checkout`
     * op; the remaining lines stay on the tab until the last bill settles.
     */
    fun settleLines(lineIds: Set<String>, tenders: List<SaleRepository.Tender>, onDone: () -> Unit) {
        val user = auth.current ?: return
        if (charging || tenders.isEmpty()) return
        val billLines = cart.filter { it.lineId in lineIds }
        if (billLines.isEmpty()) return
        val table = if (isRetailMode.value) null else selectedTable.value
        viewModelScope.launch {
            charging = true
            try {
                error = null
                val sale = sales.checkout(
                    actorUserId = user.userId,
                    lines = billLines,
                    tenders = tenders,
                    cashSessionLocalId = session.value?.id,
                    tableId = table?.id,
                    orderType = if (table != null) "dine_in" else "takeaway",
                    partnerId = selectedCustomer?.id,
                )
                printSale(sale, billLines, tenders, user.displayName)
                val remaining = cart.filterNot { it.lineId in lineIds }
                firedLineIds = firedLineIds - lineIds
                if (remaining.isEmpty()) {
                    table?.let { tabRepo.clear(it.id) }
                    cart = emptyList()
                    selectedTable.value = null
                    successSale = sale
                } else {
                    // Split remainder stays open on the tab (auto-persisted).
                    cart = remaining
                }
                onDone()
            } catch (e: Exception) {
                error = e.message
            } finally {
                charging = false
            }
        }
    }

    private suspend fun printSale(
        sale: SaleRepository.CompletedSale,
        lines: List<CartEngine.CartLine>,
        tenders: List<SaleRepository.Tender>,
        cashierName: String,
    ) {
        val host = config.printerHost ?: return
        runCatching {
            printer.printReceipt(
                host = host,
                header = config.receiptHeader(),
                sale = sale,
                lines = lines,
                tenders = tenders,
                cashierName = cashierName,
                offline = !config.standalone,
                footer = config.receiptFooter,
            )
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
    val isRetail by vm.isRetailMode.collectAsStateWithLifecycle()
    val productCategories by vm.productCategories.collectAsStateWithLifecycle()
    val products by vm.products.collectAsStateWithLifecycle()
    val selectedProdCat by vm.selectedProductCategory.collectAsStateWithLifecycle()
    val searchQuery by vm.productSearchQuery.collectAsStateWithLifecycle()
    val customers by vm.customers.collectAsStateWithLifecycle()
    val selectedCustomer = vm.selectedCustomer

    var showCheckout by remember { mutableStateOf(false) }
    var showCartSheet by remember { mutableStateOf(false) }
    var showTablePicker by remember { mutableStateOf(false) }
    var showOpenSession by remember { mutableStateOf(false) }
    var showBarcodeScanner by remember { mutableStateOf(false) }
    var showCustomerPicker by remember { mutableStateOf(false) }
    val holdMode = remember { mutableStateOf<HoldDialogMode>(HoldDialogMode.Save) }
    var showHoldDialog by remember { mutableStateOf(false) }
    var showSplit by remember { mutableStateOf(false) }
    var splitSelection by remember { mutableStateOf<Set<String>>(emptySet()) }
    var splitCheckout by remember { mutableStateOf(false) }
    var showReservations by remember { mutableStateOf(false) }
    val holds by vm.holds.collectAsStateWithLifecycle()
    val haptics = LocalHapticFeedback.current

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 840.dp
        Column(Modifier.fillMaxSize()) {
            TerminalHeader(
                cashierName = vm.cashier?.displayName ?: "",
                sessionOpen = session != null,
                queuedOps = if (vm.config.standalone) 0 else queuedOps,
                table = if (isRetail) null else selectedTable,
                customer = selectedCustomer,
                onMenu = onMenu,
                onPickTable = if (isRetail) null else ({ showTablePicker = true } as (() -> Unit)?),
                onPickCustomer = { showCustomerPicker = true },
                onRecallHold = { holdMode.value = HoldDialogMode.Recall; showHoldDialog = true },
                onOpenSession = { vm.loadRegisters(); showOpenSession = true },
                isRetailMode = isRetail,
                searchQuery = searchQuery,
                onSearchQueryChanged = vm::onSearchQueryChanged,
                onSearch = vm::searchProducts,
                onScanBarcode = { showBarcodeScanner = true },
            )
            Row(Modifier.weight(1f)) {
                Column(Modifier.weight(1f).padding(horizontal = 16.dp)) {
                    if (isRetail) {
                        RetailCatalog(
                            categories = productCategories,
                            selectedCategory = selectedProdCat,
                            products = products,
                            vm = vm,
                            haptics = haptics,
                            serverUrl = vm.config.serverUrl,
                            wide = wide,
                        )
                    } else {
                        CafeCatalog(
                            categories = categories,
                            selectedCat = selectedCat,
                            menuItems = menuItems,
                            vm = vm,
                            haptics = haptics,
                            serverUrl = vm.config.serverUrl,
                            wide = wide,
                        )
                    }
                }
                if (wide) {
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        shape = RoundedCornerShape(topStart = 24.dp),
                        modifier = Modifier.width(360.dp).fillMaxHeight(),
                    ) {
                        CartPanel(
                            vm = vm,
                            table = if (isRetail) null else selectedTable,
                            onCharge = { showCheckout = true },
                            showHold = isRetail,
                            onHold = { holdMode.value = HoldDialogMode.Save; showHoldDialog = true },
                            onSplit = { showSplit = true },
                        )
                    }
                }
            }
        }

        if (!wide && vm.cart.isNotEmpty()) {
            CartBar(
                count = vm.cart.sumOf { it.quantity }.toInt(),
                total = vm.totals.total,
                onOpen = { showCartSheet = true },
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
            )
        }

        vm.successSale?.let { sale ->
            SuccessOverlay(
                sale = sale,
                onNewOrder = { vm.dismissSuccess() },
            )
        }
    }

    if (!isRetail) {
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
                }, showHold = isRetail, onHold = { holdMode.value = HoldDialogMode.Save; showHoldDialog = true },
                    onSplit = { showCartSheet = false; showSplit = true })
            }
        }
    }

    if (showCheckout) {
        CheckoutSheet(
            total = vm.totals.total,
            charging = vm.charging,
            error = vm.error,
            hasCustomer = selectedCustomer != null,
            onDismiss = { showCheckout = false },
            onCharge = { tenders ->
                vm.charge(tenders) { showCheckout = false }
            },
        )
    }

    if (showSplit) {
        SplitBillDialog(
            lines = vm.cart,
            onConfirm = { ids -> splitSelection = ids; showSplit = false; splitCheckout = true },
            onDismiss = { showSplit = false },
        )
    }

    if (splitCheckout) {
        CheckoutSheet(
            total = CartEngine.totals(vm.cart.filter { it.lineId in splitSelection }).total,
            charging = vm.charging,
            error = vm.error,
            hasCustomer = selectedCustomer != null,
            onDismiss = { splitCheckout = false },
            onCharge = { tenders ->
                vm.settleLines(splitSelection, tenders) { splitCheckout = false }
            },
        )
    }

    if (!isRetail && showTablePicker) {
        val openTabIds by vm.openTabTableIds.collectAsStateWithLifecycle()
        TablePickerDialog(
            tables = tables,
            openTabTableIds = openTabIds.toSet(),
            selectedId = selectedTable?.id,
            onSelect = { vm.selectTable(it); showTablePicker = false },
            onDismiss = { showTablePicker = false },
            onReservations = { showTablePicker = false; showReservations = true },
        )
    }

    if (showReservations) {
        ReservationsDialog(onDismiss = { showReservations = false })
    }

    if (showOpenSession) {
        OpenSessionDialog(
            registers = vm.registers,
            onOpen = { registerId, float -> vm.openSession(registerId, float); showOpenSession = false },
            onDismiss = { showOpenSession = false },
        )
    }

    if (showBarcodeScanner) {
        BarcodeScannerDialog(
            onDismiss = { showBarcodeScanner = false },
            onBarcodeDetected = { barcode -> vm.searchProducts(barcode) },
        )
    }

    if (showCustomerPicker) {
        CustomerPickerDialog(
            customers = customers,
            selectedId = selectedCustomer?.id,
            onSelect = { vm.selectCustomer(it); showCustomerPicker = false },
            onCreateCustomer = { name, phone -> vm.createCustomer(name, phone); showCustomerPicker = false },
            onDismiss = { showCustomerPicker = false },
        )
    }

    if (showHoldDialog) {
        HoldDialog(
            mode = holdMode.value,
            holds = holds,
            onSave = { name -> vm.saveHold(name); showHoldDialog = false },
            onRetrieve = { hold -> vm.retrieveHold(hold); showHoldDialog = false },
            onDelete = { hold -> vm.deleteHold(hold) },
            onDismiss = { showHoldDialog = false },
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
    customer: CustomerEntity? = null,
    onMenu: (() -> Unit)?,
    onPickTable: (() -> Unit)?,
    onPickCustomer: () -> Unit = {},
    onRecallHold: () -> Unit = {},
    onOpenSession: () -> Unit,
    isRetailMode: Boolean = false,
    searchQuery: String = "",
    onSearchQueryChanged: (String) -> Unit = {},
    onSearch: (String) -> Unit = {},
    onScanBarcode: () -> Unit = {},
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Left: menu + title/cashier. weight(1f) lets it yield space to the
            // action chips so their labels never get crushed into a vertical wrap.
            Row(
                Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                onMenu?.let {
                    IconButton(onClick = it) { Icon(Icons.Filled.Menu, "Menu") }
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        if (isRetailMode) "Retail POS" else "New order",
                        style = MaterialTheme.typography.headlineSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            cashierName,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (queuedOps > 0) {
                            StatusPill(
                                "$queuedOps to sync",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                container = MaterialTheme.colorScheme.surfaceContainerHigh,
                            )
                        }
                    }
                }
            }
            // Right: compact chips. softWrap = false guarantees a chip label
            // truncates with an ellipsis instead of wrapping one letter per line.
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                HeaderChip(
                    icon = Icons.Outlined.Person,
                    label = customer?.name,
                    fallback = "Customer",
                    active = customer != null,
                    onClick = onPickCustomer,
                )
                if (isRetailMode) {
                    HeaderChip(
                        icon = Icons.Outlined.HourglassBottom,
                        label = "Recall",
                        fallback = "Recall",
                        active = false,
                        onClick = onRecallHold,
                    )
                } else {
                    onPickTable?.let { pickTable ->
                        HeaderChip(
                            icon = Icons.Outlined.TableRestaurant,
                            label = table?.let { "Table ${it.number}" } ?: "Takeaway",
                            fallback = "Takeaway",
                            active = table != null,
                            onClick = pickTable,
                        )
                    }
                }
            }
        }
        // Cash-session warning gets its own full-width banner rather than fighting
        // the chips for space in the top row.
        if (!sessionOpen) {
            Spacer(Modifier.height(8.dp))
            Surface(
                onClick = onOpenSession,
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.errorContainer,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        Icons.Outlined.Payments, null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onErrorContainer,
                    )
                    Text(
                        "Cash session closed",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "Open now",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
        if (isRetailMode) {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = onSearchQueryChanged,
                    placeholder = { Text("Search by name, SKU, or barcode…") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, modifier = Modifier.size(20.dp)) },
                    trailingIcon = {
                        if (searchQuery.isNotEmpty()) {
                            IconButton(onClick = { onSearchQueryChanged("") }) {
                                Icon(Icons.Filled.Close, "Clear", modifier = Modifier.size(20.dp))
                            }
                        }
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { onSearch(searchQuery) }),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f).height(48.dp),
                )
                IconButton(onClick = onScanBarcode) {
                    Icon(
                        Icons.Outlined.QrCodeScanner, "Scan barcode",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(28.dp),
                    )
                }
            }
        }
    }
}

/** Compact header action chip: an icon plus a label that truncates (never
 *  wraps) so a long customer/table name can't stretch the row vertically. */
@Composable
private fun HeaderChip(
    icon: ImageVector,
    label: String?,
    fallback: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                icon, null,
                modifier = Modifier.size(16.dp),
                tint = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                label ?: fallback,
                style = MaterialTheme.typography.labelMedium,
                color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 96.dp),
            )
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
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        border = if (selected) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = if (selected) 2.dp else 0.dp,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun CafeCatalog(
    categories: List<MenuCategoryEntity>,
    selectedCat: String?,
    menuItems: List<MenuItemEntity>,
    vm: TerminalViewModel,
    haptics: androidx.compose.ui.hapticfeedback.HapticFeedback,
    serverUrl: String?,
    wide: Boolean,
) {
    CategoryChips(categories = categories, selected = selectedCat, onSelect = { vm.selectedCategory.value = it })
    Spacer(Modifier.height(12.dp))
    if (menuItems.isEmpty()) {
        EmptyState(
            icon = Icons.Outlined.RestaurantMenu,
            title = "No items here yet",
            subtitle = "Pull from the server on the More tab to load the menu.",
            modifier = Modifier.fillMaxSize(),
        )
    } else {
        // Per-item quantity already in the cart → drives the "×N" badge so the
        // cashier sees what's been rung up without opening the cart.
        val cartQty = vm.cart.groupBy { it.menuItemId }
            .mapNotNull { (id, lines) -> id?.let { it to lines.sumOf { l -> l.quantity }.toInt() } }
            .toMap()
        LazyVerticalGrid(
            columns = GridCells.Adaptive(150.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = if (wide) 16.dp else 96.dp),
        ) {
            items(menuItems, key = { it.id }) { item ->
                CatalogCard(
                    imageUrl = resolveAssetUrl(serverUrl, item.image),
                    name = item.name,
                    priceLabel = Money.format(item.basePriceMajor ?: 0.0),
                    inCartQty = cartQty[item.id] ?: 0,
                    onTap = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        vm.onItemTap(item)
                    },
                )
            }
        }
    }
}

@Composable
private fun RetailCatalog(
    categories: List<ProductCategoryEntity>,
    selectedCategory: String?,
    products: List<ProductEntity>,
    vm: TerminalViewModel,
    haptics: androidx.compose.ui.hapticfeedback.HapticFeedback,
    serverUrl: String?,
    wide: Boolean,
) {
    // Product category chips
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CategoryChip("All", selectedCategory == null) { vm.selectedProductCategory.value = null }
        categories.forEach { cat ->
            CategoryChip(cat.name, selectedCategory == cat.id) { vm.selectedProductCategory.value = cat.id }
        }
    }
    Spacer(Modifier.height(12.dp))
    if (products.isEmpty()) {
        EmptyState(
            icon = Icons.Outlined.RestaurantMenu,
            title = "No products",
            subtitle = "Sync products from the server, or scan a barcode above.",
            modifier = Modifier.fillMaxSize(),
        )
    } else {
        val cartQty = vm.cart.groupBy { it.productId }
            .mapNotNull { (id, lines) -> id?.let { it to lines.sumOf { l -> l.quantity }.toInt() } }
            .toMap()
        LazyVerticalGrid(
            columns = GridCells.Adaptive(150.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = if (wide) 16.dp else 96.dp),
        ) {
            items(products, key = { it.id }) { product ->
                CatalogCard(
                    imageUrl = resolveAssetUrl(serverUrl, product.image),
                    name = product.name,
                    priceLabel = Money.format(product.salesPrice),
                    inCartQty = cartQty[product.id] ?: 0,
                    onTap = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        vm.onProductTap(product)
                    },
                )
            }
        }
    }
}

/**
 * Shared catalog tile for both menu items and retail products. A tapped card
 * adds one unit; the green highlight + "×N" badge on the photo make the card
 * self-report how many are already on the bill.
 */
@Composable
private fun CatalogCard(
    imageUrl: String?,
    name: String,
    priceLabel: String,
    inCartQty: Int,
    onTap: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val inCart = inCartQty > 0
    Surface(
        onClick = onTap,
        interactionSource = interaction,
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = if (inCart) 3.dp else 1.dp,
        modifier = Modifier
            .pressScale(interaction)
            .border(
                width = if (inCart) 1.5.dp else 1.dp,
                color = if (inCart) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                shape = MaterialTheme.shapes.large,
            ),
    ) {
        Column(Modifier.padding(8.dp)) {
            Box(Modifier.fillMaxWidth().aspectRatio(1.2f)) {
                ItemImage(imageUrl, name, Modifier.fillMaxSize())
                if (inCart) {
                    Surface(
                        color = MaterialTheme.colorScheme.primary,
                        shape = RoundedCornerShape(999.dp),
                        shadowElevation = 2.dp,
                        modifier = Modifier.align(Alignment.TopStart).padding(6.dp),
                    ) {
                        Text(
                            "×$inCartQty",
                            color = MaterialTheme.colorScheme.onPrimary,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(
                name,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                // Reserve two lines so one- and two-line cards align in the grid.
                modifier = Modifier.heightIn(min = 40.dp),
            )
            Spacer(Modifier.height(4.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    priceLabel,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(6.dp))
                Box(
                    Modifier.size(32.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "+",
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
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
private fun CartPanel(vm: TerminalViewModel, table: PosTableEntity?, onCharge: () -> Unit, showHold: Boolean = false, onHold: () -> Unit = {}, onSplit: () -> Unit = {}) {
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
        // Dine-in tab controls: fire a KOT round, bank the tab, or split the bill.
        if (table != null && vm.cart.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { vm.fireKitchen() },
                    enabled = vm.hasUnfiredLines,
                    modifier = Modifier.weight(1f).height(48.dp),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(Icons.Outlined.RestaurantMenu, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Fire")
                }
                OutlinedButton(
                    onClick = { vm.saveTab() },
                    modifier = Modifier.weight(1f).height(48.dp),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(Icons.Outlined.TableRestaurant, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Save tab")
                }
            }
            Spacer(Modifier.height(8.dp))
            if (vm.cart.size > 1) {
                OutlinedButton(
                    onClick = onSplit,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape = RoundedCornerShape(12.dp),
                ) { Text("Split bill") }
                Spacer(Modifier.height(8.dp))
            }
        }
        if (showHold && vm.cart.isNotEmpty()) {
            OutlinedButton(
                onClick = onHold,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Icon(Icons.Outlined.ReceiptLong, null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Hold order")
            }
            Spacer(Modifier.height(8.dp))
        }
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
    hasCustomer: Boolean,
    onDismiss: () -> Unit,
    onCharge: (tenders: List<SaleRepository.Tender>) -> Unit,
) {
    // Split tender: legs accumulate until they cover the total. The common
    // single-payment case is still one tap — the amount field is prefilled to
    // the remaining balance, so "Complete" commits it and fires immediately.
    val legs = remember { mutableStateListOf<SaleRepository.Tender>() }
    val paid = legs.sumOf { it.amount }
    val remaining = (total - paid).coerceAtLeast(0.0)

    var method by remember { mutableStateOf("cash") }
    var tendered by remember(remaining) { mutableStateOf("%.0f".format(remaining)) }
    var reference by remember { mutableStateOf("") }
    val pending = tendered.toDoubleOrNull() ?: 0.0
    val covered = remaining <= 0.01
    val wouldCover = paid + pending >= total - 0.01
    // Change is only meaningful on a cash overpay.
    val change = (paid + pending - total).let { if (it > 0 && method == "cash") it else 0.0 }

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
                    if (legs.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        KVRow("Paid", Money.format(paid))
                        KVRow(
                            "Remaining",
                            Money.format(remaining),
                            emphasize = true,
                            valueColor = if (covered) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }

            // Committed tender legs (removable).
            legs.forEachIndexed { i, leg ->
                Row(
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(tenderLabel(leg.method), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text(Money.format(leg.amount), style = MaterialTheme.typography.bodyMedium)
                    IconButton(onClick = { legs.removeAt(i) }) {
                        Icon(Icons.Outlined.DeleteOutline, "Remove", tint = MaterialTheme.colorScheme.error)
                    }
                }
            }

            if (!covered) {
                Spacer(Modifier.height(16.dp))
                Text(if (legs.isEmpty()) "Payment method" else "Add payment", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PayMethodCard("Cash", Icons.Outlined.Payments, method == "cash", Modifier.weight(1f)) { method = "cash" }
                    PayMethodCard("Card", Icons.Outlined.CreditCard, method == "card", Modifier.weight(1f)) { method = "card" }
                    PayMethodCard("Mobile", Icons.Outlined.Smartphone, method == "mobile_money", Modifier.weight(1f)) { method = "mobile_money" }
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PayMethodCard("Bank", Icons.Outlined.AccountBalance, method == "bank", Modifier.weight(1f)) { method = "bank" }
                    if (hasCustomer) {
                        PayMethodCard("Store credit", Icons.Outlined.Loyalty, method == "store_credit", Modifier.weight(1f)) { method = "store_credit" }
                    } else {
                        Spacer(Modifier.weight(1f))
                    }
                    Spacer(Modifier.weight(1f))
                }

                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = tendered,
                    onValueChange = { tendered = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text(if (method == "cash") "Amount tendered" else "Amount") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium,
                    textStyle = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (method == "cash") {
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        quickCashAmounts(remaining).forEach { amt ->
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
                }
                if (method == "card" || method == "mobile_money" || method == "bank") {
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = reference,
                        onValueChange = { reference = it },
                        label = { Text("Reference (optional)") },
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (change > 0) {
                    Spacer(Modifier.height(12.dp))
                    KVRow("Change", Money.format(change), emphasize = true, valueColor = MaterialTheme.colorScheme.primary)
                }
            }

            error?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.height(20.dp))
            PrimaryButton(
                text = when {
                    charging -> "Completing…"
                    covered || wouldCover -> "Complete payment"
                    else -> "Add payment"
                },
                onClick = {
                    if (covered && pending <= 0.0) {
                        onCharge(legs.toList())
                    } else if (pending > 0.0) {
                        legs.add(SaleRepository.Tender(method, pending, reference.takeIf { it.isNotBlank() }))
                        reference = ""
                        if (legs.sumOf { it.amount } >= total - 0.01) onCharge(legs.toList())
                    }
                },
                enabled = !charging && (covered || pending > 0.0),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private fun tenderLabel(method: String): String = when (method) {
    "cash" -> "Cash"
    "card" -> "Card"
    "mobile_money" -> "Mobile money"
    "bank" -> "Bank"
    "store_credit" -> "Store credit"
    else -> method
}

/** Pick the lines that go on THIS bill; the rest stay on the tab. Each split
 *  bill settles as its own sale. */
@Composable
private fun SplitBillDialog(
    lines: List<CartEngine.CartLine>,
    onConfirm: (Set<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val selected = remember { mutableStateListOf<String>() }
    val selectedTotal = CartEngine.totals(lines.filter { it.lineId in selected }).total
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Split bill", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Select the items for this bill. The rest stay on the tab.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                lines.forEach { line ->
                    val checked = line.lineId in selected
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = checked,
                            onCheckedChange = { on -> if (on) selected.add(line.lineId) else selected.remove(line.lineId) },
                        )
                        Text(
                            "${if (line.quantity % 1.0 == 0.0) line.quantity.toInt() else line.quantity} × ${line.name}",
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(Money.bare(CartEngine.lineTotals(line).net), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(selected.toSet()) },
                enabled = selected.isNotEmpty() && selected.size < lines.size,
                shape = MaterialTheme.shapes.medium,
            ) { Text("Charge ${Money.format(selectedTotal)}") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
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
    openTabTableIds: Set<String> = emptySet(),
    onReservations: (() -> Unit)? = null,
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
                                if (t.id in openTabTableIds) {
                                    Text(
                                        "● open tab",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            onReservations?.let { TextButton(onClick = it) { Text("Reservations") } }
        },
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
