package com.cafe.pos.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.cafe.pos.ui.screens.checkout.CheckoutScreen
import com.cafe.pos.ui.screens.holds.HoldsScreen
import com.cafe.pos.ui.screens.kds.KdsScreen
import com.cafe.pos.ui.screens.login.LoginMfaScreen
import com.cafe.pos.ui.screens.login.LoginScreen
import com.cafe.pos.ui.screens.receipts.ReceiptScreen
import com.cafe.pos.ui.screens.reports.ReportsScreen
import com.cafe.pos.ui.screens.settings.SettingsScreen
import com.cafe.pos.ui.screens.terminal.TerminalScreen

/**
 * Top-level navigation host. Decides login vs main flow from the auth state.
 *
 * On screens wider than 840dp (tablets in landscape) the terminal + cart are
 * laid out side-by-side as a master-detail pane rather than two pages.
 */
@Composable
fun CafePosNavHost(
    navController: NavHostController = rememberNavController(),
    rootViewModel: RootViewModel = hiltViewModel(),
) {
    val accessToken by rootViewModel.accessToken.collectAsState()
    val isLoggedIn = accessToken != null

    NavHost(
        navController = navController,
        startDestination = if (isLoggedIn) Routes.TERMINAL else Routes.LOGIN,
    ) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoggedIn = {
                    rootViewModel.refreshShiftSession()
                    navController.navigate(Routes.TERMINAL) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
                onMfaRequired = { navController.navigate(Routes.LOGIN_MFA) },
            )
        }
        composable(Routes.LOGIN_MFA) {
            LoginMfaScreen(onVerified = {
                navController.navigate(Routes.TERMINAL) {
                    popUpTo(Routes.LOGIN) { inclusive = true }
                }
            })
        }
        composable(Routes.TERMINAL) {
            TerminalScreen(
                onCheckout = { navController.navigate(Routes.CHECKOUT) },
                onHolds = { navController.navigate(Routes.HOLDS) },
                onKds = { navController.navigate(Routes.KDS) },
                onReports = { navController.navigate(Routes.REPORTS) },
                onSettings = { navController.navigate(Routes.SETTINGS) },
                onLogout = {
                    rootViewModel.logout()
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.TERMINAL) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.CHECKOUT) {
            CheckoutScreen(
                onDone = { invoiceId ->
                    navController.navigate(Routes.receipt(invoiceId)) {
                        popUpTo(Routes.TERMINAL)
                    }
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.HOLDS) { HoldsScreen(onBack = { navController.popBackStack() }) }
        composable(Routes.KDS) { KdsScreen(onBack = { navController.popBackStack() }) }
        composable(Routes.REPORTS) { ReportsScreen(onBack = { navController.popBackStack() }) }
        composable(
            Routes.RECEIPTS,
            arguments = listOf(navArgument("invoiceId") { type = NavType.StringType }),
        ) { backStackEntry ->
            val id = backStackEntry.arguments?.getString("invoiceId") ?: return@composable
            ReceiptScreen(invoiceId = id, onBack = { navController.popBackStack() })
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(onBack = { navController.popBackStack() })
        }
    }
}

/**
 * Convenience for screens that want to know if they're on a tablet.
 * Tablets (sw >= 840dp) use master-detail layouts.
 */
@Composable
fun rememberIsTablet(): Boolean {
    val cfg = LocalConfiguration.current
    return cfg.smallestScreenWidthDp >= 600 || cfg.screenWidthDp >= 840
}