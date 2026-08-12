package com.poscafe.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.ui.screens.HomeScreen
import com.poscafe.pos.ui.screens.PinLoginScreen
import com.poscafe.pos.ui.screens.SetupScreen
import com.poscafe.pos.ui.screens.SyncScreen
import com.poscafe.pos.ui.theme.PosTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var config: DeviceConfig

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PosTheme {
                Surface(
                    color = MaterialTheme.colorScheme.background,
                    modifier = Modifier.fillMaxSize().safeDrawingPadding(),
                ) {
                    val nav = rememberNavController()
                    val start = if (config.isReady) "pin" else "setup"
                    NavHost(
                        navController = nav,
                        startDestination = start,
                        enterTransition = { fadeIn(tween(220)) },
                        exitTransition = { fadeOut(tween(180)) },
                        popEnterTransition = { fadeIn(tween(220)) },
                        popExitTransition = { fadeOut(tween(180)) },
                    ) {
                        composable("setup") {
                            SetupScreen(onDone = { nav.navigate("pin") { popUpTo("setup") { inclusive = true } } })
                        }
                        composable("pin") {
                            PinLoginScreen(onLoggedIn = { nav.navigate("home") { popUpTo("pin") { inclusive = true } } })
                        }
                        composable("home") {
                            HomeScreen(
                                onOpenSync = { nav.navigate("sync") },
                                onLock = { nav.navigate("pin") { popUpTo("home") { inclusive = true } } },
                                onNavigate = { route -> nav.navigate(route) },
                            )
                        }
                        composable("sync") { SyncScreen(onBack = { nav.popBackStack() }) }
                        composable("messaging") { com.poscafe.pos.ui.screens.messaging.MessagingScreen(onBack = { nav.popBackStack() }) }
                        composable("menu-manager") { com.poscafe.pos.ui.screens.manage.MenuManagerScreen(onBack = { nav.popBackStack() }) }
                        composable("products") { com.poscafe.pos.ui.screens.manage.ProductsScreen(onBack = { nav.popBackStack() }) }
                        composable("taxes") { com.poscafe.pos.ui.screens.manage.TaxesScreen(onBack = { nav.popBackStack() }) }
                        composable("modifier-groups") { com.poscafe.pos.ui.screens.manage.ModifierGroupsScreen(onBack = { nav.popBackStack() }) }
                        composable("accompaniment-groups") { com.poscafe.pos.ui.screens.manage.AccompanimentGroupsScreen(onBack = { nav.popBackStack() }) }
                        composable("tables-manager") { com.poscafe.pos.ui.screens.manage.TablesManagerScreen(onBack = { nav.popBackStack() }) }
                        composable("registers") { com.poscafe.pos.ui.screens.manage.RegistersScreen(onBack = { nav.popBackStack() }) }
                        composable("shift-history") { com.poscafe.pos.ui.screens.manage.ShiftHistoryScreen(onBack = { nav.popBackStack() }) }
                        composable("customers") { com.poscafe.pos.ui.screens.manage.CustomersScreen(onBack = { nav.popBackStack() }) }
                        composable("suppliers") { com.poscafe.pos.ui.screens.manage.SuppliersScreen(onBack = { nav.popBackStack() }) }
                        composable("stock") { com.poscafe.pos.ui.screens.manage.StockScreen(onBack = { nav.popBackStack() }) }
                        composable("inventory-count") { com.poscafe.pos.ui.screens.manage.InventoryCountScreen(onBack = { nav.popBackStack() }) }
                        composable("purchases") { com.poscafe.pos.ui.screens.manage.PurchasesScreen(onBack = { nav.popBackStack() }) }
                        composable("expenses") { com.poscafe.pos.ui.screens.manage.ExpensesScreen(onBack = { nav.popBackStack() }) }
                        composable("staff") { com.poscafe.pos.ui.screens.manage.StaffScreen(onBack = { nav.popBackStack() }) }
                        composable("reports") { com.poscafe.pos.ui.screens.ReportsScreen(onBack = { nav.popBackStack() }) }
                        composable("business") { com.poscafe.pos.ui.screens.manage.BusinessSettingsScreen(onBack = { nav.popBackStack() }) }
                    }
                }
            }
        }
    }
}
