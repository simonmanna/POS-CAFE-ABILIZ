package com.cafe.pos.ui.screens.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Inventory
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.PowerOff
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Summarize
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.ProductDto
import com.cafe.pos.domain.cart.CartStore
import com.cafe.pos.hardware.impl.CameraBarcodeScanner
import com.cafe.pos.ui.components.CountBadge
import com.cafe.pos.ui.components.OfflineBanner
import com.cafe.pos.ui.components.SyncStatusBanner
import com.cafe.pos.ui.components.scanner.ScannerSheet
import com.cafe.pos.data.sync.SyncStatusViewModel
import com.cafe.pos.domain.session.ShiftSessionStore
import com.cafe.pos.ui.navigation.rememberIsTablet
import com.cafe.pos.ui.screens.cashsession.ShiftCloseDialog
import com.cafe.pos.ui.screens.cashsession.ShiftOpenDialog
import com.cafe.pos.ui.screens.combos.ComboPickerDialog
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    viewModel: TerminalViewModel = hiltViewModel(),
    onCheckout: () -> Unit,
    onHolds: () -> Unit,
    onKds: () -> Unit,
    onReports: () -> Unit,
    onSettings: () -> Unit = {},
    onLogout: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    val cart by viewModel.cartState.collectAsState()
    val isTablet = rememberIsTablet()
    val scanner: CameraBarcodeScanner = hiltViewModel<TerminalScannerHolder>().scanner
    val scope = rememberCoroutineScope()
    var showScanner by remember { mutableStateOf(false) }
    var showHoldDialog by remember { mutableStateOf(false) }
    var showShiftOpen by remember { mutableStateOf(false) }
    var showShiftClose by remember { mutableStateOf(false) }
    var showComboPicker by remember { mutableStateOf(false) }

    // Shift state — drives the banner + "no open shift" checkout block.
    val shiftStore: ShiftSessionStore = hiltViewModel<TerminalSessionHolder>().shiftStore
    val activeShift by shiftStore.current.collectAsState()
    val noActiveShift = activeShift == null

    // Sync status — drives the pending-sales banner above the menu.
    val syncVm: SyncStatusViewModel = hiltViewModel()
    val syncStatus by syncVm.status.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshActiveShift() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Front counter") },
                actions = {
                    IconButton(onClick = { showScanner = true }) {
                        Icon(Icons.Default.QrCodeScanner, contentDescription = "Scan")
                    }
                    IconButton(onClick = { showComboPicker = true }) {
                        Icon(Icons.Default.Restaurant, contentDescription = "Combos")
                    }
                    IconButton(onClick = { showShiftOpen = true }) {
                        Icon(Icons.Default.PowerSettingsNew, contentDescription = "Open shift")
                    }
                    IconButton(onClick = { showShiftClose = true }, enabled = !noActiveShift) {
                        Icon(Icons.Default.PowerOff, contentDescription = "Close shift")
                    }
                    IconButton(onClick = onHolds) { Icon(Icons.Default.PauseCircle, contentDescription = "Held orders") }
                    IconButton(onClick = onKds) { Icon(Icons.Default.Restaurant, contentDescription = "KDS") }
                    IconButton(onClick = onReports) { Icon(Icons.Default.Summarize, contentDescription = "Reports") }
                    IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
                    IconButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "Log out") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(visible = ui.error != null && ui.products.isEmpty())
            SyncStatusBanner(
                status = syncStatus,
                onSyncNow = { syncVm.syncNow() },
            )
            if (noActiveShift) {
                androidx.compose.material3.Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        androidx.compose.material3.Icon(
                            Icons.Default.PowerSettingsNew,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        androidx.compose.foundation.layout.Spacer(Modifier.padding(4.dp))
                        androidx.compose.material3.Text(
                            "No shift open — open one to start selling.",
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        androidx.compose.material3.TextButton(
                            onClick = { showShiftOpen = true },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                            ),
                        ) { Text("Open") }
                    }
                }
            }
            if (isTablet) {
                Row(modifier = Modifier.fillMaxSize()) {
                    Box(modifier = Modifier.weight(1.6f).fillMaxHeight()) {
                        MenuArea(
                            ui = ui,
                            onSearch = viewModel::onSearch,
                            onCategory = viewModel::selectCategory,
                            onAdd = viewModel::addProduct,
                            onScanClick = { showScanner = true },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    CartPane(
                        cart = cart,
                        onQty = viewModel::setQuantity,
                        onRemove = viewModel::removeLine,
                        onClear = viewModel::clearCart,
                        onHold = { showHoldDialog = true },
                        onCheckout = onCheckout,
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                }
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    MenuArea(
                        ui = ui,
                        onSearch = viewModel::onSearch,
                        onCategory = viewModel::selectCategory,
                        onAdd = viewModel::addProduct,
                        onScanClick = { showScanner = true },
                        modifier = Modifier.weight(1f),
                    )
                    CartPane(
                        cart = cart,
                        onQty = viewModel::setQuantity,
                        onRemove = viewModel::removeLine,
                        onClear = viewModel::clearCart,
                        onHold = { showHoldDialog = true },
                        onCheckout = onCheckout,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }

    ScannerSheet(
        visible = showScanner,
        scanner = scanner,
        onScanned = { code ->
            showScanner = false
            scope.launch {
                viewModel.lookupAndAddBySku(code)
            }
        },
        onDismiss = { showScanner = false },
    )

    if (showHoldDialog) {
        com.cafe.pos.ui.screens.holds.HoldCartDialog(
            lineCount = cart.lines.size,
            onDismiss = { showHoldDialog = false },
            onConfirm = { name, notes ->
                showHoldDialog = false
                viewModel.holdCurrentCart(name, notes)
            },
        )
    }

    if (showShiftOpen) {
        ShiftOpenDialog(
            onDismiss = { showShiftOpen = false },
            onOpened = { showShiftOpen = false },
        )
    }
    if (showShiftClose) {
        ShiftCloseDialog(
            onDismiss = { showShiftClose = false },
            onClosed = { showShiftClose = false },
        )
    }
    if (showComboPicker) {
        ComboPickerDialog(onDismiss = { showComboPicker = false })
    }
}

@Composable
private fun MenuArea(
    ui: TerminalUiState,
    onSearch: (String) -> Unit,
    onCategory: (String?) -> Unit,
    onAdd: (ProductDto) -> Unit,
    onScanClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        OutlinedTextField(
            value = ui.search,
            onValueChange = onSearch,
            placeholder = { Text("Search menu…") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            trailingIcon = {
                IconButton(onClick = onScanClick) {
                    Icon(Icons.Default.QrCodeScanner, contentDescription = "Scan barcode")
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = ui.selectedCategoryId == null,
                onClick = { onCategory(null) },
                label = { Text("All") },
            )
            ui.categories.take(6).forEach { cat ->
                FilterChip(
                    selected = ui.selectedCategoryId == cat.id,
                    onClick = { onCategory(cat.id) },
                    label = { Text(cat.name) },
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        if (ui.loading && ui.products.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 160.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 8.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(ui.products, key = { it.id }) { p ->
                    ProductCard(product = p, onClick = { onAdd(p) })
                }
            }
        }
    }
}

@Composable
private fun ProductCard(product: ProductDto, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.heightIn(min = 110.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                product.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "K${product.salesPrice ?: "—"}",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Inventory, contentDescription = null, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(product.sku ?: product.code, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun CartPane(
    cart: CartStore.State,
    onQty: (String, Double) -> Unit,
    onRemove: (String) -> Unit,
    onClear: () -> Unit,
    onHold: () -> Unit = {},
    onCheckout: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.padding(8.dp),
        tonalElevation = 4.dp,
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Cart", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.width(8.dp))
                CountBadge(count = cart.lines.sumOf { it.quantity.toInt() })
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onClear) { Icon(Icons.Default.Clear, contentDescription = "Clear") }
            }
            if (cart.lines.isEmpty()) {
                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(
                        "Cart is empty — tap a product or scan a barcode",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(cart.lines, key = { it.lineId }) { line ->
                        CartRow(
                            line = line,
                            onPlus = { onQty(line.lineId, line.quantity + 1) },
                            onMinus = { onQty(line.lineId, line.quantity - 1) },
                            onRemove = { onRemove(line.lineId) },
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Subtotal", style = MaterialTheme.typography.bodyMedium)
                Text("K%.2f".format(cart.lines.sumOf { it.quantity * it.unitPrice * (1 - it.discountPercent / 100.0) }),
                    style = MaterialTheme.typography.bodyMedium)
            }

            Spacer(Modifier.height(8.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = onHold,
                    enabled = cart.lines.isNotEmpty(),
                    modifier = Modifier.weight(1f).height(56.dp),
                ) {
                    Icon(Icons.Default.PauseCircle, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("Hold")
                }
                Button(
                    onClick = onCheckout,
                    enabled = cart.lines.isNotEmpty(),
                    modifier = Modifier.weight(2f).height(56.dp),
                ) {
                    Icon(Icons.Default.PointOfSale, contentDescription = null)
                    Spacer(Modifier.width(4.dp))
                    Text("Checkout")
                }
            }
        }
    }
}

@Composable
private fun CartRow(
    line: CartStore.Line,
    onPlus: () -> Unit,
    onMinus: () -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(line.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("K%.2f × %s".format(line.unitPrice, line.quantity.toInt()), style = MaterialTheme.typography.bodySmall)
        }
        IconButton(onClick = onMinus) { Text("−", style = MaterialTheme.typography.titleLarge) }
        Text(line.quantity.toInt().toString(), style = MaterialTheme.typography.titleMedium)
        IconButton(onClick = onPlus) { Icon(Icons.Default.Add, contentDescription = "More") }
        IconButton(onClick = onRemove) { Icon(Icons.Default.Delete, contentDescription = "Remove") }
    }
}