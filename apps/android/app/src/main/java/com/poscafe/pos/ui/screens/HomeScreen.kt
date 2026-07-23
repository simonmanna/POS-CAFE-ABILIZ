package com.poscafe.pos.ui.screens

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.TableRestaurant
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.launch

private enum class HomeTab(
    val label: String,
    val icon: ImageVector,
    val selectedIcon: ImageVector,
) {
    Sell("Sell", Icons.Outlined.Storefront, Icons.Filled.Storefront),
    Tables("Tables", Icons.Outlined.TableRestaurant, Icons.Filled.TableRestaurant),
    Orders("Orders", Icons.Outlined.ReceiptLong, Icons.Filled.ReceiptLong),
    More("More", Icons.Outlined.MoreHoriz, Icons.Filled.MoreHoriz),
}

/**
 * Post-login shell: bottom tabs (phone) / rail (tablet) for the four
 * service-speed surfaces, plus a side drawer for back-office management —
 * products, customers, suppliers, stock, reports, staff, settings.
 */
@Composable
fun HomeScreen(onOpenSync: () -> Unit, onLock: () -> Unit, onNavigate: (String) -> Unit) {
    var tab by rememberSaveable { mutableStateOf(HomeTab.Sell) }
    val terminalVm: TerminalViewModel = hiltViewModel()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val standalone = terminalVm.config.standalone
    val isRetail by terminalVm.isRetailMode.collectAsStateWithLifecycle()

    // Retail has no dine-in tables; drop the tab and bail out of it if the
    // mode flips (or the state restores) while Tables is selected.
    val visibleTabs = if (isRetail) HomeTab.entries.filter { it != HomeTab.Tables } else HomeTab.entries
    LaunchedEffect(isRetail) {
        if (isRetail && tab == HomeTab.Tables) tab = HomeTab.Sell
    }

    val openDrawer: () -> Unit = { scope.launch { drawerState.open() } }
    val navigateFromDrawer: (String) -> Unit = { route ->
        scope.launch { drawerState.close() }
        onNavigate(route)
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            DrawerContent(
                businessName = terminalVm.config.businessName,
                cashierName = terminalVm.cashier?.displayName ?: "",
                standalone = standalone,
                onNavigate = navigateFromDrawer,
            )
        },
    ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val useRail = maxWidth >= 840.dp
            if (useRail) {
                Row(Modifier.fillMaxSize()) {
                    NavigationRail(containerColor = MaterialTheme.colorScheme.surface) {
                        visibleTabs.forEach { t ->
                            NavigationRailItem(
                                selected = tab == t,
                                onClick = { tab = t },
                                icon = { Icon(if (tab == t) t.selectedIcon else t.icon, t.label) },
                                label = { Text(t.label, style = MaterialTheme.typography.labelMedium) },
                                colors = NavigationRailItemDefaults.colors(
                                    selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                ),
                            )
                        }
                    }
                    TabContent(tab, terminalVm, onOpenSync, onLock, openDrawer, Modifier.fillMaxSize(), onGoSell = { tab = HomeTab.Sell })
                }
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    bottomBar = {
                        NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                            visibleTabs.forEach { t ->
                                NavigationBarItem(
                                    selected = tab == t,
                                    onClick = { tab = t },
                                    icon = { Icon(if (tab == t) t.selectedIcon else t.icon, t.label) },
                                    label = { Text(t.label, style = MaterialTheme.typography.labelMedium) },
                                    colors = NavigationBarItemDefaults.colors(
                                        selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                                        indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                    ),
                                )
                            }
                        }
                    },
                ) { padding ->
                    TabContent(
                        tab, terminalVm, onOpenSync, onLock, openDrawer,
                        Modifier.fillMaxSize().padding(padding),
                        onGoSell = { tab = HomeTab.Sell },
                    )
                }
            }
        }
    }
}

@Composable
private fun DrawerContent(
    businessName: String,
    cashierName: String,
    standalone: Boolean,
    onNavigate: (String) -> Unit,
) {
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            // Brand header
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(44.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Outlined.Storefront, null,
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(22.dp),
                    )
                }
                Spacer(Modifier.size(12.dp))
                Column {
                    Text(businessName, style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (standalone) "Standalone · $cashierName" else cashierName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Spacer(Modifier.height(8.dp))

            DrawerSection("Catalog")
            DrawerItem("Menu & products", Icons.Outlined.RestaurantMenu) { onNavigate("menu-manager") }
            DrawerItem("Stock levels & inventory", Icons.Outlined.Inventory2) { onNavigate("stock") }

            DrawerSection("Finance")
            DrawerItem("Purchases", Icons.Outlined.ShoppingCart) { onNavigate("purchases") }
            DrawerItem("Expenses", Icons.Outlined.Payments) { onNavigate("expenses") }

            DrawerSection("People")
            DrawerItem("Customers", Icons.Outlined.People) { onNavigate("customers") }
            DrawerItem("Suppliers", Icons.Outlined.LocalShipping) { onNavigate("suppliers") }
            DrawerItem("Staff & PINs", Icons.Outlined.Badge) { onNavigate("staff") }

            DrawerSection("Insights")
            DrawerItem("Reports", Icons.AutoMirrored.Outlined.TrendingUp) { onNavigate("reports") }

            DrawerSection("Device")
            DrawerItem("Business settings", Icons.Outlined.Settings) { onNavigate("business") }
            if (!standalone) {
                DrawerItem("Sync", Icons.Outlined.CloudSync) { onNavigate("sync") }
            }
        }
    }
}

@Composable
private fun DrawerSection(label: String) {
    Text(
        label.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 24.dp, top = 14.dp, bottom = 4.dp),
    )
}

@Composable
private fun DrawerItem(label: String, icon: ImageVector, onClick: () -> Unit) {
    NavigationDrawerItem(
        label = { Text(label, style = MaterialTheme.typography.bodyLarge) },
        icon = { Icon(icon, null) },
        selected = false,
        onClick = onClick,
        colors = NavigationDrawerItemDefaults.colors(
            unselectedContainerColor = MaterialTheme.colorScheme.surface,
        ),
        modifier = Modifier.padding(horizontal = 12.dp),
    )
}

@Composable
private fun TabContent(
    tab: HomeTab,
    terminalVm: TerminalViewModel,
    onOpenSync: () -> Unit,
    onLock: () -> Unit,
    onMenu: () -> Unit,
    modifier: Modifier = Modifier,
    onGoSell: () -> Unit,
) {
    Crossfade(targetState = tab, animationSpec = tween(200), label = "homeTab", modifier = modifier) { t ->
        Column(Modifier.fillMaxSize()) {
            when (t) {
                HomeTab.Sell -> TerminalScreen(terminalVm, onMenu = onMenu)
                HomeTab.Tables -> TablesScreen(terminalVm, onTableChosen = onGoSell, onMenu = onMenu)
                HomeTab.Orders -> OrdersScreen(onMenu = onMenu)
                HomeTab.More -> MoreScreen(onOpenSync = onOpenSync, onLock = onLock, onMenu = onMenu)
            }
        }
    }
}
